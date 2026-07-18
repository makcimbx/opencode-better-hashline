import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function capture(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = Bun.spawnSync(command, {
    cwd,
    ...(env ? { env } : {}),
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    success: result.success,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function run(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const result = capture(command, cwd, env);

  if (!result.success) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

const root = resolve(import.meta.dir, "..");
const keepTarball =
  process.argv.includes("--keep-tarball") || process.env.PACKAGE_SMOKE_KEEP_TARBALL === "1";
const packed = JSON.parse(run(["npm", "pack", "--json", "--ignore-scripts"], root)) as PackResult[];
const result = packed[0];

if (!result) throw new Error("npm pack returned no package");

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

const tarball = resolve(root, result.filename);
const sandbox = await mkdtemp(join(tmpdir(), "better-hashline-pack-"));

try {
  await writeFile(join(sandbox, "package.json"), '{"private":true,"type":"module"}\n');
  run([process.execPath, "add", tarball], sandbox);
  run(
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
  ) as { version?: string };

  const opencodePackage = JSON.parse(
    await readFile(join(root, "node_modules", "opencode-ai", "package.json"), "utf8"),
  ) as { bin?: { opencode?: string } };
  if (!opencodePackage.bin?.opencode) {
    throw new Error("Pinned opencode-ai package does not expose the opencode binary");
  }
  const opencode = resolve(root, "node_modules", "opencode-ai", opencodePackage.bin.opencode);
  const configHome = join(sandbox, "config");
  const configDirectory = join(sandbox, "config-empty");
  await Promise.all([
    mkdir(configHome, { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
    writeFile(join(sandbox, "probe.txt"), "probe\n"),
  ]);
  const packageUrl = pathToFileURL(join(sandbox, "node_modules", "opencode-better-hashline")).href;
  const probeEnvironment = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [packageUrl] }),
  };
  const probe = JSON.parse(
    run(
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

  const invalidProbe = capture(
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
  run(
    [
      process.execPath,
      join(root, "scripts", "session-smoke.ts"),
      opencode,
      join(sandbox, "node_modules", "opencode-better-hashline"),
      join(sandbox, "session-smoke"),
    ],
    root,
  );
  console.log(`Verified ${basename(result.filename)} (v${packageJson.version ?? "unknown"})`);
} finally {
  await rm(sandbox, { force: true, recursive: true });
  if (!keepTarball) await rm(tarball, { force: true });
}
