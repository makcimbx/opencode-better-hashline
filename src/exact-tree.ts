import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { exactRelativePath } from "./path-identity.js";

export interface ExactTreeExpectation {
  expectedFiles: Record<string, string>;
  absentFiles?: string[];
}

type ObservedFile = {
  absolute: string;
  physical: string;
  dev: number;
  ino: number;
};

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function windowsStreamMismatches(
  paths: Array<{ absolute: string; display: string; directory: boolean }>,
): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const variable = "BETTER_HASHLINE_ADS_PATHS";
  let parsed: unknown;
  try {
    const { readWindowsPathMetadata } = await import("./windows-metadata.js");
    parsed = await readWindowsPathMetadata(
      paths.map((path) => path.absolute),
      variable,
    );
  } catch {
    return [".: unable to attest NTFS alternate data streams"];
  }
  try {
    if (!Array.isArray(parsed) || parsed.length !== paths.length) throw new Error("shape");
    const mismatches: string[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const item = parsed[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("item");
      const record = item as Record<string, unknown>;
      if (
        record.path !== paths[index]?.absolute ||
        typeof record.reparse !== "boolean" ||
        !Array.isArray(record.streams)
      ) {
        throw new Error("entry");
      }
      const streams = record.streams;
      const validStreams = paths[index]?.directory
        ? streams.length === 0
        : streams.length === 1 && streams[0] === ":$DATA";
      if (record.reparse) {
        mismatches.push(`${paths[index]?.display}: reparse points are not allowed`);
      }
      if (!validStreams) {
        mismatches.push(`${paths[index]?.display}: alternate data streams are not allowed`);
      }
    }
    return mismatches;
  } catch {
    return [".: unable to attest NTFS alternate data streams"];
  }
}

function taskPath(path: string): string {
  const value = normalized(path);
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.includes("/./") ||
    value.endsWith("/.") ||
    isAbsolute(path)
  ) {
    throw new Error(`Unsafe benchmark task path: ${JSON.stringify(path)}`);
  }
  return value;
}

function expectedDirectories(task: ExactTreeExpectation): Set<string> {
  const directories = new Set<string>();
  for (const rawPath of Object.keys(task.expectedFiles)) {
    const path = taskPath(rawPath);
    let parent = normalized(dirname(path));
    while (parent !== "." && !directories.has(parent)) {
      directories.add(parent);
      parent = normalized(dirname(parent));
    }
  }
  return directories;
}

export async function evaluateExactTree<T extends ExactTreeExpectation>(
  root: string,
  task: T,
  options: { beforeRead?: (path: string) => Promise<void> } = {},
) {
  const mismatches: string[] = [];
  const suppliedRootStats = await lstat(root);
  if (!suppliedRootStats.isDirectory() || suppliedRootStats.isSymbolicLink()) {
    return { exactFiles: false, mismatches: [".: fixture root is not a plain directory"] };
  }
  const canonicalRoot = await realpath(root);
  const expectedFiles = new Set(Object.keys(task.expectedFiles).map(taskPath));
  const expectedDirs = expectedDirectories(task);
  const observedFiles = new Map<string, ObservedFile>();
  const observedDirs = new Set<string>();
  const observedAbsolutePaths = [{ absolute: canonicalRoot, display: ".", directory: true }];

  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = join(directory, name);
      const relativePath = exactRelativePath(canonicalRoot, absolute);
      const path = relativePath === undefined ? "" : normalized(relativePath);
      if (!path) {
        mismatches.push(`${name}: path identity escapes the fixture`);
        continue;
      }
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        mismatches.push(`${path}: symbolic link is not allowed`);
        continue;
      }
      if (stats.isDirectory()) {
        observedDirs.add(path);
        observedAbsolutePaths.push({ absolute, display: path, directory: true });
        await visit(absolute);
        continue;
      }
      if (!stats.isFile()) {
        mismatches.push(`${path}: special filesystem entry is not allowed`);
        continue;
      }
      if (stats.nlink !== 1) mismatches.push(`${path}: hard links are not allowed`);
      const physical = await realpath(absolute);
      if (exactRelativePath(canonicalRoot, physical) === undefined) {
        mismatches.push(`${path}: physical path escapes the fixture`);
        continue;
      }
      observedAbsolutePaths.push({ absolute, display: path, directory: false });
      observedFiles.set(path, {
        absolute,
        physical,
        dev: stats.dev,
        ino: stats.ino,
      });
      if (!expectedFiles.has(path)) mismatches.push(`${path}: unexpected file`);
    }
  }

  await visit(canonicalRoot);
  mismatches.push(...(await windowsStreamMismatches(observedAbsolutePaths)));

  for (const [rawPath, expected] of Object.entries(task.expectedFiles)) {
    const path = taskPath(rawPath);
    const observed = observedFiles.get(path);
    if (!observed) {
      mismatches.push(`${path}: missing`);
      continue;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await options.beforeRead?.(path);
      handle = await open(observed.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, observed)) {
        mismatches.push(`${path}: identity changed before read`);
        continue;
      }
      const actual = await handle.readFile();
      const after = await handle.stat();
      if (!sameIdentity(before, after) || before.size !== after.size) {
        mismatches.push(`${path}: identity changed during read`);
        continue;
      }
      if (!actual.equals(Buffer.from(expected, "utf8")))
        mismatches.push(`${path}: content mismatch`);
    } catch {
      mismatches.push(`${path}: unable to read stable file identity`);
      continue;
    } finally {
      await handle?.close();
    }
    try {
      const finalStats = await lstat(observed.absolute);
      const finalPhysical = await realpath(observed.absolute);
      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isFile() ||
        finalStats.nlink !== 1 ||
        !sameIdentity(finalStats, observed) ||
        finalPhysical !== observed.physical
      ) {
        mismatches.push(`${path}: identity changed after read`);
      }
    } catch {
      mismatches.push(`${path}: identity changed after read`);
    }
  }
  for (const path of task.absentFiles ?? []) {
    const safePath = taskPath(path);
    try {
      await lstat(resolve(canonicalRoot, safePath));
      mismatches.push(`${safePath}: should not exist`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const path of observedDirs) {
    if (!expectedDirs.has(path)) mismatches.push(`${path}: unexpected directory`);
  }

  return { exactFiles: mismatches.length === 0, mismatches: [...new Set(mismatches)].sort() };
}
