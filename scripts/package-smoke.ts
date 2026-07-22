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

const COMMAND_TIMEOUT_MS = 20 * 60_000;

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
  await run(
    [
      process.execPath,
      join(root, "scripts", "session-smoke.ts"),
      opencode,
      join(sandbox, "node_modules", "opencode-better-hashline"),
      join(sandbox, "native-alias-session"),
      "--native-alias-recovery",
    ],
    root,
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
    await run(
      [installedBin, "verify", "--surface", "all", "--opencode", opencode, "--json"],
      sandbox,
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
