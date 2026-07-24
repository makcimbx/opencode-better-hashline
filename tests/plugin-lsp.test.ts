import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import { betterHashlinePlugin } from "../src/plugin.js";

type StructuredResult = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

type FakeEvent = Record<string, unknown> & {
  event: string;
  pid: number;
  serverId: string;
};

type LspConfigOverrides = Partial<{
  startupTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
}>;

const fakeServer = join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
let root = "";
let values: Hooks[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-plugin-lsp-")));
  values = [];
});

afterEach(async () => {
  await Promise.allSettled(values.map(async (value) => value.dispose?.()));
  await rm(root, { recursive: true, force: true });
});

function context(
  input: {
    sessionID?: string;
    metadata?: Array<Record<string, unknown>>;
    asks?: Array<Record<string, unknown>>;
    directory?: string;
    worktree?: string;
  } = {},
): ToolContext {
  return {
    sessionID: input.sessionID ?? "session",
    messageID: "message",
    agent: "build",
    directory: input.directory ?? root,
    worktree: input.worktree ?? root,
    abort: new AbortController().signal,
    metadata(value) {
      input.metadata?.push(value as Record<string, unknown>);
    },
    async ask(request) {
      input.asks?.push(request as Record<string, unknown>);
    },
  } as ToolContext;
}

function structured(result: unknown): StructuredResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("output" in result) ||
    typeof result.output !== "string"
  ) {
    throw new Error("Expected a structured tool result");
  }
  return {
    title: "title" in result && typeof result.title === "string" ? result.title : "",
    output: result.output,
    metadata:
      "metadata" in result && result.metadata ? (result.metadata as Record<string, unknown>) : {},
  };
}

function registry(value: Hooks) {
  const hashlineRead = value.tool?.hashline_read;
  const hashlineEdit = value.tool?.hashline_edit;
  const hashlineWrite = value.tool?.hashline_write;
  if (!hashlineRead || !hashlineEdit || !hashlineWrite) {
    throw new Error("Plugin tool registry is incomplete");
  }
  return { hashlineRead, hashlineEdit, hashlineWrite };
}

async function deliver(
  value: Hooks,
  tool: string,
  result: StructuredResult,
  toolContext: ToolContext,
  args: Record<string, unknown>,
): Promise<void> {
  const after = value["tool.execute.after"];
  if (!after) throw new Error("Plugin did not register its after hook");
  await after(
    {
      tool,
      sessionID: toolContext.sessionID,
      callID: `call-${randomUUID()}`,
      args,
    },
    result,
  );
}

async function issueSnapshot(
  value: Hooks,
  toolContext: ToolContext,
  filePath: string,
): Promise<StructuredResult> {
  const { hashlineRead } = registry(value);
  const result = structured(await hashlineRead.execute({ filePath }, toolContext));
  await deliver(value, "hashline_read", result, toolContext, { filePath });
  return result;
}

function lspConfig(
  mode: string,
  log: string,
  overrides: LspConfigOverrides = {},
  serverEnv: Record<string, string> = {},
) {
  return {
    servers: [
      {
        id: "typescript",
        command: [process.execPath, fakeServer],
        extensions: [".ts"],
        rootMarkers: [],
        env: {
          FAKE_LSP_MODE: mode,
          FAKE_LSP_LOG: log,
          FAKE_LSP_SERVER_ID: "typescript",
          ...serverEnv,
        },
      },
    ],
    startupTimeoutMs: overrides.startupTimeoutMs ?? 2_000,
    diagnosticsTimeoutMs: overrides.diagnosticsTimeoutMs ?? 400,
    maxDiagnostics: overrides.maxDiagnostics ?? 20,
    maxDiagnosticsBytes: overrides.maxDiagnosticsBytes ?? 8_192,
  };
}

async function lspHooks(
  mode: string,
  input: {
    config?: LspConfigOverrides;
    options?: Record<string, unknown>;
    serverEnv?: Record<string, string>;
    name?: string;
  } = {},
): Promise<{ value: Hooks; log: string }> {
  const log = join(root, `${input.name ?? mode}-${randomUUID()}.jsonl`);
  const value = await betterHashlinePlugin(
    {
      directory: root,
      worktree: root,
      client: { config: { get: async () => ({ data: {} }) } },
    } as never,
    {
      ...input.options,
      lspDiagnostics: lspConfig(mode, log, input.config, input.serverEnv),
    },
  );
  values.push(value);
  return { value, log };
}

function effectiveServer(id: string, mode: string, log: string, extensions: string[] = [".ts"]) {
  return {
    command: [process.execPath, fakeServer],
    extensions,
    env: {
      FAKE_LSP_MODE: mode,
      FAKE_LSP_LOG: log,
      FAKE_LSP_SERVER_ID: id,
    },
  };
}

async function configuredHooks(input: {
  options?: Record<string, unknown>;
  effectiveConfig?: unknown;
  captureWithHook?: boolean;
  directory?: string;
  worktree?: string;
  getConfig?: () => Promise<unknown>;
}): Promise<{ value: Hooks; configGets: () => number }> {
  let configGetCount = 0;
  const value = await betterHashlinePlugin(
    {
      directory: input.directory ?? root,
      worktree: input.worktree ?? root,
      client: {
        config: {
          get: async () => {
            configGetCount += 1;
            if (input.getConfig) return input.getConfig();
            return { data: input.effectiveConfig };
          },
        },
      },
    } as never,
    input.options,
  );
  if (input.captureWithHook) {
    await value.config?.(input.effectiveConfig as never);
  }
  values.push(value);
  return { value, configGets: () => configGetCount };
}

