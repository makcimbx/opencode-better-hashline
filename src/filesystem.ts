import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { access, link, lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { fail } from "./errors.js";
import { bytesEqual } from "./text.js";

export type ResolvedFile = {
  requestedPath: string;
  requestedAbsolute: string;
  canonicalPath: string;
};

export type ResolvedNewFile = ResolvedFile & {
  requestedParent: string;
  canonicalParent: string;
  parentStats: Stats;
};

export type StableFile = {
  bytes: Uint8Array;
  stats: Stats;
};

const pathLocks = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function assertSafePath(path: string, source: "requested" | "canonical"): void {
  const hasControl = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);
  const hasGlobSyntax = [...path].some((character) => "*?[]{}!".includes(character));
  const hasPosixBackslash = process.platform !== "win32" && path.includes("\\");
  if (path.length === 0 || hasControl || hasGlobSyntax || hasPosixBackslash) {
    fail(
      source === "requested" ? "INVALID_ARGUMENT" : "UNSUPPORTED_FILE",
      `${source === "requested" ? "filePath" : "The canonical path"} contains characters that cannot be represented safely in permission patterns.`,
    );
  }
}

function absoluteFrom(filePath: string, directory: string): string {
  assertSafePath(filePath, "requested");
  return resolve(isAbsolute(filePath) ? filePath : join(directory, filePath));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

async function isExternal(context: ToolContext, canonicalPath: string): Promise<boolean> {
  const [directory, worktree] = await Promise.all([
    canonicalRoot(context.directory),
    canonicalRoot(context.worktree),
  ]);
  return !isInside(directory, canonicalPath) && !isInside(worktree, canonicalPath);
}

function permissionPath(context: ToolContext, canonicalPath: string): string {
  return relative(context.worktree, canonicalPath) || basename(canonicalPath);
}

function assertRegular(stats: Stats): void {
  if (!stats.isFile()) fail("UNSUPPORTED_FILE", "Hashline only supports regular files.");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMetadata(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function lockKey(canonicalPath: string): string {
  return process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems and on Windows.
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("The operation was aborted.");
}

export async function resolveExistingFile(
  filePath: string,
  directory: string,
): Promise<ResolvedFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedAbsolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") fail("PATH_NOT_FOUND", `File not found: ${filePath}`);
    throw error;
  }
  assertSafePath(canonicalPath, "canonical");
  const stats = await stat(canonicalPath);
  assertRegular(stats);
  return { requestedPath: filePath, requestedAbsolute, canonicalPath };
}

export async function resolveNewFile(
  filePath: string,
  directory: string,
): Promise<ResolvedNewFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  const requestedParent = dirname(requestedAbsolute);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(requestedParent);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      fail("PATH_NOT_FOUND", `Parent directory not found: ${requestedParent}`);
    }
    throw error;
  }
  assertSafePath(canonicalParent, "canonical");
  const parentStats = await stat(canonicalParent);
  if (!parentStats.isDirectory()) fail("UNSUPPORTED_FILE", "The target parent is not a directory.");
  const canonicalPath = join(canonicalParent, basename(requestedAbsolute));
  assertSafePath(canonicalPath, "canonical");
  return {
    requestedPath: filePath,
    requestedAbsolute,
    requestedParent,
    canonicalParent,
    parentStats,
    canonicalPath,
  };
}

export async function authorizeExternal(
  context: ToolContext,
  resolved: ResolvedFile,
): Promise<void> {
  if (!(await isExternal(context, resolved.canonicalPath))) return;
  const pattern = join(dirname(resolved.canonicalPath), "*");
  await ask(context, {
    permission: "external_directory",
    patterns: [pattern],
    always: [pattern],
    metadata: {
      filepath: resolved.canonicalPath,
      parentDir: dirname(resolved.canonicalPath),
    },
  });
}

export async function authorizeRead(context: ToolContext, resolved: ResolvedFile): Promise<void> {
  await ask(context, {
    permission: "read",
    patterns: [permissionPath(context, resolved.canonicalPath)],
    always: ["*"],
    metadata: {},
  });
}

export async function authorizeEdit(
  context: ToolContext,
  resolved: ResolvedFile,
  diff: string,
): Promise<void> {
  await ask(context, {
    permission: "edit",
    patterns: [permissionPath(context, resolved.canonicalPath)],
    always: ["*"],
    metadata: { filepath: resolved.canonicalPath, diff },
  });
}

async function ask(context: ToolContext, input: Parameters<ToolContext["ask"]>[0]): Promise<void> {
  try {
    await context.ask(input);
  } catch (error) {
    if (context.abort.aborted) throw context.abort.reason ?? error;
    const message = error instanceof Error ? error.message : String(error);
    if (/denied|permission|rejected/u.test(message.toLowerCase())) {
      fail("PERMISSION_DENIED", "The requested filesystem permission was denied.");
    }
    throw error;
  }
}

export async function assertAliasStable(resolved: ResolvedFile): Promise<void> {
  let current: string;
  try {
    current = await realpath(resolved.requestedAbsolute);
  } catch {
    fail("PATH_MISMATCH", "The requested path no longer resolves to the snapshot target.");
  }
  assertSafePath(current, "canonical");
  if (!samePath(current, resolved.canonicalPath)) {
    fail("PATH_MISMATCH", "The requested path was retargeted during the operation.");
  }
}

