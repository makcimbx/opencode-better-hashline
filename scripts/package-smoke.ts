import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureBoundedProcess } from "../src/process-capture.js";
import {
  assertFullVerificationReport,
  PINNED_OPENCODE_VERSION,
} from "../src/verification-report.js";

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

interface FakeLspEvent {
  event?: unknown;
  identifier?: unknown;
  pid?: unknown;
}

const COMMAND_TIMEOUT_MS = 20 * 60_000;

const FAKE_LSP_SERVER_SOURCE = String.raw`import { appendFileSync } from "node:fs";

const logPath = process.env.BETTER_HASHLINE_FAKE_LSP_LOG;
if (!logPath) throw new Error("BETTER_HASHLINE_FAKE_LSP_LOG is required");
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
let input = Buffer.alloc(0);

function log(event, detail = {}) {
  appendFileSync(logPath, JSON.stringify({ event, pid: process.pid, ...detail }) + "\n");
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
}

function fail(message) {
  log("fatal", { message });
  process.exit(2);
}

function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    fail("invalid JSON-RPC message");
  }
  const method = message.method;
  if (method === "initialize") {
    log("initialize");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          positionEncoding: "utf-16",
          textDocumentSync: 1,
          diagnosticProvider: {
            identifier: "package-smoke",
            interFileDependencies: false,
            workspaceDiagnostics: false,
          },
        },
      },
    });
    return;
  }
  if (method === "initialized") {
    log("initialized");
    return;
  }
  if (method === "textDocument/didOpen") {
    log("open");
    return;
  }
  if (method === "textDocument/didClose") {
    log("close");
    return;
  }
  if (method === "textDocument/diagnostic") {
    log("diagnostic", { identifier: message.params?.identifier });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        kind: "full",
        resultId: "1",
        items: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: 1,
            code: "SMOKE001",
            message: "managed package smoke error",
          },
        ],
      },
    });
    return;
  }
  if (method === "shutdown") {
    log("shutdown");
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (method === "exit") {
    log("exit");
    process.exit(0);
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  while (input.length > 0) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (input.length > MAX_HEADER_BYTES) fail("oversized JSON-RPC header");
      return;
    }
    if (headerEnd > MAX_HEADER_BYTES) fail("oversized JSON-RPC header");
    const header = input.subarray(0, headerEnd).toString("ascii");
    const lengthHeader = header
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));
    const length = Number(lengthHeader?.slice("content-length:".length).trim());
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
      fail("invalid JSON-RPC content length");
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (input.length < bodyEnd) {
      if (input.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES) fail("oversized JSON-RPC frame");
      return;
    }
    const body = input.subarray(bodyStart, bodyEnd).toString("utf8");
    input = input.subarray(bodyEnd);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid JSON-RPC body");
    }
  }
});
process.stdin.on("error", (error) => fail(error.message));
log("started");
process.stdin.resume();
`;

async function capture(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = await captureBoundedProcess({
    command,
    cwd,
    env: env ?? process.env,
    timeoutMs: COMMAND_TIMEOUT_MS,
    stdoutLimit: 32 * 1024 * 1024,
    stderrLimit: 8 * 1024 * 1024,
  });
  return {
    success:
      result.exitCode === 0 && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow,
    stdout: result.stdout,
    stderr: result.timedOut
      ? `${result.stderr}\nCommand timed out after ${COMMAND_TIMEOUT_MS} ms.`
      : result.stderr,
  };
}

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = await capture(command, cwd, env);

  if (!result.success) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

