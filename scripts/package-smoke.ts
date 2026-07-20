import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

const COMMAND_TIMEOUT_MS = 20 * 60_000;

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

async function exitsWithin(child: SpawnedProcess, milliseconds: number): Promise<boolean> {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), milliseconds);
    child.exited.then(() => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

async function terminateProcessTree(child: SpawnedProcess): Promise<void> {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stderr: "ignore",
      stdout: "ignore",
    });
    if (!(await exitsWithin(killer, 5_000))) killer.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (!(await exitsWithin(child, 5_000))) {
    child.kill("SIGKILL");
    if (!(await exitsWithin(child, 5_000))) {
      throw new Error(`Process tree ${child.pid} did not terminate`);
    }
  }
}

async function capture(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, {
    cwd,
    detached: process.platform !== "win32",
    ...(env ? { env } : {}),
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let commandTimeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: "completed" as const, exitCode })),
    new Promise<{ kind: "timeout" }>((resolveTimeout) => {
      commandTimeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), COMMAND_TIMEOUT_MS);
    }),
  ]);
  if (commandTimeout) clearTimeout(commandTimeout);
  if (outcome.kind === "timeout") {
    await terminateProcessTree(child);
  }
  let outputTimeout: ReturnType<typeof setTimeout> | undefined;
  const [stdout, stderr] = await Promise.race([
    output,
    new Promise<never>((_, reject) => {
      outputTimeout = setTimeout(
        () => reject(new Error(`${command.join(" ")} did not close output streams`)),
        5_000,
      );
    }),
  ]);
  if (outputTimeout) clearTimeout(outputTimeout);

  return {
    success: outcome.kind === "completed" && outcome.exitCode === 0,
    stdout,
    stderr:
      outcome.kind === "timeout"
        ? `${stderr}\nCommand timed out after ${COMMAND_TIMEOUT_MS} ms.`
        : stderr,
  };
}

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = await capture(command, cwd, env);

  if (!result.success) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

const root = resolve(import.meta.dir, "..");
const keepTarball =
  process.argv.includes("--keep-tarball") || process.env.PACKAGE_SMOKE_KEEP_TARBALL === "1";
let tarball: string | undefined;
let sandbox: string | undefined;
let primaryError: unknown;
let successMessage: string | undefined;