async function waitForFileText(file: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(file, "utf8")) === expected) return;
    } catch {}
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for '${file}' to contain expected text.`);
}

async function events(log: string): Promise<FakeEvent[]> {
  let text: string;
  try {
    text = await readFile(log, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent);
}

async function actAfterFakeEvent(
  log: string,
  event: string,
  action: () => Promise<void>,
  offset = 0,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  const iterator = watch(root, { signal: controller.signal })[Symbol.asyncIterator]();
  let nextUpdate = iterator.next();
  try {
    while (true) {
      if ((await events(log)).slice(offset).some((entry) => entry.event === event)) {
        await action();
        return;
      }
      const update = await nextUpdate;
      if (update.done) throw new Error("Fake LSP event watcher ended unexpectedly.");
      nextUpdate = iterator.next();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out waiting for fake LSP event '${event}'.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    try {
      await nextUpdate;
    } catch {}
    try {
      await iterator.return?.();
    } catch {}
  }
}

async function fakeEventOffset(log: string): Promise<number> {
  return (await events(log)).length;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to reject");
}

describe("managed LSP plugin integration", () => {
  test("keeps disabled behavior exact without accessing PluginInput", async () => {
    const accesses: string[] = [];
    const pluginInput = new Proxy(
      {},
      {
        get(_target, property) {
          accesses.push(String(property));
          throw new Error(`Unexpected PluginInput access: ${String(property)}`);
        },
      },
    );
    const value = await betterHashlinePlugin(pluginInput as never, { lspDiagnostics: false });
    values.push(value);
    expect(Object.keys(value.tool ?? {}).sort()).toEqual([
      "hashline_edit",
      "hashline_read",
      "hashline_write",
    ]);

    await writeFile(join(root, "disabled.txt"), "one\n");
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "disabled.txt");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "disabled.txt",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
    expect(accesses).toEqual([]);
  });

  test("treats manager creation failure as a fail-closed initialization error", async () => {
    const log = join(root, "creation-failure.jsonl");
    await writeFile(join(root, "missing.ts"), "missing\n");
    const pluginInput = Object.defineProperty({}, "worktree", {
      get() {
        throw new Error("worktree unavailable");
      },
    });
    const value = await betterHashlinePlugin(pluginInput as never, {
      lspDiagnostics: lspConfig("pull-full", log),
    });
    values.push(value);

    const message = await rejectionMessage(
      registry(value).hashlineRead.execute({ filePath: "missing.ts" }, context()),
    );
    expect(message).toContain("CONFIG_INVALID");
    expect(message).toContain("worktree unavailable");
    expect(await events(log)).toEqual([]);
  });

  test("fails concurrent creates before permission when shared LSP readiness rejects", async () => {
    const inside = join(root, "concurrent-create");
    const target = join(root, "created.ts");
    const seed = join(inside, "seed.ts");
    const log = join(root, "concurrent-creation-failure.jsonl");
    await mkdir(inside);
    await writeFile(seed, "seed\n");

    let markConfigStarted = () => {};
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve;
    });
    let releaseConfig = () => {};
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    let configGets = 0;
    const pluginInput = Object.defineProperty(
      {
        directory: root,
        client: {
          config: {
            get: async () => {
              configGets += 1;
              markConfigStarted();
              await configGate;
              return { data: {} };
            },
          },
        },
      },
      "worktree",
      {
        get() {
          throw new Error("concurrent worktree unavailable");
        },
      },
    );
    const value = await betterHashlinePlugin(pluginInput as never, {
      lspDiagnostics: lspConfig("pull-full", log),
    });
    values.push(value);

    let releasePermission = () => {};
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    let permissionRequests = 0;
    const createContext = {
      ...context({
        sessionID: "concurrent-create",
        directory: inside,
        worktree: inside,
      }),
      async ask() {
        permissionRequests += 1;
        await permissionGate;
      },
    } as ToolContext;
    const readContext = context({
      sessionID: "concurrent-initializer",
      directory: inside,
      worktree: inside,
    });
    const { hashlineRead, hashlineWrite } = registry(value);
    const settle = async (operation: Promise<unknown>): Promise<string> => {
      try {
        await operation;
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const createMessagePromise = settle(
      hashlineWrite.execute({ filePath: "../created.ts", content: "created\n" }, createContext),
    );
    const readMessagePromise = settle(hashlineRead.execute({ filePath: "seed.ts" }, readContext));
    await configStarted;
    releaseConfig();
    const readMessage = await readMessagePromise;
    releasePermission();
    const createMessage = await createMessagePromise;

    expect(configGets).toBe(1);
    expect(readMessage).toContain("CONFIG_INVALID");
    expect(readMessage).toContain("concurrent worktree unavailable");
    expect(createMessage).toBe(readMessage);
    expect(permissionRequests).toBe(0);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(seed, "utf8")).toBe("seed\n");
    expect(await events(log)).toEqual([]);
  });

  test("freezes default-on zero-route readiness across snapshot-bound edits", async () => {
    const file = join(root, "zero-route.ts");
    const lateLog = join(root, "zero-route-late.jsonl");
    await writeFile(file, "before\n");
    let configGets = 0;
    let worktreeAccesses = 0;
    const pluginInput = Object.defineProperty(
      {
        directory: root,
        client: {
          config: {
            get: async () => {
              configGets += 1;
              return { data: {} };
            },
          },
        },
      },
      "worktree",
      {
        get() {
          worktreeAccesses += 1;
          throw new Error("zero-route readiness must not initialize a manager");
        },
      },
    );
    const value = await betterHashlinePlugin(pluginInput as never);
    values.push(value);
    const toolContext = context({ sessionID: "zero-route" });
    const snapshot = await issueSnapshot(value, toolContext, "zero-route.ts");

    await value.config?.({
      lsp: { late: effectiveServer("late", "pull-full", lateLog) },
    } as never);
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "zero-route.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
    expect(await readFile(file, "utf8")).toBe("after\n");
    expect(configGets).toBe(1);
    expect(worktreeAccesses).toBe(0);
    expect(await events(lateLog)).toEqual([]);
  });

  test("warms reads and appends successful edit diagnostics", async () => {
    const file = join(root, "diagnostic.ts");
    await writeFile(file, "one\n");
    const { value, log } = await lspHooks("pull-full");
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "diagnostic.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "diagnostic.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["TWO"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toContain("@better-hashline-lsp advisory=true errors=1 truncated=false");
    expect(result.output).toContain("LSP| diagnostic.ts:1:1 [typescript] typescript:TWO\\n");
    expect(await readFile(file, "utf8")).toBe("TWO\n");
    const protocol = await events(log);
    expect(protocol.filter((entry) => entry.event === "started")).toHaveLength(1);
    expect(protocol.find((entry) => entry.event === "open")?.text).toBe("TWO\n");
    expect(protocol.some((entry) => entry.event === "change")).toBe(false);
  });

  test("keeps clean enabled output byte-identical", async () => {
    const file = join(root, "clean.ts");
    await writeFile(file, "one\n");
    const { value } = await lspHooks("push-empty");
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "clean.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "clean.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["clean"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
    expect(await readFile(file, "utf8")).toBe("clean\n");
  });

  test("reports post-commit timeout and failure without retrying mutations", async () => {
    for (const mode of ["timeout", "crash-diagnostic"]) {
      const filePath = `${mode}.ts`;
      const file = join(root, filePath);
      await writeFile(file, "before\n");
      const asks: Array<Record<string, unknown>> = [];
      const { value } = await lspHooks(mode, { name: `warning-${mode}` });
      const toolContext = context({ sessionID: `session-${mode}`, asks });
      const snapshot = await issueSnapshot(value, toolContext, filePath);
      const result = structured(
        await registry(value).hashlineEdit.execute(
          {
            filePath,
            snapshotId: String(snapshot.metadata.snapshotId),
            operations: [{ op: "replace", startLine: 1, endLine: 1, lines: [mode] }],
          },
          toolContext,
        ),
      );

      expect(result.output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE: The mutation succeeded");
      expect(result.output).toContain("Do not retry the mutation");
      if (mode === "timeout") expect(result.output).toContain("DIAGNOSTICS_TIMEOUT[typescript]");
      expect(await readFile(file, "utf8")).toBe(`${mode}\n`);
      expect(asks.filter((ask) => ask.permission === "edit")).toHaveLength(1);
    }
  });

  test("attests readback only against the final diagnostics-bearing output", async () => {
    await writeFile(join(root, "readback.ts"), "one\n");
    await writeFile(join(root, "fallback.ts"), "one\n");
    const { value } = await lspHooks("pull-full", {
      config: { maxDiagnosticsBytes: 1_024 },
      options: { maxOutputBytes: 1_024 },
    });
    const toolContext = context();

    const snapshot = await issueSnapshot(value, toolContext, "readback.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "readback.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          readback: true,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["TWO"] }],
        },
        toolContext,
      ),
    );
    const diagnosticsOffset = result.output.indexOf("@better-hashline-lsp");
    const successorOffset = result.output.indexOf("@hashline snapshot=");
    const successorId = /@hashline snapshot=(s_[^\s]+)/u.exec(result.output)?.[1];
    expect(diagnosticsOffset).toBeGreaterThan(result.output.indexOf("@hashline-edit"));
    expect(diagnosticsOffset).toBeGreaterThan(successorOffset);
    expect(successorId).toBeDefined();
    expect(typeof result.metadata.hashlinePending).toBe("string");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(2_048);

    const deliveredOutput = result.output;
    await deliver(value, "hashline_edit", result, toolContext, {});
    expect(result.output).toBe(deliveredOutput);
    expect(result.metadata.hashlinePending).toBeUndefined();
    await expect(
      registry(value).hashlineEdit.execute(
        {
          filePath: "readback.ts",
          snapshotId: successorId,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["THREE"] }],
        },
        toolContext,
      ),
    ).resolves.toBeDefined();

    const fallbackSnapshot = await issueSnapshot(value, toolContext, "fallback.ts");
    const fallback = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "fallback.ts",
          snapshotId: String(fallbackSnapshot.metadata.snapshotId),
          readback: true,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        toolContext,
      ),
    );
    fallback.output += "\ntampered";
    await deliver(value, "hashline_edit", fallback, toolContext, {});
    expect(fallback.output).toContain("successor=unavailable next=hashline_read");
    expect(fallback.output).toContain("@better-hashline-lsp advisory=true errors=1");
    expect(fallback.output).not.toContain("@hashline snapshot=");
    expect(Buffer.byteLength(fallback.output, "utf8")).toBeLessThanOrEqual(2_048);
  });

  test("suppresses diagnostics and invalidates readback on post-publication drift", async () => {
    const file = join(root, "drift.ts");
    await writeFile(file, "before\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 1_000 },
    });
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "drift.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    const drift = actAfterFakeEvent(
      log,
      "diagnostic",
      async () => {
        await writeFile(file, "external\n");
      },
      diagnosticOffset,
    );
    const pending = registry(value).hashlineEdit.execute(
      {
        filePath: "drift.ts",
        snapshotId: String(snapshot.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["published"] }],
      },
      toolContext,
    );

    await drift;
    const result = structured(await pending);
    expect(result.output).toContain(
      "diagnostics were suppressed because the target changed again after publication",
    );
    expect(result.output).toContain("successor=unavailable next=hashline_read");
    expect(result.output).not.toContain("@better-hashline-lsp advisory=true errors=");
    expect(result.output).not.toContain("@hashline snapshot=");
    expect(result.metadata.hashlinePending).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("external\n");
  });

  test("suppresses diagnostics after a same-byte inode replacement", async () => {
    const file = join(root, "same-byte-drift.ts");
    const replacement = join(root, "same-byte-replacement.tmp");
    await writeFile(file, "before\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 1_000 },
    });
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "same-byte-drift.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    let identityObservable = false;
    const drift = actAfterFakeEvent(
      log,
      "diagnostic",
      async () => {
        const committedStats = await stat(file);
        await writeFile(replacement, "published\n");
        const replacementStats = await stat(replacement);
        identityObservable =
          committedStats.dev !== replacementStats.dev ||
          committedStats.ino !== replacementStats.ino;
        await rm(file);
        await rename(replacement, file);
      },
      diagnosticOffset,
    );
    const pending = registry(value).hashlineEdit.execute(
      {
        filePath: "same-byte-drift.ts",
        snapshotId: String(snapshot.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["published"] }],
      },
      toolContext,
    );

    await drift;
    const result = structured(await pending);
    if (identityObservable) {
      expect(result.output).toContain(
        "diagnostics were suppressed because the target changed again after publication",
      );
      expect(result.output).toContain("successor=unavailable next=hashline_read");
      expect(result.output).not.toContain("@hashline snapshot=");
    }
    expect(await readFile(file, "utf8")).toBe("published\n");
  });

  test("suppresses diagnostics when the committed target gains another link", async () => {
    const file = join(root, "nlink-drift.ts");
    const alias = join(root, "nlink-drift-alias.ts");
    await writeFile(file, "before\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 1_000 },
    });
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "nlink-drift.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    let linkCountObservable = false;
    const drift = actAfterFakeEvent(
      log,
      "diagnostic",
      async () => {
        try {
          await link(file, alias);
          linkCountObservable = (await stat(file)).nlink > 1;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error ? String(error.code) : "";
          if (!["EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(code)) throw error;
        }
      },
      diagnosticOffset,
    );
    const pending = registry(value).hashlineEdit.execute(
      {
        filePath: "nlink-drift.ts",
        snapshotId: String(snapshot.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["published"] }],
      },
      toolContext,
    );

    await drift;
    const result = structured(await pending);
    if (linkCountObservable) {
      expect(result.output).toContain(
        "diagnostics were suppressed because the target changed again after publication",
      );
      expect(result.output).toContain("successor=unavailable next=hashline_read");
    }
    expect(await readFile(file, "utf8")).toBe("published\n");
  });

  test("detects source recreation in the coherent final move gate", async () => {
    const source = join(root, "move-drift.ts");
    const destination = join(root, "moved-drift.ts");
    await writeFile(source, "move\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 1_000 },
    });
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "move-drift.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    const recreate = actAfterFakeEvent(
      log,
      "diagnostic",
      () => writeFile(source, "move\n"),
      diagnosticOffset,
    );
    const pending = registry(value).hashlineEdit.execute(
      {
        filePath: "move-drift.ts",
        snapshotId: String(snapshot.metadata.snapshotId),
        operations: [{ op: "move_file", destinationPath: "moved-drift.ts" }],
      },
      toolContext,
    );

    await recreate;
    const result = structured(await pending);
    expect(result.output).toContain(
      "diagnostics were suppressed because the target changed again after publication",
    );
    expect(await readFile(source, "utf8")).toBe("move\n");
    expect(await readFile(destination, "utf8")).toBe("move\n");
  });

  test("checks newly created files after publication", async () => {
    const metadata: Array<Record<string, unknown>> = [];
    const { value, log } = await lspHooks("pull-full", {
      config: { diagnosticsTimeoutMs: 1_000 },
    });
    const result = structured(
      await registry(value).hashlineWrite.execute(
        { filePath: "created.ts", content: "created\n" },
        context({ metadata }),
      ),
    );

    expect(result.output).toContain("Created the file");
    expect(result.output).toContain("LSP| created.ts:1:1 [typescript] typescript:created\\n");
    expect(await readFile(join(root, "created.ts"), "utf8")).toBe("created\n");
    expect((await events(log)).find((entry) => entry.event === "open")?.text).toBe("created\n");
    expect(metadata).toHaveLength(1);
  });

  test("notifies delete and move lifecycle after publication", async () => {
    const deleteFile = join(root, "delete.ts");
    await writeFile(deleteFile, "before\n");
    const deletePlugin = await lspHooks("pull-full", {
      config: { diagnosticsTimeoutMs: 1_000 },
      name: "delete-lifecycle",
    });
    const deleteContext = context({ sessionID: "delete-session" });
    const deleteBindingSnapshot = await issueSnapshot(
      deletePlugin.value,
      deleteContext,
      "delete.ts",
    );
    await registry(deletePlugin.value).hashlineEdit.execute(
      {
        filePath: "delete.ts",
        snapshotId: String(deleteBindingSnapshot.metadata.snapshotId),
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["delete"] }],
      },
      deleteContext,
    );
    const deleteSnapshot = await issueSnapshot(deletePlugin.value, deleteContext, "delete.ts");
    const deleteEventOffset = await fakeEventOffset(deletePlugin.log);
    const deleted = structured(
      await registry(deletePlugin.value).hashlineEdit.execute(
        {
          filePath: "delete.ts",
          snapshotId: String(deleteSnapshot.metadata.snapshotId),
          operations: [{ op: "delete_file" }],
        },
        deleteContext,
      ),
    );
    await actAfterFakeEvent(deletePlugin.log, "close", () => Promise.resolve(), deleteEventOffset);
    expect(deleted.output).not.toContain("@better-hashline-lsp");
    expect(deleted.output).not.toContain("LSP_DIAGNOSTICS_UNAVAILABLE");
    await expect(readFile(deleteFile, "utf8")).rejects.toThrow();
    const deleteEvents = await events(deletePlugin.log);
    expect(deleteEvents.at(-1)?.event).toBe("close");

    const moveFile = join(root, "move.ts");
    await writeFile(moveFile, "before\n");
    const movePlugin = await lspHooks("pull-full", {
      config: { diagnosticsTimeoutMs: 1_000 },
      name: "move-lifecycle",
    });
    const moveContext = context({ sessionID: "move-session" });
    const moveBindingSnapshot = await issueSnapshot(movePlugin.value, moveContext, "move.ts");
    await registry(movePlugin.value).hashlineEdit.execute(
      {
        filePath: "move.ts",
        snapshotId: String(moveBindingSnapshot.metadata.snapshotId),
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["move"] }],
      },
      moveContext,
    );
    const moveSnapshot = await issueSnapshot(movePlugin.value, moveContext, "move.ts");
    const moveEventOffset = await fakeEventOffset(movePlugin.log);
    const moved = structured(
      await registry(movePlugin.value).hashlineEdit.execute(
        {
          filePath: "move.ts",
          snapshotId: String(moveSnapshot.metadata.snapshotId),
          operations: [{ op: "move_file", destinationPath: "moved.ts" }],
        },
        moveContext,
      ),
    );
    await actAfterFakeEvent(movePlugin.log, "open", () => Promise.resolve(), moveEventOffset);
    expect(moved.output).toContain("LSP| moved.ts:1:1 [typescript] typescript:move\\n");
    expect(await readFile(join(root, "moved.ts"), "utf8")).toBe("move\n");
    const moveEvents = await events(movePlugin.log);
    expect(moveEvents.slice(-3).map((entry) => entry.event)).toEqual([
      "close",
      "open",
      "diagnostic",
    ]);
  });

  test("keeps native-alias diagnostics metadata empty", async () => {
    const log = join(root, "native-alias.jsonl");
    const host = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/global/health") {
          return Response.json({ healthy: true, version: "1.18.4" });
        }
        return Response.json([]);
      },
    });
    let value: Hooks;
    try {
      value = await betterHashlinePlugin(
        {
          serverUrl: host.url,
          directory: root,
          worktree: root,
          client: {
            _client: {
              getConfig() {
                return { baseUrl: host.url.href, fetch };
              },
            },
          },
        } as never,
        {
          enforce: true,
          toolSurface: "native-aliases",
          lspDiagnostics: lspConfig("pull-full", log),
        },
      );
    } catch (error) {
      host.stop(true);
      throw error;
    }
    const dispose = value.dispose;
    value.dispose = async () => {
      try {
        await dispose?.();
      } finally {
        host.stop(true);
      }
    };
    values.push(value);

    const hashlineRead = value.tool?.hashline_read;
    const edit = value.tool?.edit;
    if (!hashlineRead || !edit) throw new Error("Native alias registry is incomplete");
    await writeFile(join(root, "alias.ts"), "one\n");
    const metadata: Array<Record<string, unknown>> = [];
    const toolContext = context({ sessionID: "alias-session", metadata });
    const snapshot = structured(await hashlineRead.execute({ filePath: "alias.ts" }, toolContext));
    await deliver(value, "hashline_read", snapshot, toolContext, { filePath: "alias.ts" });
    const result = structured(
      await edit.execute(
        {
          filePath: "alias.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["TWO"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toContain("@better-hashline-lsp advisory=true errors=1");
    expect(result.metadata.diagnostics).toEqual({});
    expect((metadata.at(-1)?.metadata as Record<string, unknown> | undefined)?.diagnostics).toEqual(
      {},
    );
  });

  test("disposes the persistent manager and fake server", async () => {
    const { value, log } = await lspHooks("pull-full", { name: "dispose" });
    await registry(value).hashlineWrite.execute(
      { filePath: "dispose.ts", content: "dispose\n" },
      context(),
    );

    await value.dispose?.();
    const protocol = await events(log);
    expect(protocol.filter((entry) => entry.event === "started")).toHaveLength(1);
    expect(
      protocol
        .filter((entry) => entry.event === "shutdown" || entry.event === "exit")
        .map((entry) => entry.event),
    ).toEqual(["shutdown", "exit"]);
  });

  test("captures effective config and lets deterministic plugin overrides win", async () => {
    const importedLog = join(root, "config-imported.jsonl");
    const hostOverrideLog = join(root, "config-host-override.jsonl");
    const pluginOverrideLog = join(root, "config-plugin-override.jsonl");
    const skippedLog = join(root, "config-skipped.jsonl");
    const pluginConfig = lspConfig("pull-full", pluginOverrideLog);
    const [pluginServer] = pluginConfig.servers;
    if (!pluginServer) throw new Error("Expected a plugin-managed LSP server fixture.");
    pluginConfig.servers[0] = {
      ...pluginServer,
      id: "shared",
      env: {
        ...pluginServer.env,
        FAKE_LSP_SERVER_ID: "shared",
      },
    };
    const { value, configGets } = await configuredHooks({
      options: { lspDiagnostics: pluginConfig },
      effectiveConfig: {
        lsp: {
          imported: effectiveServer("imported", "pull-full", importedLog),
          shared: effectiveServer("host-shared", "pull-full", hostOverrideLog),
          disabled: {
            ...effectiveServer("disabled", "pull-full", skippedLog),
            disabled: true,
          },
          builtin: true,
          falseBuiltin: false,
          $private: effectiveServer("private", "pull-full", skippedLog),
          unrouted: { command: [process.execPath, fakeServer] },
        },
      },
      captureWithHook: true,
    });
    await writeFile(join(root, "config.ts"), "before\n");
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "config.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "config.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toContain("[imported] imported:after\\n");
    expect(result.output).toContain("[shared] shared:after\\n");
    expect(result.output.indexOf("[imported]")).toBeLessThan(result.output.indexOf("[shared]"));
    expect(configGets()).toBe(0);
    expect((await events(importedLog)).filter((entry) => entry.event === "started")).toHaveLength(
      1,
    );
    expect(
      (await events(pluginOverrideLog)).filter((entry) => entry.event === "started"),
    ).toHaveLength(1);
    expect(await events(hostOverrideLog)).toEqual([]);
    expect(await events(skippedLog)).toEqual([]);
  });

  test("freezes effective LSP configuration after lazy manager initialization", async () => {
    const initialLog = join(root, "config-frozen-initial.jsonl");
    const replacementLog = join(root, "config-frozen-replacement.jsonl");
    const { value } = await configuredHooks({
      effectiveConfig: {
        lsp: { initial: effectiveServer("initial", "pull-full", initialLog) },
      },
      captureWithHook: true,
    });
    await writeFile(join(root, "config-frozen.ts"), "before\n");
    const toolContext = context({ sessionID: "config-frozen" });
    const firstSnapshot = await issueSnapshot(value, toolContext, "config-frozen.ts");
    const first = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "config-frozen.ts",
          snapshotId: String(firstSnapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["first"] }],
        },
        toolContext,
      ),
    );
    expect(first.output).toContain("[initial] initial:first\\n");

    await value.config?.({
      lsp: { replacement: effectiveServer("replacement", "pull-full", replacementLog) },
    } as never);
    const secondSnapshot = await issueSnapshot(value, toolContext, "config-frozen.ts");
    const second = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "config-frozen.ts",
          snapshotId: String(secondSnapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["second"] }],
        },
        toolContext,
      ),
    );

    expect(second.output).toContain("[initial] initial:second\\n");
    expect((await events(initialLog)).filter((entry) => entry.event === "started")).toHaveLength(1);
    expect(await events(replacementLog)).toEqual([]);
  });

  test("keeps no-match imported configuration byte-identical and process-free", async () => {
    const log = join(root, "config-no-match.jsonl");
    const { value } = await configuredHooks({
      effectiveConfig: {
        lsp: {
          text: effectiveServer("text", "pull-full", log, [".txt"]),
          builtin: true,
          disabled: { ...effectiveServer("disabled", "pull-full", log), disabled: true },
          missingCommand: { extensions: [".ts"] },
          missingExtensions: { command: [process.execPath, fakeServer] },
        },
        tool_output: { max_bytes: 64, max_lines: 3 },
      },
      captureWithHook: true,
    });
    await writeFile(join(root, "no-match.ts"), "before\n");
    const toolContext = context();
    const snapshot = await issueSnapshot(value, toolContext, "no-match.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "no-match.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
    await Bun.sleep(25);
    expect(await events(log)).toEqual([]);

    const readbackSnapshot = await issueSnapshot(value, toolContext, "no-match.ts");
    const readback = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "no-match.ts",
          snapshotId: String(readbackSnapshot.metadata.snapshotId),
          readback: true,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["final"] }],
        },
        toolContext,
      ),
    );
    expect(readback.output).toContain("successor=attached");
    expect(Buffer.byteLength(readback.output, "utf8")).toBeGreaterThan(64);
    expect(readback.output.split("\n").length).toBeGreaterThan(3);
    await deliver(value, "hashline_edit", readback, toolContext, {});
  });

  test("uses the bounded client config fallback without deadlocking", async () => {
    const importedLog = join(root, "fallback-imported.jsonl");
    const imported = await configuredHooks({
      effectiveConfig: {
        lsp: { imported: effectiveServer("imported", "pull-full", importedLog) },
      },
    });
    await writeFile(join(root, "fallback-imported.ts"), "before\n");
    const importedContext = context({ sessionID: "fallback-imported" });
    const importedSnapshot = await issueSnapshot(
      imported.value,
      importedContext,
      "fallback-imported.ts",
    );
    const importedResult = structured(
      await registry(imported.value).hashlineEdit.execute(
        {
          filePath: "fallback-imported.ts",
          snapshotId: String(importedSnapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        importedContext,
      ),
    );
    expect(importedResult.output).toContain("[imported] imported:after\\n");
    expect(imported.configGets()).toBe(1);

    const stalled = await configuredHooks({
      getConfig: () => new Promise<unknown>(() => {}),
    });
    await writeFile(join(root, "fallback-stalled.txt"), "before\n");
    const startedAt = Date.now();
    const stalledContext = context({ sessionID: "fallback-stalled" });
    const stalledSnapshot = await issueSnapshot(
      stalled.value,
      stalledContext,
      "fallback-stalled.txt",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_600);
    expect(stalled.configGets()).toBe(1);
    const stalledResult = structured(
      await registry(stalled.value).hashlineEdit.execute(
        {
          filePath: "fallback-stalled.txt",
          snapshotId: String(stalledSnapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        stalledContext,
      ),
    );
    expect(stalledResult.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
  });

  test("keeps a public config hook that wins while fallback is pending", async () => {
    const hookedLog = join(root, "config-hook-race.jsonl");
    const fallbackLog = join(root, "config-fallback-race.jsonl");
    let resolveFallback!: (value: unknown) => void;
    const fallback = new Promise<unknown>((resolve) => {
      resolveFallback = resolve;
    });
    const configured = await configuredHooks({ getConfig: () => fallback });
    await writeFile(join(root, "config-race.ts"), "before\n");
    const toolContext = context({ sessionID: "config-race" });
    const snapshotPromise = issueSnapshot(configured.value, toolContext, "config-race.ts");
    const deadline = Date.now() + 500;
    while (configured.configGets() === 0 && Date.now() < deadline) await Bun.sleep(1);
    expect(configured.configGets()).toBe(1);
    await configured.value.config?.({
      lsp: { hooked: effectiveServer("hooked", "pull-full", hookedLog) },
    } as never);
    resolveFallback({
      data: { lsp: { fallback: effectiveServer("fallback", "pull-full", fallbackLog) } },
    });
    const snapshot = await snapshotPromise;
    const result = structured(
      await registry(configured.value).hashlineEdit.execute(
        {
          filePath: "config-race.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
        },
        toolContext,
      ),
    );

    expect(result.output).toContain("[hooked] hooked:after\\n");
    await Bun.sleep(25);
    expect(await events(fallbackLog)).toEqual([]);
  });

  test("confines the OpenCode worktree slash sentinel to the active directory", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-lsp-sentinel-")));
    try {
      const log = join(root, "sentinel.jsonl");
      const { value } = await configuredHooks({
        worktree: "/",
        options: {
          lspDiagnostics: lspConfig("pull-full", log, { diagnosticsTimeoutMs: 1_000 }),
        },
      });
      await writeFile(join(outside, "outside.ts"), "outside\n");
      const escapePath = join(root, "escape");
      await symlink(outside, escapePath, process.platform === "win32" ? "junction" : "dir");
      const toolContext = context({ directory: root, worktree: "/" });

      await issueSnapshot(value, toolContext, join(outside, "outside.ts"));
      await issueSnapshot(value, toolContext, join(escapePath, "outside.ts"));
      await Bun.sleep(50);
      expect(await events(log)).toEqual([]);

      await writeFile(join(root, "inside.ts"), "inside\n");
      const insideSnapshot = await issueSnapshot(value, toolContext, "inside.ts");
      const insideResult = structured(
        await registry(value).hashlineEdit.execute(
          {
            filePath: "inside.ts",
            snapshotId: String(insideSnapshot.metadata.snapshotId),
            operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["INSIDE"] }],
          },
          toolContext,
        ),
      );
      expect(insideResult.output).toContain("typescript:INSIDE\\n");
      const started = (await events(log)).find((entry) => entry.event === "started");
      expect(started?.cwd).toBe(root);
      expect(
        (await events(log)).some(
          (entry) =>
            typeof entry.uri === "string" && entry.uri.includes("better-hashline-lsp-sentinel"),
        ),
      ).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("fits diagnostics in exact host byte headroom without reducing ordinary readback", async () => {
    const log = join(root, "host-bytes.jsonl");
    const { value } = await configuredHooks({
      options: {
        maxOutputBytes: 1_024,
        lspDiagnostics: lspConfig("pull-full", log, {
          diagnosticsTimeoutMs: 1_000,
          maxDiagnosticsBytes: 1_024,
        }),
      },
      effectiveConfig: { tool_output: { max_bytes: 1_400, max_lines: 2_000 } },
      captureWithHook: true,
    });
    const content = Array.from(
      { length: 60 },
      (_, index) => `line-${index}-${"x".repeat(32)}`,
    ).join("\n");
    await writeFile(join(root, "host-bytes.ts"), `${content}\n`);
    const toolContext = context({ sessionID: "host-bytes" });
    const snapshot = await issueSnapshot(value, toolContext, "host-bytes.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "host-bytes.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          readback: true,
          readbackLimit: 100,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        toolContext,
      ),
    );
    const appendixOffset = result.output.indexOf("\n@better-hashline-lsp");
    expect(appendixOffset).toBeGreaterThan(0);
    const legacyOutput = result.output.slice(0, appendixOffset);
    expect(Buffer.byteLength(legacyOutput, "utf8")).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(1_272);
    expect(legacyOutput).toContain("successor=attached");
    expect(legacyOutput).toContain("@hashline snapshot=");
  });

  test("uses exact host line headroom and trims diagnostics before legacy readback", async () => {
    const log = join(root, "host-lines.jsonl");
    const { value } = await configuredHooks({
      options: {
        maxOutputBytes: 1_024,
        lspDiagnostics: lspConfig("pull-full", log, { maxDiagnosticsBytes: 1_024 }),
      },
      effectiveConfig: { tool_output: { max_bytes: 10_000, max_lines: 8 } },
      captureWithHook: true,
    });
    await writeFile(
      join(root, "host-lines.ts"),
      `${Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n")}\n`,
    );
    const toolContext = context({ sessionID: "host-lines" });
    const snapshot = await issueSnapshot(value, toolContext, "host-lines.ts");
    const result = structured(
      await registry(value).hashlineEdit.execute(
        {
          filePath: "host-lines.ts",
          snapshotId: String(snapshot.metadata.snapshotId),
          readback: true,
          readbackLimit: 100,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        toolContext,
      ),
    );

    expect(result.output.split("\n")).toHaveLength(7);
    expect(result.output).toContain("successor=attached");
    expect(result.output).toContain("@hashline snapshot=");
    expect(result.output).not.toContain("@better-hashline-lsp");
  });

  test("reserves mandatory warning headroom for readback and long lifecycle receipts", async () => {
    const readbackLog = join(root, "host-warning-readback.jsonl");
    const readbackPlugin = await configuredHooks({
      options: {
        maxOutputBytes: 1_024,
        lspDiagnostics: lspConfig("timeout", readbackLog, {
          diagnosticsTimeoutMs: 400,
          maxDiagnosticsBytes: 1_024,
        }),
      },
      effectiveConfig: { tool_output: { max_bytes: 900, max_lines: 100 } },
      captureWithHook: true,
    });
    await writeFile(
      join(root, "host-warning.ts"),
      `${Array.from({ length: 40 }, (_, index) => `line-${index}-${"x".repeat(24)}`).join("\n")}\n`,
    );
    const readbackContext = context({ sessionID: "host-warning" });
    const readbackSnapshot = await issueSnapshot(
      readbackPlugin.value,
      readbackContext,
      "host-warning.ts",
    );
    const readbackResult = structured(
      await registry(readbackPlugin.value).hashlineEdit.execute(
        {
          filePath: "host-warning.ts",
          snapshotId: String(readbackSnapshot.metadata.snapshotId),
          readback: true,
          readbackLimit: 100,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        readbackContext,
      ),
    );
    expect(readbackResult.output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE");
    expect(readbackResult.output).toContain("Do not retry the mutation");
    expect(readbackResult.output).toContain("successor=attached");
    expect(Buffer.byteLength(readbackResult.output, "utf8")).toBeLessThanOrEqual(772);
    const warningOffset = readbackResult.output.indexOf("\nLSP_DIAGNOSTICS_UNAVAILABLE");
    expect(Buffer.byteLength(readbackResult.output.slice(0, warningOffset), "utf8")).toBeLessThan(
      1_024,
    );

    const moveLog = join(root, "host-warning-move.jsonl");
    const movePlugin = await configuredHooks({
      options: {
        maxOutputBytes: 1_024,
        lspDiagnostics: lspConfig("timeout", moveLog, { diagnosticsTimeoutMs: 400 }),
      },
      effectiveConfig: { tool_output: { max_bytes: 500, max_lines: 20 } },
      captureWithHook: true,
    });
    await mkdir(join(root, "long"));
    const sourcePath = `long/${"s".repeat(100)}.ts`;
    const destinationPath = `long/${"d".repeat(100)}.ts`;
    await writeFile(join(root, sourcePath), "move\n");
    const moveContext = context({ sessionID: "host-warning-move" });
    const moveSnapshot = await issueSnapshot(movePlugin.value, moveContext, sourcePath);
    const moved = structured(
      await registry(movePlugin.value).hashlineEdit.execute(
        {
          filePath: sourcePath,
          snapshotId: String(moveSnapshot.metadata.snapshotId),
          operations: [{ op: "move_file", destinationPath }],
        },
        moveContext,
      ),
    );
    expect(moved.output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE");
    expect(moved.output).toContain("Do not retry the mutation");
    expect(Buffer.byteLength(moved.output, "utf8")).toBeLessThanOrEqual(372);
    expect(await readFile(join(root, destinationPath), "utf8")).toBe("move\n");
  });

  test("preserves a newer successor when an older operation detects final drift", async () => {
    const file = join(root, "newer-successor.ts");
    await writeFile(file, "before\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 700 },
      name: "newer-successor",
    });
    const toolContext = context({ sessionID: "newer-successor" });
    const firstSnapshot = await issueSnapshot(value, toolContext, "newer-successor.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    const firstPending = registry(value).hashlineEdit.execute(
      {
        filePath: "newer-successor.ts",
        snapshotId: String(firstSnapshot.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["first"] }],
      },
      toolContext,
    );
    await actAfterFakeEvent(log, "diagnostic", () => Promise.resolve(), diagnosticOffset);

    const secondSnapshot = await issueSnapshot(value, toolContext, "newer-successor.ts");
    const secondPending = registry(value).hashlineEdit.execute(
      {
        filePath: "newer-successor.ts",
        snapshotId: String(secondSnapshot.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["second"] }],
      },
      toolContext,
    );
    await waitForFileText(file, "second\n");

    const firstResult = structured(await firstPending);
    const secondResult = structured(await secondPending);
    expect(firstResult.output).toContain("successor=unavailable next=hashline_read");
    expect(firstResult.output).toContain("changed again after publication");
    const secondSuccessor = /@hashline snapshot=(s_[^\s]+)/u.exec(secondResult.output)?.[1];
    expect(secondSuccessor).toBeDefined();
    await deliver(value, "hashline_edit", secondResult, toolContext, {});
    await expect(
      registry(value).hashlineEdit.execute(
        {
          filePath: "newer-successor.ts",
          snapshotId: secondSuccessor,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["third"] }],
        },
        toolContext,
      ),
    ).resolves.toBeDefined();
    expect(await readFile(file, "utf8")).toBe("third\n");
  });

  test("blocks new plugin admissions and drains active work during single-flight disposal", async () => {
    const file = join(root, "active-plugin-dispose.ts");
    await writeFile(file, "before\n");
    const { value, log } = await lspHooks("timeout", {
      config: { diagnosticsTimeoutMs: 500 },
      name: "active-plugin-dispose",
    });
    const toolContext = context({ sessionID: "active-plugin-dispose" });
    const snapshot = await issueSnapshot(value, toolContext, "active-plugin-dispose.ts");
    const diagnosticOffset = await fakeEventOffset(log);
    const pending = registry(value).hashlineEdit.execute(
      {
        filePath: "active-plugin-dispose.ts",
        snapshotId: String(snapshot.metadata.snapshotId),
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
      },
      toolContext,
    );
    await actAfterFakeEvent(log, "diagnostic", () => Promise.resolve(), diagnosticOffset);

    const firstDispose = value.dispose?.();
    const secondDispose = value.dispose?.();
    await expect(
      registry(value).hashlineRead.execute({ filePath: "active-plugin-dispose.ts" }, toolContext),
    ).rejects.toThrow("CONFIG_INVALID:");
    const result = structured(await pending);
    expect(result.output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE");
    await Promise.all([firstDispose, secondDispose]);
    const protocol = await events(log);
    expect(
      protocol
        .filter((entry) => entry.event === "shutdown" || entry.event === "exit")
        .map((entry) => entry.event),
    ).toEqual(["shutdown", "exit"]);
  });

  test("refuses after-hook attestation once disposal has cleared provenance", async () => {
    const { value } = await configuredHooks({ options: { lspDiagnostics: false } });
    await writeFile(join(root, "disposed-attestation.txt"), "before\n");
    const toolContext = context({ sessionID: "disposed-attestation" });
    const result = structured(
      await registry(value).hashlineRead.execute(
        { filePath: "disposed-attestation.txt" },
        toolContext,
      ),
    );
    expect(result.metadata.hashlinePending).toEqual(expect.any(String));

    await value.dispose?.();
    await deliver(value, "hashline_read", result, toolContext, {
      filePath: "disposed-attestation.txt",
    });

    expect(result.output).toContain("disposed before delivery could be attested");
    expect(result.metadata.hashlinePending).toBeUndefined();
    expect(result.metadata.snapshotId).toBeUndefined();
  });
});