async function runTimed(
  label: string,
  command: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
  forwardStderr = false,
) {
  const started = performance.now();
  try {
    const result = await capture(command, cwd, env);
    if (!result.success) {
      throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    if (forwardStderr && result.stderr) process.stderr.write(result.stderr);
    return result.stdout;
  } finally {
    console.error(`[package-smoke] ${label}: ${Math.round(performance.now() - started)} ms`);
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Managed LSP process ${pid} remained alive after plugin disposal`);
}

const root = resolve(import.meta.dir, "..");
const keepTarball =
  process.argv.includes("--keep-tarball") || process.env.PACKAGE_SMOKE_KEEP_TARBALL === "1";
let tarball: string | undefined;
let sandbox: string | undefined;
let primaryError: unknown;
let successMessage: string | undefined;

try {
  const npmExecutable = Bun.which("npm");
  if (!npmExecutable) throw new Error("Unable to resolve npm on PATH");
  const packed = JSON.parse(
    await run([npmExecutable, "pack", "--json", "--ignore-scripts"], root),
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
  if (included.has("docs/lsp-integration-plan.md")) {
    throw new Error("temporary LSP integration plan leaked into npm package");
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
  const dataHome = join(sandbox, "data");
  const cacheHome = join(sandbox, "cache");
  const stateHome = join(sandbox, "state");
  const npmCache = join(sandbox, "npm-cache");
  const temp = join(sandbox, "temp");
  const fakeLspServer = join(sandbox, "fake-lsp-server.mjs");
  const fakeLspLog = join(sandbox, "fake-lsp.jsonl");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(temp, { recursive: true }),
    writeFile(join(sandbox, "probe.txt"), "probe\n"),
    writeFile(fakeLspServer, FAKE_LSP_SERVER_SOURCE, "utf8"),
    writeFile(fakeLspLog, "", "utf8"),
  ]);
  const packageUrl = pathToFileURL(join(sandbox, "node_modules", "opencode-better-hashline")).href;
  // OpenCode installs provider dependencies under its config root; warm it once for all serial probes.
  const harnessEnvironment = {
    ...process.env,
    BETTER_HASHLINE_SMOKE_CONFIG_HOME: configHome,
    BETTER_HASHLINE_SMOKE_TIMINGS: "1",
    BETTER_HASHLINE_VERIFY_TIMINGS: "1",
    NPM_CONFIG_CACHE: npmCache,
  };
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
    NPM_CONFIG_CACHE: npmCache,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [packageUrl] }),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
  const probe = JSON.parse(
    await runTimed(
      "packed plugin probe",
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

  const managedLspProbe = JSON.parse(
    await runTimed(
      "packed managed-LSP probe",
      [
        opencode,
        "debug",
        "agent",
        "build",
        "--tool",
        "hashline_write",
        "--params",
        '{"filePath":"managed-lsp.ts","content":"broken\\n"}',
      ],
      sandbox,
      {
        ...probeEnvironment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: [packageUrl],
          lsp: {
            "package-smoke": {
              command: [process.execPath, fakeLspServer],
              extensions: [".ts"],
              env: { BETTER_HASHLINE_FAKE_LSP_LOG: fakeLspLog },
            },
          },
        }),
      },
    ),
  ) as { result?: { metadata?: Record<string, unknown>; output?: string } };
  const managedLspOutput = managedLspProbe.result?.output ?? "";
  const managedLspDiagnostics = managedLspOutput
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("LSP| "));
  if (
    !managedLspOutput.includes("@better-hashline-lsp advisory=true errors=1 truncated=false") ||
    managedLspDiagnostics.length !== 1 ||
    !managedLspDiagnostics[0]
      ?.replaceAll("\\", "/")
      .endsWith("managed-lsp.ts:1:1 [package-smoke/SMOKE001] managed package smoke error")
  ) {
    throw new Error(`Packed managed LSP did not return its Error diagnostic:\n${managedLspOutput}`);
  }
  if (managedLspProbe.result?.metadata?.created !== true) {
    throw new Error("Packed managed-LSP mutation metadata was not preserved by OpenCode");
  }
  if ((await readFile(join(sandbox, "managed-lsp.ts"), "utf8")) !== "broken\n") {
    throw new Error("Packed managed-LSP mutation produced unexpected file bytes");
  }
  const fakeLspEvents = (await readFile(fakeLspLog, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLspEvent);
  const expectedLspEvents = [
    "started",
    "initialize",
    "initialized",
    "open",
    "diagnostic",
    "close",
    "shutdown",
    "exit",
  ];
  if (
    JSON.stringify(fakeLspEvents.map(({ event }) => event)) !== JSON.stringify(expectedLspEvents)
  ) {
    throw new Error(`Unexpected managed-LSP lifecycle: ${JSON.stringify(fakeLspEvents)}`);
  }
  if (fakeLspEvents.find(({ event }) => event === "diagnostic")?.identifier !== "package-smoke") {
    throw new Error("Managed LSP did not request diagnostics with the imported provider ID");
  }
  const fakeLspPids = new Set(
    fakeLspEvents.map(({ pid }) => pid).filter((pid): pid is number => Number.isSafeInteger(pid)),
  );
  const fakeLspPid = [...fakeLspPids][0];
  if (fakeLspPids.size !== 1 || !fakeLspPid || fakeLspPid <= 0) {
    throw new Error(
      `Managed-LSP fixture reported invalid process IDs: ${JSON.stringify([...fakeLspPids])}`,
    );
  }
  await waitForProcessExit(fakeLspPid);

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
  await runTimed(
    "native-alias restart recovery",
    [
      process.execPath,
      join(root, "scripts", "session-smoke.ts"),
      opencode,
      join(sandbox, "node_modules", "opencode-better-hashline"),
      join(sandbox, "native-alias-session"),
      "--native-alias-recovery",
    ],
    root,
    harnessEnvironment,
    true,
  );
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
  const verification: unknown = JSON.parse(
    await runTimed(
      "installed verifier",
      [installedBin, "verify", "--surface", "all", "--opencode", opencode, "--json"],
      sandbox,
      harnessEnvironment,
      true,
    ),
  );
  if (!packageJson.version) throw new Error("Packed package has no version");
  assertFullVerificationReport(verification, packageJson.version, PINNED_OPENCODE_VERSION);
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