export async function readStableFile(
  resolved: ResolvedFile,
  maxBytes: number,
  rejectHardlinks: boolean,
  signal?: AbortSignal,
): Promise<StableFile> {
  if (signal) throwIfAborted(signal);
  const handle = await open(resolved.canonicalPath, "r");
  try {
    const before = await handle.stat();
    assertRegular(before);
    if (rejectHardlinks && before.nlink !== 1) {
      fail("UNSUPPORTED_FILE", "Editing hard-linked files is not supported.");
    }
    if (before.size > maxBytes) {
      fail("UNSUPPORTED_FILE", `File exceeds the ${maxBytes}-byte safety limit.`);
    }
    if (signal) throwIfAborted(signal);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal) throwIfAborted(signal);
      const length = Math.min(64 * 1024, bytes.length - offset);
      const { bytesRead } = await handle.read(bytes, offset, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    if (offset !== before.size || extraBytes !== 0) {
      fail("RACE_BEFORE_WRITE", "The file changed size while it was being read.");
    }
    if (signal) throwIfAborted(signal);
    const after = await handle.stat();
    const pathStats = await stat(resolved.canonicalPath);
    if (!sameMetadata(before, after) || !sameMetadata(after, pathStats)) {
      fail("RACE_BEFORE_WRITE", "The file changed while it was being read.");
    }
    await assertAliasStable(resolved);
    return { bytes, stats: after };
  } finally {
    await handle.close();
  }
}

export async function withPathLock<T>(
  canonicalPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = lockKey(canonicalPath);
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  pathLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

export async function publishReplacement(input: {
  resolved: ResolvedFile;
  expected: StableFile;
  replacement: Uint8Array;
  maxBytes: number;
  signal: AbortSignal;
  consume: () => void;
}): Promise<void> {
  const { resolved, expected, replacement, maxBytes, signal, consume } = input;
  throwIfAborted(signal);
  await assertAliasStable(resolved);
  try {
    await access(resolved.canonicalPath, constants.W_OK);
  } catch {
    fail("UNSUPPORTED_FILE", "The target is not writable.");
  }
  if (process.platform !== "win32" && (expected.stats.mode & 0o222) === 0) {
    fail("UNSUPPORTED_FILE", "The target has no writable permission bits.");
  }
  const beforeTemp = await readStableFile(resolved, maxBytes, true, signal);
  if (
    !sameMetadata(expected.stats, beforeTemp.stats) ||
    !bytesEqual(expected.bytes, beforeTemp.bytes)
  ) {
    fail("RACE_BEFORE_WRITE", "The file changed while edit permission was pending.");
  }

  const temporaryPath = join(
    dirname(resolved.canonicalPath),
    `.${basename(resolved.canonicalPath)}.hashline-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", expected.stats.mode & 0o7777);
    temporaryExists = true;
    try {
      await handle.writeFile(replacement);
      if (process.platform !== "win32") {
        const currentUid = process.getuid?.();
        const currentGid = process.getgid?.();
        if (expected.stats.uid !== currentUid || expected.stats.gid !== currentGid) {
          await handle.chown(expected.stats.uid, expected.stats.gid);
        }
      }
      await handle.chmod(expected.stats.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }

    throwIfAborted(signal);
    await assertAliasStable(resolved);
    const beforeRename = await readStableFile(resolved, maxBytes, true, signal);
    if (
      !sameMetadata(expected.stats, beforeRename.stats) ||
      !bytesEqual(expected.bytes, beforeRename.bytes)
    ) {
      fail("RACE_BEFORE_WRITE", "The file changed before the replacement could be published.");
    }

    consume();
    await rename(temporaryPath, resolved.canonicalPath);
    temporaryExists = false;
    await syncDirectory(dirname(resolved.canonicalPath));

    const verified = await readStableFile(resolved, maxBytes, false, signal);
    if (!bytesEqual(verified.bytes, replacement)) {
      fail("RACE_AFTER_WRITE", "The published file was changed by another writer.");
    }
  } finally {
    if (temporaryExists) await rm(temporaryPath, { force: true });
  }
}

export async function publishNewFile(input: {
  resolved: ResolvedNewFile;
  bytes: Uint8Array;
  signal: AbortSignal;
}): Promise<void> {
  const { resolved, bytes, signal } = input;
  throwIfAborted(signal);
  const currentParent = await realpath(resolved.requestedParent);
  const currentParentStats = await stat(resolved.canonicalParent);
  if (
    !samePath(currentParent, resolved.canonicalParent) ||
    !sameIdentity(currentParentStats, resolved.parentStats)
  ) {
    fail("PATH_MISMATCH", "The target parent directory was retargeted.");
  }

  const temporaryPath = join(
    resolved.canonicalParent,
    `.${basename(resolved.canonicalPath)}.hashline-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o666);
    await handle.writeFile(bytes);
    throwIfAborted(signal);
    await handle.sync();
    await handle.close();

    const verifiedParent = await realpath(resolved.requestedParent);
    const verifiedParentStats = await stat(resolved.canonicalParent);
    if (
      !samePath(verifiedParent, resolved.canonicalParent) ||
      !sameIdentity(verifiedParentStats, resolved.parentStats)
    ) {
      fail("PATH_MISMATCH", "The target parent directory was retargeted.");
    }
    throwIfAborted(signal);
    try {
      await link(temporaryPath, resolved.canonicalPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") fail("TARGET_EXISTS", "The target already exists.");
      throw error;
    }
    await rm(temporaryPath);
    await syncDirectory(resolved.canonicalParent);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

export async function assertTargetAbsent(resolved: ResolvedNewFile): Promise<void> {
  try {
    await lstat(resolved.canonicalPath);
    fail("TARGET_EXISTS", "The target already exists.");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
