import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { exactRelativePath } from "../../src/path-identity.js";
import { canonicalJson, jsonSha256 } from "../../src/presentation.js";
import { captureBoundedProcess } from "./process.js";

export type PackageManifestEntry = {
  path: string;
  size: number;
  sha256: string;
};

export type PackageManifest = PackageManifestEntry[];

export type PackageManifestComparison = {
  matches: boolean;
  missing: string[];
  extra: string[];
  changed: Array<{
    path: string;
    expected: { size: number; sha256: string };
    actual: { size: number; sha256: string };
  }>;
};

export type ProvenanceCommandRunner = (
  command: readonly string[],
  cwd: string,
) => string | Promise<string>;

export type FileIdentity = {
  path: string;
  sha256: string;
};

export type BunIdentity = {
  executable: FileIdentity;
  version: string;
  revision: string;
};

export type NpmIdentity = {
  discoveryWrapper: {
    path: string;
    realPath: string;
    sha256: string;
  };
  node: {
    executable: FileIdentity;
    version: string;
  };
  cli: {
    path: string;
    sha256: string;
    packageDirectory: string;
    packageVersion: string;
    observedVersion: string;
    packageTreeSha256: string;
  };
  effectiveCommand: [string, string];
};

export type OpenCodeIdentity = {
  binary: FileIdentity;
  packageDirectory: string;
  packageVersion: string;
  observedVersion: string;
  packageTreeSha256: string;
};

export type EffectiveToolIdentities = {
  bun: BunIdentity;
  npm: NpmIdentity;
  opencode: OpenCodeIdentity;
};

export type BunIdentityOptions = {
  executablePath?: string;
  cwd?: string;
  run?: ProvenanceCommandRunner;
};

export type NpmIdentityOptions = {
  discoveryWrapperPath?: string;
  nodeExecutablePath?: string;
  npmCliPath?: string;
  npmPackageDirectory?: string;
  cwd?: string;
  run?: ProvenanceCommandRunner;
};

export type OpenCodeIdentityOptions = {
  packageDirectory?: string;
  binaryPath?: string;
  cwd?: string;
  run?: ProvenanceCommandRunner;
};

export type EffectiveToolIdentityOptions = {
  cwd?: string;
  run?: ProvenanceCommandRunner;
  bun?: Omit<BunIdentityOptions, "cwd" | "run">;
  npm?: Omit<NpmIdentityOptions, "cwd" | "run">;
  opencode?: Omit<OpenCodeIdentityOptions, "cwd" | "run">;
};

const TAR_BLOCK_SIZE = 512;
const TAR_END_SIZE = TAR_BLOCK_SIZE * 2;
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_TAR_BYTES = 128 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestPath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:\//.test(path)
  ) {
    throw new Error(`Unsafe package path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe package path: ${JSON.stringify(path)}`);
  }
  return path;
}