try {
  const packed = JSON.parse(
    await run(["npm", "pack", "--json", "--ignore-scripts"], root),
  ) as PackResult[];
  const result = packed[0];
  if (!result) throw new Error("npm pack returned no package");
  tarball = resolve(root, result.filename);

  const included = new Set(result.files.map((file) => file.path.replaceAll("\\", "/")));
  for (const required of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "docs/assets/hero.svg",
    "docs/protocol.md",
    "docs/threat-model.md",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/cli.d.ts",
    "dist/cli.js",
    "dist/server.d.ts",
    "dist/server.js",
    "package.json",
  ]) {
    if (!included.has(required)) throw new Error(`npm package is missing ${required}`);
  }
  for (const path of included) {
    if (/^(benchmarks|scripts|src|tests)\//.test(path)) {
      throw new Error(`development file leaked into npm package: ${path}`);
    }
  }

  sandbox = await mkdtemp(join(tmpdir(), "better-hashline-pack-"));
  await writeFile(join(sandbox, "package.json"), '{"private":true,"type":"module"}\n');
  await run([process.execPath, "add", "--ignore-scripts", tarball], sandbox);
  await run(
    [
      process.execPath,
      "-e",
      'Promise.all([import("opencode-better-hashline"), import("opencode-better-hashline/server")]).then(([root, server]) => { if (typeof root.default?.server !== "function" || typeof server.default?.server !== "function") process.exit(1) })',
    ],
    sandbox,
  );

  const packageJson = JSON.parse(
    await readFile(
      join(sandbox, "node_modules", "opencode-better-hashline", "package.json"),
      "utf8",
    ),
  ) as { bin?: { "opencode-better-hashline"?: string }; version?: string };
  if (packageJson.bin?.["opencode-better-hashline"] !== "./dist/cli.js") {
    throw new Error("Packed package does not expose the verification CLI");
  }

  const opencodePackage = JSON.parse(
    await readFile(join(root, "node_modules", "opencode-ai", "package.json"), "utf8"),
  ) as { bin?: { opencode?: string } };
  if (!opencodePackage.bin?.opencode) {
    throw new Error("Pinned opencode-ai package does not expose the opencode binary");
  }
  const opencode = resolve(root, "node_modules", "opencode-ai", opencodePackage.bin.opencode);
  const home = join(sandbox, "home");
  const configHome = join(sandbox, "config");
  const configDirectory = join(sandbox, "config-empty");
  const dataHome = join(sandbox, "data");
  const cacheHome = join(sandbox, "cache");
  const stateHome = join(sandbox, "state");
  const temp = join(sandbox, "temp");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
    mkdir(temp, { recursive: true }),
    writeFile(join(sandbox, "probe.txt"), "probe\n"),
  ]);
  const packageUrl = pathToFileURL(join(sandbox, "node_modules", "opencode-better-hashline")).href;
  const probeEnvironment = {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [packageUrl] }),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
  const probe = JSON.parse(
    await run(
      [
        opencode,
        "debug",
        "agent",
        "build",
        "--tool",
        "hashline_read",
        "--params",
        '{"filePath":"probe.txt","limit":1}',
      ],
      sandbox,
      probeEnvironment,
    ),
  ) as { result?: { output?: string } };
  if (!probe.result?.output?.startsWith("@hashline snapshot=")) {
    throw new Error("Packed package did not register hashline_read in OpenCode");
  }

  const invalidProbe = await capture(
    [
      opencode,
      "debug",
      "agent",
      "build",
      "--tool",
      "hashline_read",
      "--params",
      '{"filePath":"probe.txt","limit":1}',
    ],
    sandbox,
    {
      ...probeEnvironment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [[packageUrl, { unknownOption: true }]] }),
    },
  );
  if (!`${invalidProbe.stdout}\n${invalidProbe.stderr}`.includes("CONFIG_INVALID")) {
    throw new Error("Invalid plugin options did not produce a fail-closed OpenCode diagnostic");
  }
  const binDirectory = join(sandbox, "node_modules", ".bin");
  const binCandidates =
    process.platform === "win32"
      ? ["opencode-better-hashline.exe", "opencode-better-hashline.cmd"]
      : ["opencode-better-hashline"];
  let installedBin: string | undefined;
  for (const candidate of binCandidates) {
    const path = join(binDirectory, candidate);
    try {
      await access(path);
      installedBin = path;
      break;
    } catch {
      // Continue until the platform-specific package-manager shim is found.
    }
  }
  if (!installedBin) throw new Error("Packed package did not install its CLI bin shim");
  await run([installedBin, "--help"], sandbox, probeEnvironment);
  const verification = JSON.parse(
    await run(
      [installedBin, "verify", "--surface", "all", "--opencode", opencode, "--json"],
      sandbox,
    ),
  ) as {
    ok?: boolean;
    rollbackVerified?: boolean;
    modelRoutingVerified?: boolean;
    editPermissionMatrixVerified?: boolean;
    cases?: unknown[];
  };
  if (
    !verification.ok ||
    !verification.rollbackVerified ||
    !verification.modelRoutingVerified ||
    !verification.editPermissionMatrixVerified ||
    verification.cases?.length !== 3
  ) {
    throw new Error("Packed verification CLI did not verify all three routes");
  }
  successMessage = `Verified ${basename(result.filename)} (v${packageJson.version ?? "unknown"})`;
} catch (error) {
  primaryError = error;
}

const cleanup: Promise<unknown>[] = [];
if (sandbox) cleanup.push(rm(sandbox, { force: true, recursive: true }));
if (tarball && !keepTarball) cleanup.push(rm(tarball, { force: true }));
const cleanupResults = await Promise.allSettled(cleanup);
const cleanupErrors = cleanupResults.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : [],
);
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
    "Package smoke cleanup failed",
  );
}
if (primaryError !== undefined) throw primaryError;
if (!successMessage) throw new Error("Package smoke did not produce a verification result");
console.log(successMessage);
