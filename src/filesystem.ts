import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { access, link, lstat, open, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { fail, HashlineError } from "./errors.js";
import { exactRelativePath, isInsideCanonicalPath } from "./path-identity.js";
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

export type ResolvedMutableFile = ResolvedNewFile;

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
  const hasPosixBackslash = process.platform !== "win32" && path.includes("\\");
  const hasWindowsWildcard = process.platform === "win32" && /[*?]/u.test(path);
  if (path.length === 0 || hasControl || hasPosixBackslash || hasWindowsWildcard) {
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
  return left === right;
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

async function isExternal(context: ToolContext, canonicalPath: string): Promise<boolean> {
  const directory = await canonicalRoot(context.directory);
  if (isInsideCanonicalPath(directory, canonicalPath)) return false;
  if (context.worktree === "/") return true;
  const worktree = await canonicalRoot(context.worktree);
  return !isInsideCanonicalPath(worktree, canonicalPath);
}

function permissionPath(context: ToolContext, canonicalPath: string): string {
  const value = exactRelativePath(context.worktree, canonicalPath);
  return value === "" ? basename(canonicalPath) : (value ?? canonicalPath);
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

export function pathsAlias(left: string, right: string): boolean {
  return lockKey(left) === lockKey(right);
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

export async function resolveMutableFile(
  filePath: string,
  directory: string,
): Promise<ResolvedMutableFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  let terminalStats: Stats;
  try {
    terminalStats = await lstat(requestedAbsolute);
  } catch (error) {
    if (errorCode(error) === "ENOENT") fail("PATH_NOT_FOUND", `File not found: ${filePath}`);
    throw error;
  }
  if (terminalStats.isSymbolicLink()) {
    fail("UNSUPPORTED_FILE", "Deleting or moving terminal symbolic links is not supported.");
  }
  assertRegular(terminalStats);

  const requestedParent = dirname(requestedAbsolute);
  const [canonicalPath, canonicalParent] = await Promise.all([
    realpath(requestedAbsolute),
    realpath(requestedParent),
  ]);
  assertSafePath(canonicalPath, "canonical");
  assertSafePath(canonicalParent, "canonical");
  if (!pathsAlias(dirname(canonicalPath), canonicalParent)) {
    fail("PATH_MISMATCH", "The source parent does not resolve to the file parent.");
  }
  const [parentStats, terminalAfter, canonicalStats] = await Promise.all([
    stat(canonicalParent),
    lstat(requestedAbsolute),
    stat(canonicalPath),
  ]);
  if (!parentStats.isDirectory()) fail("UNSUPPORTED_FILE", "The source parent is not a directory.");
  if (
    terminalAfter.isSymbolicLink() ||
    !terminalAfter.isFile() ||
    !sameIdentity(terminalStats, terminalAfter) ||
    !sameIdentity(terminalAfter, canonicalStats)
  ) {
    fail("PATH_MISMATCH", "The source path changed while it was being resolved.");
  }
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
  const parent = dirname(resolved.canonicalPath);
  const pattern = join(parent, "*");
  const canPersist = !/[*?]/u.test(parent);
  await ask(context, {
    permission: "external_directory",
    patterns: [pattern],
    always: canPersist ? [pattern] : [],
    metadata: {
      filepath: resolved.canonicalPath,
      parentDir: dirname(resolved.canonicalPath),
    },
  });
}

async function assertNewParentStable(
  resolved: ResolvedNewFile,
  error: "PATH_MISMATCH" | "RACE_AFTER_WRITE",
): Promise<void> {
  let currentParent: string;
  let currentParentStats: Stats;
  try {
    [currentParent, currentParentStats] = await Promise.all([
      realpath(resolved.requestedParent),
      stat(resolved.canonicalParent),
    ]);
  } catch {
    fail(error, "The target parent directory could not be verified.");
  }
  if (
    !samePath(currentParent, resolved.canonicalParent) ||
    !sameIdentity(currentParentStats, resolved.parentStats)
  ) {
    fail(error, "The target parent directory was retargeted.");
  }
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
  await authorizeEdits(context, [resolved], diff);
}

export async function authorizeEdits(
  context: ToolContext,
  resolved: readonly ResolvedFile[],
  diff: string,
): Promise<void> {
  const patterns = [
    ...new Set(resolved.map((entry) => permissionPath(context, entry.canonicalPath))),
  ];
  await ask(context, {
    permission: "edit",
    patterns,
    always: ["*"],
    metadata: {
      filepath: resolved[0]?.canonicalPath,
      filepaths: resolved.map((entry) => entry.canonicalPath),
      diff,
    },
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

async function assertMutableStable(
  resolved: ResolvedMutableFile,
  error: "PATH_MISMATCH" | "RACE_AFTER_WRITE",
): Promise<void> {
  await assertAliasStable(resolved);
  let terminalStats: Stats;
  let canonicalStats: Stats;
  try {
    [terminalStats, canonicalStats] = await Promise.all([
      lstat(resolved.requestedAbsolute),
      stat(resolved.canonicalPath),
    ]);
  } catch {
    fail(error, "The source path could not be verified.");
  }
  if (
    terminalStats.isSymbolicLink() ||
    !terminalStats.isFile() ||
    !sameIdentity(terminalStats, canonicalStats)
  ) {
    fail(error, "The source path was retargeted.");
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

async function waitForPathLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolveWait, rejectWait) => {
    const abort = () => rejectWait(signal.reason ?? new Error("The operation was aborted."));
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolveWait();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        rejectWait(error);
      },
    );
  });
}

export async function withPathLock<T>(
  canonicalPath: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withPathLocks([canonicalPath], operation, signal);
}

export async function withPathLocks<T>(
  canonicalPaths: readonly string[],
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const keys = [...new Set(canonicalPaths.map(lockKey))].sort();
  const reservations: Array<{ key: string; release: () => void; tail: Promise<void> }> = [];
  try {
    for (const key of keys) {
      const previous = pathLocks.get(key) ?? Promise.resolve();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const tail = previous.then(() => gate);
      pathLocks.set(key, tail);
      try {
        await waitForPathLock(previous, signal);
      } catch (error) {
        release();
        void tail.then(() => {
          if (pathLocks.get(key) === tail) pathLocks.delete(key);
        });
        throw error;
      }
      reservations.push({ key, release, tail });
    }
    if (signal) throwIfAborted(signal);
    return await operation();
  } finally {
    for (const reservation of reservations.toReversed()) {
      reservation.release();
      void reservation.tail.then(() => {
        if (pathLocks.get(reservation.key) === reservation.tail) {
          pathLocks.delete(reservation.key);
        }
      });
    }
  }
}

export async function publishReplacement(input: {
  resolved: ResolvedFile;
  expected: StableFile;
  replacement: Uint8Array;
  maxBytes: number;
  signal: AbortSignal;
  consume: () => void;
}): Promise<StableFile> {
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
    try {
      await rename(temporaryPath, resolved.canonicalPath);
    } catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")) {
        fail("UNSUPPORTED_FILE", "The filesystem could not atomically replace the target.");
      }
      throw error;
    }
    temporaryExists = false;
    await syncDirectory(dirname(resolved.canonicalPath));

    const verified = await readStableFile(resolved, maxBytes, false, signal);
    if (!bytesEqual(verified.bytes, replacement)) {
      fail("RACE_AFTER_WRITE", "The published file was changed by another writer.");
    }
    return verified;
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
  await assertNewParentStable(resolved, "PATH_MISMATCH");

  const temporaryPath = join(
    resolved.canonicalParent,
    `.${basename(resolved.canonicalPath)}.hashline-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagedStats: Stats | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o666);
    await handle.writeFile(bytes);
    throwIfAborted(signal);
    await handle.sync();
    stagedStats = await handle.stat();
    assertRegular(stagedStats);
    if (stagedStats.size !== bytes.byteLength || stagedStats.nlink !== 1) {
      fail("RACE_BEFORE_WRITE", "The staged file changed before publication.");
    }
    await handle.close();
    handle = undefined;

    const stagedPathStats = await stat(temporaryPath);
    if (
      !sameIdentity(stagedStats, stagedPathStats) ||
      stagedPathStats.size !== bytes.byteLength ||
      stagedPathStats.nlink !== 1
    ) {
      fail("RACE_BEFORE_WRITE", "The staged file changed before publication.");
    }
    await assertNewParentStable(resolved, "PATH_MISMATCH");
    throwIfAborted(signal);
    try {
      await link(temporaryPath, resolved.canonicalPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") fail("TARGET_EXISTS", "The target already exists.");
      if (
        ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV", "EMLINK"].includes(
          errorCode(error) ?? "",
        )
      ) {
        fail("UNSUPPORTED_FILE", "The filesystem cannot publish a no-replace hard link.");
      }
      throw error;
    }

    let linkedStats: Stats;
    let stagedAfterLink: Stats;
    try {
      [linkedStats, stagedAfterLink] = await Promise.all([
        lstat(resolved.canonicalPath),
        stat(temporaryPath),
      ]);
    } catch {
      fail("RACE_AFTER_WRITE", "The created file changed before it could be verified.");
    }
    if (
      !sameIdentity(stagedStats, linkedStats) ||
      !sameIdentity(stagedStats, stagedAfterLink) ||
      linkedStats.nlink !== 2 ||
      stagedAfterLink.nlink !== 2
    ) {
      fail("RACE_AFTER_WRITE", "The created file identity changed during publication.");
    }

    try {
      await rm(temporaryPath);
    } catch {
      fail("RACE_AFTER_WRITE", "The created file was committed but staging cleanup failed.");
    }
    await syncDirectory(resolved.canonicalParent);

    let verified: StableFile;
    try {
      verified = await readStableFile(resolved, bytes.byteLength, false, signal);
    } catch {
      fail("RACE_AFTER_WRITE", "The created file could not be verified after publication.");
    }
    if (
      !sameIdentity(stagedStats, verified.stats) ||
      verified.stats.nlink !== 1 ||
      !bytesEqual(verified.bytes, bytes)
    ) {
      fail("RACE_AFTER_WRITE", "The created file changed after publication.");
    }
    await assertNewParentStable(resolved, "RACE_AFTER_WRITE");
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function publishDeletedFile(input: {
  resolved: ResolvedMutableFile;
  expected: StableFile;
  maxBytes: number;
  signal: AbortSignal;
  consume: () => void;
}): Promise<void> {
  const { resolved, expected, maxBytes, signal, consume } = input;
  throwIfAborted(signal);
  await assertNewParentStable(resolved, "PATH_MISMATCH");
  await assertMutableStable(resolved, "PATH_MISMATCH");
  const current = await readStableFile(resolved, maxBytes, true, signal);
  if (!sameMetadata(expected.stats, current.stats) || !bytesEqual(expected.bytes, current.bytes)) {
    fail("RACE_BEFORE_WRITE", "The file changed while delete permission was pending.");
  }
  await assertNewParentStable(resolved, "PATH_MISMATCH");
  await assertMutableStable(resolved, "PATH_MISMATCH");
  throwIfAborted(signal);
  consume();
  try {
    await unlink(resolved.canonicalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      fail("RACE_BEFORE_WRITE", "The file disappeared during delete publication.");
    }
    if (
      ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EBUSY"].includes(
        errorCode(error) ?? "",
      )
    ) {
      fail("UNSUPPORTED_FILE", "The filesystem could not delete the file.");
    }
    throw error;
  }
  await syncDirectory(resolved.canonicalParent);
  try {
    await lstat(resolved.canonicalPath);
    fail("RACE_AFTER_WRITE", "The deleted path exists after publication.");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await assertNewParentStable(resolved, "RACE_AFTER_WRITE");
}

export async function publishMovedFile(input: {
  source: ResolvedMutableFile;
  destination: ResolvedNewFile;
  expected: StableFile;
  maxBytes: number;
  signal: AbortSignal;
  consume: () => void;
}): Promise<StableFile> {
  const { source, destination, expected, maxBytes, signal, consume } = input;
  if (pathsAlias(source.canonicalPath, destination.canonicalPath)) {
    fail("INVALID_ARGUMENT", "The move destination must differ from the source path.");
  }
  if (expected.stats.dev !== destination.parentStats.dev) {
    fail("UNSUPPORTED_FILE", "Moving files across filesystems is not supported.");
  }
  throwIfAborted(signal);
  await Promise.all([
    assertNewParentStable(source, "PATH_MISMATCH"),
    assertNewParentStable(destination, "PATH_MISMATCH"),
  ]);
  await assertMutableStable(source, "PATH_MISMATCH");
  const current = await readStableFile(source, maxBytes, true, signal);
  if (!sameMetadata(expected.stats, current.stats) || !bytesEqual(expected.bytes, current.bytes)) {
    fail("RACE_BEFORE_WRITE", "The file changed while move permission was pending.");
  }
  await assertTargetAbsent(destination);
  await Promise.all([
    assertNewParentStable(source, "PATH_MISMATCH"),
    assertNewParentStable(destination, "PATH_MISMATCH"),
  ]);
  await assertMutableStable(source, "PATH_MISMATCH");
  throwIfAborted(signal);
  consume();

  let linked = false;
  try {
    try {
      await link(source.canonicalPath, destination.canonicalPath);
      linked = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        fail("TARGET_EXISTS", "The move destination already exists.");
      if (
        ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV", "EMLINK"].includes(
          errorCode(error) ?? "",
        )
      ) {
        fail("UNSUPPORTED_FILE", "The filesystem cannot publish a no-replace file move.");
      }
      throw error;
    }

    const [linkedSource, linkedDestination] = await Promise.all([
      readStableFile(source, maxBytes, false),
      lstat(destination.canonicalPath),
    ]);
    if (
      !sameIdentity(expected.stats, linkedSource.stats) ||
      !sameIdentity(expected.stats, linkedDestination) ||
      linkedSource.stats.nlink !== 2 ||
      linkedDestination.nlink !== 2 ||
      !bytesEqual(expected.bytes, linkedSource.bytes)
    ) {
      fail("PARTIAL_PUBLICATION", "The linked move state changed before source removal.");
    }
    await assertMutableStable(source, "RACE_AFTER_WRITE");

    try {
      await unlink(source.canonicalPath);
    } catch {
      fail(
        "PARTIAL_PUBLICATION",
        "The destination was linked, but the source could not be removed. Inspect both paths before retrying in a new session.",
      );
    }
    const directories = [...new Set([source.canonicalParent, destination.canonicalParent])];
    await Promise.all(directories.map(syncDirectory));

    try {
      await lstat(source.canonicalPath);
      fail("PARTIAL_PUBLICATION", "The source still exists after move publication.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const verified = await readStableFile(destination, maxBytes, false);
    if (
      !sameIdentity(expected.stats, verified.stats) ||
      verified.stats.nlink !== 1 ||
      !bytesEqual(expected.bytes, verified.bytes)
    ) {
      fail("PARTIAL_PUBLICATION", "The destination changed after move publication.");
    }
    await Promise.all([
      assertNewParentStable(source, "RACE_AFTER_WRITE"),
      assertNewParentStable(destination, "RACE_AFTER_WRITE"),
    ]);
    return verified;
  } catch (error) {
    if (!linked || (error instanceof HashlineError && error.code === "PARTIAL_PUBLICATION")) {
      throw error;
    }
    fail(
      "PARTIAL_PUBLICATION",
      "Move publication started but could not be verified. Inspect both paths before retrying in a new session.",
    );
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