function archiveManifestPath(path: string): string {
  if (!path.startsWith("package/")) {
    throw new Error(`Npm tar entry is outside package/: ${JSON.stringify(path)}`);
  }
  const normalized = manifestPath(path.slice("package/".length));
  if (`package/${normalized}` !== path) {
    throw new Error(`Npm tar entry is not normalized: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function canonicalManifest(manifest: readonly PackageManifestEntry[]): PackageManifest {
  const paths = new Set<string>();
  const result = manifest.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid package manifest entry at index ${index}`);
    }
    const keys = Object.keys(entry).sort(compareStrings);
    if (keys.join(",") !== "path,sha256,size") {
      throw new Error(`Invalid package manifest entry fields at index ${index}`);
    }
    const path = manifestPath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Invalid package manifest size for ${JSON.stringify(path)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid package manifest SHA256 for ${JSON.stringify(path)}`);
    }
    if (paths.has(path)) {
      throw new Error(`Duplicate package manifest path: ${JSON.stringify(path)}`);
    }
    paths.add(path);
    return { path, size: entry.size, sha256: entry.sha256 };
  });
  return result.sort((left, right) => compareStrings(left.path, right.path));
}

function tarString(header: Uint8Array, start: number, length: number, label: string): string {
  const field = header.subarray(start, start + length);
  const terminator = field.indexOf(0);
  const end = terminator === -1 ? field.length : terminator;
  if (terminator !== -1 && field.subarray(terminator).some((byte) => byte !== 0)) {
    throw new Error(`Malformed tar ${label} field`);
  }
  try {
    return utf8Decoder.decode(field.subarray(0, end));
  } catch (error) {
    throw new Error(`Tar ${label} is not valid UTF-8`, { cause: error });
  }
}

function tarOctal(header: Uint8Array, start: number, length: number, label: string): number {
  const field = header.subarray(start, start + length);
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 0x20)) end -= 1;
  let begin = 0;
  while (begin < end && field[begin] === 0x20) begin += 1;
  if (begin === end) return 0;
  for (let index = begin; index < end; index += 1) {
    const byte = field[index];
    if (byte === undefined || byte < 0x30 || byte > 0x37) {
      throw new Error(`Unsupported tar ${label} encoding`);
    }
  }
  let value = 0;
  for (let index = begin; index < end; index += 1) {
    value = value * 8 + ((field[index] ?? 0) - 0x30);
    if (!Number.isSafeInteger(value)) throw new Error(`Tar ${label} exceeds safe integer range`);
  }
  return value;
}

function validateTarChecksum(header: Uint8Array): void {
  const expected = tarOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("Invalid tar header checksum");
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

export function deriveNpmTarballManifest(tarballBytes: Uint8Array): PackageManifest {
  if (tarballBytes.byteLength === 0 || tarballBytes.byteLength > MAX_TARBALL_BYTES) {
    throw new Error("Npm .tgz exceeds its compressed byte bounds");
  }
  let archive: Buffer;
  try {
    archive = gunzipSync(tarballBytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch (error) {
    throw new Error("Invalid npm .tgz gzip stream", { cause: error });
  }
  if (archive.length % TAR_BLOCK_SIZE !== 0) {
    throw new Error("Invalid tar length");
  }

  const entries: PackageManifest = [];
  const paths = new Set<string>();
  let offset = 0;
  let terminated = false;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (archive.length - offset < TAR_END_SIZE || !isZeroBlock(archive.subarray(offset))) {
        throw new Error("Tar archive does not have a canonical zero terminator");
      }
      terminated = true;
      break;
    }

    validateTarChecksum(header);
    const name = tarString(header, 0, 100, "name");
    const prefix = tarString(header, 345, 155, "prefix");
    const path = archiveManifestPath(prefix ? `${prefix}/${name}` : name);
    const type = header[156] ?? 0;
    if (type !== 0 && type !== 0x30) {
      throw new Error(`Npm tar entry is not a regular file: ${JSON.stringify(`package/${path}`)}`);
    }
    if (tarString(header, 157, 100, "link name") !== "") {
      throw new Error(`Regular npm tar entry has a link target: ${JSON.stringify(path)}`);
    }
    if (paths.has(path)) throw new Error(`Duplicate npm tar entry: ${JSON.stringify(path)}`);

    const size = tarOctal(header, 124, 12, "size");
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (!Number.isSafeInteger(dataEnd) || paddedEnd > archive.length) {
      throw new Error(`Truncated npm tar entry: ${JSON.stringify(path)}`);
    }
    if (!isZeroBlock(archive.subarray(dataEnd, paddedEnd))) {
      throw new Error(`Non-zero tar padding for ${JSON.stringify(path)}`);
    }

    const bytes = archive.subarray(dataStart, dataEnd);
    entries.push({ path, size, sha256: sha256(bytes) });
    paths.add(path);
    offset = paddedEnd;
  }
  if (!terminated) throw new Error("Tar archive is missing its zero terminator");
  return canonicalManifest(entries);
}

type StableStats = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function sameFile(left: StableStats, right: StableStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readStableRegularFile(
  path: string,
  label: string,
  observed?: Stats,
  allowHardlinks = false,
): Promise<Buffer> {
  const initial = observed ?? (await lstat(path));
  if (initial.isSymbolicLink() || !initial.isFile() || (!allowHardlinks && initial.nlink !== 1)) {
    throw new Error(`${label} is not a plain regular file`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || (!allowHardlinks && before.nlink !== 1) || !sameFile(before, initial)) {
      throw new Error(`${label} identity changed before read`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`${label} identity changed during read`);
    }
    const final = await lstat(path);
    if (
      final.isSymbolicLink() ||
      !final.isFile() ||
      (!allowHardlinks && final.nlink !== 1) ||
      !sameFile(after, final)
    ) {
      throw new Error(`${label} identity changed after read`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function assertWindowsPackageEntries(
  entries: readonly { absolute: string; path: string; directory: boolean }[],
): Promise<void> {
  if (process.platform !== "win32") return;
  const variable = "BETTER_HASHLINE_PACKAGE_PATHS";
  const script =
    `$ErrorActionPreference = 'Stop'; $items = ConvertFrom-Json -InputObject $env:${variable}; ` +
    "$result = @(); foreach ($item in $items) { $entry = Get-Item -LiteralPath $item -Force -ErrorAction Stop; $streams = @(Get-Item -LiteralPath $item -Stream * -ErrorAction Stop | ForEach-Object { $_.Stream }); " +
    "$result += [pscustomobject]@{ path = $item; reparse = (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); streams = $streams } }; ConvertTo-Json -Compress -Depth 3 -InputObject @($result)";
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = entries.slice(offset, offset + 64);
    const result = await captureBoundedProcess({
      command: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      cwd: process.cwd(),
      env: { [variable]: JSON.stringify(batch.map((entry) => entry.absolute)) },
      timeoutMs: 30_000,
      stdoutLimit: 4 * 1024 * 1024,
      stderrLimit: 256 * 1024,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutOverflow ||
      result.stderrOverflow
    ) {
      throw new Error("Unable to attest installed package NTFS metadata");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Installed package NTFS attestation returned invalid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error("Installed package NTFS attestation returned an invalid entry count");
    }
    parsed.forEach((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Installed package NTFS attestation returned an invalid entry");
      }
      const record = value as Record<string, unknown>;
      const streams = record.streams;
      const expected = batch[index];
      if (
        !expected ||
        record.path !== expected.absolute ||
        record.reparse !== false ||
        !Array.isArray(streams) ||
        !streams.every((stream) => typeof stream === "string") ||
        (expected.directory
          ? streams.length !== 0
          : streams.length !== 1 || streams[0] !== ":$DATA")
      ) {
        throw new Error(
          `Installed package contains unsafe NTFS metadata: ${expected?.path ?? "?"}`,
        );
      }
    });
  }
}

export async function deriveInstalledPackageManifest(
  directory: string,
  options: { allowHardlinks?: boolean } = {},
): Promise<PackageManifest> {
  const suppliedRoot = await lstat(directory);
  if (suppliedRoot.isSymbolicLink() || !suppliedRoot.isDirectory()) {
    throw new Error("Installed package root is not a plain directory");
  }
  const root = await realpath(directory);
  if (root !== resolve(directory)) {
    throw new Error("Installed package root must not traverse links or junctions");
  }
  const rootStats = await lstat(root);
  const entries: PackageManifest = [];
  const observedEntries: Array<{ absolute: string; path: string; directory: boolean }> = [
    { absolute: root, path: ".", directory: true },
  ];

  async function visit(current: string, segments: string[], observedDirectory: StableStats) {
    const names = await readdir(current);
    names.sort(compareStrings);
    for (const name of names) {
      const path = manifestPath([...segments, name].join("/"));
      const absolute = join(current, name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Installed package contains a symbolic link: ${JSON.stringify(path)}`);
      }
      if (stats.isDirectory()) {
        observedEntries.push({ absolute, path, directory: true });
        await visit(absolute, [...segments, name], stats);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Installed package contains a special entry: ${JSON.stringify(path)}`);
      }
      const bytes = await readStableRegularFile(
        absolute,
        `Installed package file ${path}`,
        stats,
        options.allowHardlinks,
      );
      observedEntries.push({ absolute, path, directory: false });
      entries.push({ path, size: bytes.byteLength, sha256: sha256(bytes) });
    }
    const finalDirectory = await lstat(current);
    if (
      finalDirectory.isSymbolicLink() ||
      !finalDirectory.isDirectory() ||
      !sameFile(finalDirectory, observedDirectory)
    ) {
      throw new Error(
        `Installed package directory identity changed: ${JSON.stringify(segments.join("/") || ".")}`,
      );
    }
  }

  await visit(root, [], rootStats);
  await assertWindowsPackageEntries(observedEntries);
  return canonicalManifest(entries);
}

export function comparePackageManifests(
  expectedManifest: readonly PackageManifestEntry[],
  actualManifest: readonly PackageManifestEntry[],
): PackageManifestComparison {
  const expected = canonicalManifest(expectedManifest);
  const actual = canonicalManifest(actualManifest);
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = expected
    .filter((entry) => !actualByPath.has(entry.path))
    .map((entry) => entry.path);
  const extra = actual
    .filter((entry) => !expectedByPath.has(entry.path))
    .map((entry) => entry.path);
  const changed = expected.flatMap((expectedEntry) => {
    const actualEntry = actualByPath.get(expectedEntry.path);
    if (
      !actualEntry ||
      (actualEntry.size === expectedEntry.size && actualEntry.sha256 === expectedEntry.sha256)
    ) {
      return [];
    }
    return [
      {
        path: expectedEntry.path,
        expected: { size: expectedEntry.size, sha256: expectedEntry.sha256 },
        actual: { size: actualEntry.size, sha256: actualEntry.sha256 },
      },
    ];
  });
  return {
    matches: missing.length === 0 && extra.length === 0 && changed.length === 0,
    missing,
    extra,
    changed,
  };
}

export function assertPackageManifestsEqual(
  expected: readonly PackageManifestEntry[],
  actual: readonly PackageManifestEntry[],
): void {
  const comparison = comparePackageManifests(expected, actual);
  if (!comparison.matches) {
    throw new Error(`Installed package does not match npm tarball: ${canonicalJson(comparison)}`);
  }
}

export function packageTreeSha256(manifest: readonly PackageManifestEntry[]): string {
  return jsonSha256(canonicalManifest(manifest));
}

async function defaultCommandRunner(command: readonly string[], cwd: string): Promise<string> {
  const captured = await captureBoundedProcess({
    command: [...command],
    cwd,
    env: process.env,
    timeoutMs: 30_000,
    stdoutLimit: 64 * 1024,
    stderrLimit: 64 * 1024,
  });
  if (
    captured.exitCode !== 0 ||
    captured.timedOut ||
    captured.stdoutOverflow ||
    captured.stderrOverflow ||
    captured.stderr.length > 0
  ) {
    throw new Error(
      `Provenance command failed: ${JSON.stringify(command)} (${canonicalJson(captured)})`,
    );
  }
  return captured.stdout;
}

async function commandLine(
  run: ProvenanceCommandRunner,
  command: readonly string[],
  cwd: string,
  label: string,
): Promise<string> {
  const output = await run(command, cwd);
  const value = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n")
      ? output.slice(0, -1)
      : output;
  if (!value || value.trim() !== value || value.includes("\r") || value.includes("\n")) {
    throw new Error(`${label} did not produce exactly one non-empty line`);
  }
  return value;
}

async function fileIdentity(path: string, cwd: string, label: string): Promise<FileIdentity> {
  const absolute = resolve(cwd, path);
  const canonical = await realpath(absolute);
  const bytes = await readStableRegularFile(canonical, label, undefined, true);
  return { path: canonical, sha256: sha256(bytes) };
}

async function existingFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) return false;
    const target = await lstat(await realpath(path));
    return target.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function discoveredExecutable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Unable to discover ${name} on PATH`);
  return path;
}

function parsePackageJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function packageVersion(packageJson: Record<string, unknown>, label: string): string {
  const version = packageJson.version;
  if (typeof version !== "string" || !version || version.trim() !== version) {
    throw new Error(`${label} does not contain an exact version`);
  }
  return version;
}

function declaredBin(packageJson: Record<string, unknown>, name: string, label: string): string {
  const bin = packageJson.bin;
  const value =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? (bin as Record<string, unknown>)[name]
        : undefined;
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} does not declare bin.${name}`);
  }
  return value;
}

function resolveInside(root: string, path: string, label: string): string {
  const target = resolve(root, path);
  if (exactRelativePath(root, target) === undefined) {
    throw new Error(`${label} escapes its package directory`);
  }
  return target;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return left === right;
}

export async function deriveBunIdentity(options: BunIdentityOptions = {}): Promise<BunIdentity> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = options.run ?? defaultCommandRunner;
  const executable = await fileIdentity(
    options.executablePath ?? process.execPath,
    cwd,
    "Bun executable",
  );
  const [version, revision] = await Promise.all([
    commandLine(run, [executable.path, "--version"], cwd, "Bun version"),
    commandLine(run, [executable.path, "--revision"], cwd, "Bun revision"),
  ]);
  return { executable, version, revision };
}

async function discoverNodeExecutable(
  wrapperPath: string,
  explicitPath: string | undefined,
  cwd: string,
  run: ProvenanceCommandRunner,
): Promise<FileIdentity> {
  const localName = process.platform === "win32" ? "node.exe" : "node";
  const localNode = join(dirname(wrapperPath), localName);
  const candidate = explicitPath
    ? explicitPath
    : (await existingFile(localNode))
      ? localNode
      : discoveredExecutable("node");
  const discovered = await fileIdentity(candidate, cwd, "Node discovery executable");
  const observedPath = await commandLine(
    run,
    [discovered.path, "-p", "process.execPath"],
    cwd,
    "Node executable observation",
  );
  if (!isAbsolute(observedPath)) throw new Error("Node reported a non-absolute process.execPath");
  return fileIdentity(observedPath, cwd, "Node executable");
}

async function discoverNpmCli(
  wrapperPath: string,
  wrapperRealPath: string,
  nodePath: string,
  cwd: string,
  run: ProvenanceCommandRunner,
): Promise<string> {
  if (basename(wrapperRealPath).toLowerCase() === "npm-cli.js") return wrapperRealPath;
  const wrapperDirectory = dirname(wrapperPath);
  const initialCli = join(wrapperDirectory, "node_modules", "npm", "bin", "npm-cli.js");
  if (!(await existingFile(initialCli))) {
    throw new Error("Unable to locate npm-cli.js from the npm discovery wrapper");
  }

  const prefixScript = join(wrapperDirectory, "node_modules", "npm", "bin", "npm-prefix.js");
  if (await existingFile(prefixScript)) {
    const prefixIdentity = await fileIdentity(prefixScript, cwd, "npm prefix discovery script");
    const prefix = await commandLine(
      run,
      [nodePath, prefixIdentity.path],
      cwd,
      "npm installation prefix",
    );
    if (!isAbsolute(prefix)) throw new Error("npm prefix discovery returned a non-absolute path");
    const prefixedCli = join(prefix, "node_modules", "npm", "bin", "npm-cli.js");
    if (await existingFile(prefixedCli)) return prefixedCli;
  }
  return initialCli;
}

async function findNpmPackageDirectory(cliPath: string): Promise<string> {
  let directory = dirname(cliPath);
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    if (await existingFile(packageJsonPath)) {
      const packageJson = parsePackageJson(
        await readStableRegularFile(
          await realpath(packageJsonPath),
          "npm package.json",
          undefined,
          true,
        ),
        "npm package.json",
      );
      if (packageJson.name === "npm") return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Unable to locate the npm package containing npm-cli.js");
}

function manifestEntryForPath(
  manifest: readonly PackageManifestEntry[],
  root: string,
  absolute: string,
  label: string,
): PackageManifestEntry {
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} is outside its package directory`);
  }
  const path = manifestPath(fromRoot.split(sep).join("/"));
  const entry = manifest.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`${label} is missing from its package manifest`);
  return entry;
}

