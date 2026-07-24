import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "../src/lsp-client.js";

async function packageVersion(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error(`Missing package version in ${path}.`);
  return value.version;
}

async function processExited(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

type ProcessRelation = { pid: number; parentPid: number };

async function processRelations(): Promise<ProcessRelation[]> {
  const command =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "{0},{1}" -f $_.ProcessId,$_.ParentProcessId }',
        ]
      : ["ps", "-e", "-o", "pid=,ppid="];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not inspect the process tree: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .split(/[\s,]+/u)
        .map(Number),
    )
    .filter(
      (entry): entry is [number, number] => entry.length === 2 && entry.every(Number.isSafeInteger),
    )
    .map(([pid, parentPid]) => ({ pid, parentPid }));
}

async function descendantProcessIds(rootPid: number): Promise<number[]> {
  const relations = await processRelations();
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (relation.parentPid !== rootPid && !descendants.has(relation.parentPid)) continue;
      if (descendants.has(relation.pid)) continue;
      descendants.add(relation.pid);
      changed = true;
    }
  }
  return [...descendants];
}

test("manager-facing TypeScript LSP proves clean, error, clear, and process exit", async () => {
  const root = join(import.meta.dir, "..");
  const tsserver = join(root, "node_modules", "@typescript", "old", "lib", "tsserver.js");
  expect(await packageVersion(join(root, "node_modules", "typescript", "package.json"))).toBe(
    "7.0.2",
  );
  expect(
    await packageVersion(join(root, "node_modules", "@typescript", "old", "package.json")),
  ).toBe("6.0.3");
  await expect(readFile(tsserver)).resolves.toBeInstanceOf(Buffer);

  const unhandled: unknown[] = [];
  const unhandledListener = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", unhandledListener);
  let client: LspClient | undefined;
  let pid: number | undefined;
  let descendants: number[] = [];
  try {
    client = await LspClient.start({
      serverId: "typescript",
      command: [process.execPath, "x", "--no-install", "typescript-language-server", "--stdio"],
      rootPath: root,
      env: {},
      initialization: { tsserver: { path: "./node_modules/@typescript/old/lib/tsserver.js" } },
      startupTimeoutMs: 15_000,
      diagnosticsTimeoutMs: 5_000,
    });
    const startedPid = client.processId;
    if (startedPid === undefined) throw new Error("The real language server has no process ID.");
    pid = startedPid;

    const managerPath = join(root, "src", "lsp-manager.ts");
    const managerUri = pathToFileURL(managerPath).href;
    const managerText = await readFile(managerPath, "utf8");
    await expect(
      client.warm({ uri: managerUri, languageId: "typescript", text: managerText }),
    ).resolves.toMatchObject({ status: "synchronized" });

    const smokeUri = pathToFileURL(join(root, "src", "__better_hashline_lsp_smoke__.ts")).href;
    const cleanText = 'export const clean: string = "ok";\n';
    const firstClean = await client.diagnose(
      { uri: smokeUri, languageId: "typescript", text: cleanText },
      "create",
    );
    expect(firstClean).toMatchObject({
      status: "ok",
      source: "push",
      diagnostics: [],
      versioned: false,
    });

    const erroneous = await client.diagnose(
      {
        uri: smokeUri,
        languageId: "typescript",
        text: "export const broken: string = 1;\nconst = ;\n",
      },
      "change",
    );
    if (erroneous.status !== "ok") {
      throw new Error(`Expected diagnostics, received ${erroneous.code}.`);
    }
    expect(erroneous.versioned).toBe(false);
    expect(erroneous.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        "Variable declaration expected.",
        "Type 'number' is not assignable to type 'string'.",
      ]),
    );

    const cleared = await client.diagnose(
      { uri: smokeUri, languageId: "typescript", text: cleanText },
      "change",
    );
    expect(cleared).toMatchObject({
      status: "ok",
      source: "push",
      diagnostics: [],
      versioned: false,
    });

    const cleanAfterWarm = await client.diagnose(
      { uri: managerUri, languageId: "typescript", text: managerText },
      "change",
    );
    expect(cleanAfterWarm).toMatchObject({
      status: "ok",
      source: "push",
      diagnostics: [],
      versioned: false,
    });

    descendants = await descendantProcessIds(startedPid);
    expect(descendants.length).toBeGreaterThan(0);
  } finally {
    await client?.dispose();
    process.off("unhandledRejection", unhandledListener);
  }

  expect(unhandled).toEqual([]);
  if (pid === undefined) throw new Error("The real language server did not expose a process ID.");
  expect(
    await Promise.all([pid, ...descendants].map((processId) => processExited(processId))),
  ).toEqual([pid, ...descendants].map(() => true));
  expect(await descendantProcessIds(pid)).toEqual([]);
}, 60_000);