export async function deriveNpmIdentity(options: NpmIdentityOptions = {}): Promise<NpmIdentity> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = options.run ?? defaultCommandRunner;
  const wrapperPath = resolve(cwd, options.discoveryWrapperPath ?? discoveredExecutable("npm"));
  const wrapper = await fileIdentity(wrapperPath, cwd, "npm discovery wrapper");
  const nodeExecutable = await discoverNodeExecutable(
    wrapperPath,
    options.nodeExecutablePath,
    cwd,
    run,
  );
  const nodeVersion = await commandLine(
    run,
    [nodeExecutable.path, "--version"],
    cwd,
    "Node version",
  );
  const discoveredCli = options.npmCliPath
    ? resolve(cwd, options.npmCliPath)
    : await discoverNpmCli(wrapperPath, wrapper.path, nodeExecutable.path, cwd, run);
  const cliFile = await fileIdentity(discoveredCli, cwd, "npm-cli.js");
  const packageDirectory = await realpath(
    options.npmPackageDirectory
      ? resolve(cwd, options.npmPackageDirectory)
      : await findNpmPackageDirectory(cliFile.path),
  );
  const manifest = await deriveInstalledPackageManifest(packageDirectory, { allowHardlinks: true });
  const cliEntry = manifestEntryForPath(manifest, packageDirectory, cliFile.path, "npm-cli.js");
  if (cliEntry.sha256 !== cliFile.sha256) {
    throw new Error("npm-cli.js changed while deriving npm provenance");
  }

  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJsonEntry = manifestEntryForPath(
    manifest,
    packageDirectory,
    packageJsonPath,
    "npm package.json",
  );
  const packageJsonBytes = await readStableRegularFile(
    packageJsonPath,
    "npm package.json",
    undefined,
    true,
  );
  if (
    packageJsonEntry.size !== packageJsonBytes.byteLength ||
    packageJsonEntry.sha256 !== sha256(packageJsonBytes)
  ) {
    throw new Error("npm package.json changed while deriving npm provenance");
  }
  const packageJson = parsePackageJson(packageJsonBytes, "npm package.json");
  if (packageJson.name !== "npm") throw new Error("npm package has an unexpected name");
  const version = packageVersion(packageJson, "npm package.json");
  const declaredCli = await realpath(
    resolveInside(packageDirectory, declaredBin(packageJson, "npm", "npm package.json"), "npm bin"),
  );
  if (!sameCanonicalPath(declaredCli, cliFile.path)) {
    throw new Error("Resolved npm-cli.js does not match the npm package bin declaration");
  }

  const effectiveCommand: [string, string] = [nodeExecutable.path, cliFile.path];
  const observedVersion = await commandLine(
    run,
    [...effectiveCommand, "--version"],
    cwd,
    "npm version",
  );
  if (observedVersion !== version) {
    throw new Error(
      `npm observed version ${observedVersion} does not match package version ${version}`,
    );
  }
  return {
    discoveryWrapper: {
      path: wrapperPath,
      realPath: wrapper.path,
      sha256: wrapper.sha256,
    },
    node: { executable: nodeExecutable, version: nodeVersion },
    cli: {
      path: cliFile.path,
      sha256: cliFile.sha256,
      packageDirectory,
      packageVersion: version,
      observedVersion,
      packageTreeSha256: packageTreeSha256(manifest),
    },
    effectiveCommand,
  };
}

export async function deriveOpenCodeIdentity(
  options: OpenCodeIdentityOptions = {},
): Promise<OpenCodeIdentity> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = options.run ?? defaultCommandRunner;
  const suppliedPackageDirectory = resolve(
    cwd,
    options.packageDirectory ?? join("node_modules", "opencode-ai"),
  );
  const packageStats = await lstat(suppliedPackageDirectory);
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
    throw new Error("OpenCode package root is not a plain directory");
  }
  const packageDirectory = await realpath(suppliedPackageDirectory);
  if (packageDirectory !== suppliedPackageDirectory) {
    throw new Error("OpenCode package root must not traverse links or junctions");
  }
  const manifest = await deriveInstalledPackageManifest(packageDirectory, { allowHardlinks: true });
  const packageJson = parsePackageJson(
    await readStableRegularFile(
      join(packageDirectory, "package.json"),
      "OpenCode package.json",
      undefined,
      true,
    ),
    "OpenCode package.json",
  );
  const version = packageVersion(packageJson, "OpenCode package.json");
  const declaredBinaryPath = resolveInside(
    packageDirectory,
    declaredBin(packageJson, "opencode", "OpenCode package.json"),
    "OpenCode bin",
  );
  const declaredBinary = await fileIdentity(declaredBinaryPath, cwd, "OpenCode binary");
  const binary = options.binaryPath
    ? await fileIdentity(options.binaryPath, cwd, "OpenCode binary")
    : declaredBinary;
  if (!sameCanonicalPath(binary.path, declaredBinary.path)) {
    throw new Error("OpenCode binary does not match its package bin declaration");
  }
  const observedVersion = await commandLine(
    run,
    [binary.path, "--version"],
    cwd,
    "OpenCode version",
  );
  if (observedVersion !== version) {
    throw new Error(
      `OpenCode observed version ${observedVersion} does not match package version ${version}`,
    );
  }
  return {
    binary,
    packageDirectory,
    packageVersion: version,
    observedVersion,
    packageTreeSha256: packageTreeSha256(manifest),
  };
}

export async function deriveEffectiveToolIdentities(
  options: EffectiveToolIdentityOptions = {},
): Promise<EffectiveToolIdentities> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const run = options.run ?? defaultCommandRunner;
  const [bun, npm, opencode] = await Promise.all([
    deriveBunIdentity({ ...options.bun, cwd, run }),
    deriveNpmIdentity({ ...options.npm, cwd, run }),
    deriveOpenCodeIdentity({ ...options.opencode, cwd, run }),
  ]);
  return { bun, npm, opencode };
}

export function assertEffectiveToolIdentitiesUnchanged(
  before: EffectiveToolIdentities,
  after: EffectiveToolIdentities,
): void {
  const changed = (["bun", "npm", "opencode"] as const).filter(
    (tool) => canonicalJson(before[tool]) !== canonicalJson(after[tool]),
  );
  if (changed.length > 0) {
    throw new Error(`Effective tool identity changed after preflight: ${changed.join(", ")}`);
  }
}
