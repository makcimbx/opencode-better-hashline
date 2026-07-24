import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
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

export const MAX_NEW_FILE_MISSING_DIRECTORIES = 64;

export type PinnedPathIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

export type NewFileDirectoryAnchor = Readonly<{
  requestedPath: string;
  canonicalPath: string;
  requestedType: "directory" | "symbolic-link";
  requestedIdentity: PinnedPathIdentity;
  canonicalIdentity: PinnedPathIdentity;
}>;

export type PlannedNewFileDirectory = Readonly<{
  requestedPath: string;
  canonicalPath: string;
  requestedParent: string;
  canonicalParent: string;
}>;

export type NewFileParentPlan = Readonly<{
  requestedPath: string;
  requestedAbsolute: string;
  requestedParent: string;
  canonicalParent: string;
  canonicalPath: string;
  anchor: NewFileDirectoryAnchor;
  missingDirectories: readonly PlannedNewFileDirectory[];
  mutationPaths: readonly string[];
  lockPaths: readonly string[];
}>;

export type StableFile = {
  bytes: Uint8Array;
  stats: Stats;
};

const pathLocks = new Map<string, Promise<void>>();

type PathPublicationFenceState = {
  generation: number;
  reservations: number;
};

type PathPublicationFenceReservation = {
  key: string;
  generation: number;
  state: PathPublicationFenceState;
};

const pathPublicationFences = new Map<string, PathPublicationFenceState>();

function reservePathPublicationFences(keys: readonly string[]): PathPublicationFenceReservation[] {
  return keys.map((key) => {
    const state = pathPublicationFences.get(key) ?? { generation: 0, reservations: 0 };
    state.reservations += 1;
    pathPublicationFences.set(key, state);
    return { key, generation: state.generation, state };
  });
}

function releasePathPublicationFences(
  reservations: readonly PathPublicationFenceReservation[],
): void {
  for (const reservation of reservations) {
    reservation.state.reservations -= 1;
    if (
      reservation.state.reservations === 0 &&
      pathPublicationFences.get(reservation.key) === reservation.state
    ) {
      pathPublicationFences.delete(reservation.key);
    }
  }
}

function rawErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

class ObservationError extends HashlineError {
  readonly systemCode: string | undefined;

  constructor(error: unknown) {
    super(
      "RACE_BEFORE_WRITE",
      "A filesystem observation could not be completed safely. No publication occurred; wait for transient filesystem pressure to settle or restore path access before retrying.",
    );
    this.systemCode = rawErrorCode(error);
    this.cause = error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ObservationError ? error.systemCode : rawErrorCode(error);
}

const OBSERVATION_ATTEMPTS = 3;
const OBSERVATION_RETRY_BASE_DELAY_MS = 5;
const RETRYABLE_OBSERVATION_ERRORS = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  ...(process.platform === "win32" ? ["EACCES", "EPERM"] : []),
]);

function isRetryableObservationError(error: unknown): boolean {
  return RETRYABLE_OBSERVATION_ERRORS.has(errorCode(error) ?? "");
}

async function waitForObservationRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const delay = OBSERVATION_RETRY_BASE_DELAY_MS * 2 ** attempt;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectDelay(signal?.reason ?? new Error("The operation was aborted."));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delay);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function retryObservation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    if (signal) throwIfAborted(signal);
    try {
      const result = await operation();
      if (signal) throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof HashlineError) throw error;
      if (!isRetryableObservationError(error) || attempt + 1 === OBSERVATION_ATTEMPTS) {
        throw new ObservationError(error);
      }
      lastError = error;
      await waitForObservationRetry(attempt, signal);
    }
  }
  throw new ObservationError(lastError);
}

async function closeFileHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      await handle.close();
      return;
    } catch (error) {
      if (!isRetryableObservationError(error) || attempt + 1 === OBSERVATION_ATTEMPTS) {
        fail(
          "RACE_BEFORE_WRITE",
          "An internal file handle could not be closed safely. No publication occurred; wait for transient filesystem pressure to settle before retrying.",
        );
      }
      await waitForObservationRetry(attempt);
    }
  }
}

function assertSafePath(path: string, source: "requested" | "canonical"): void {
  const hasControl = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);
  const hasPosixBackslash = process.platform !== "win32" && path.includes("\\");
  const hasWindowsWildcard = process.platform === "win32" && /[*?]/u.test(path);
  let windowsRemainder = path;
  if (process.platform === "win32") {
    if (/^[A-Za-z]:[\\/]/u.test(windowsRemainder)) {
      windowsRemainder = windowsRemainder.slice(2);
    } else if (
      windowsRemainder.startsWith("\\\\?\\") &&
      /^[A-Za-z]:[\\/]/u.test(windowsRemainder.slice(4))
    ) {
      windowsRemainder = windowsRemainder.slice(6);
    }
  }
  const hasWindowsStreamSeparator = process.platform === "win32" && windowsRemainder.includes(":");
  if (
    path.length === 0 ||
    hasControl ||
    hasPosixBackslash ||
    hasWindowsWildcard ||
    hasWindowsStreamSeparator
  ) {
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

export async function canonicalizeRoot(root: string, signal?: AbortSignal): Promise<string> {
  const resolved = resolve(root);
  if (resolved === parse(resolved).root) return resolved;
  return retryObservation(() => realpath(resolved), signal);
}

async function canonicalRoot(root: string, signal?: AbortSignal): Promise<string> {
  try {
    return await canonicalizeRoot(root, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    fail(
      "PATH_MISMATCH",
      "The tool root could not be resolved consistently. No publication occurred; restore path access or repair the active directory/worktree before retrying.",
    );
  }
}

async function isExternal(context: ToolContext, canonicalPath: string): Promise<boolean> {
  const directory = await canonicalRoot(context.directory, context.abort);
  if (isInsideCanonicalPath(directory, canonicalPath)) return false;
  if (context.worktree === "/") return true;
  const worktree = await canonicalRoot(context.worktree, context.abort);
  return !isInsideCanonicalPath(worktree, canonicalPath);
}

async function permissionPaths(
  context: ToolContext,
  canonicalPaths: readonly string[],
): Promise<string[]> {
  const requestedRoot =
    context.worktree === "/" ? parse(resolve(context.directory)).root : context.worktree;
  const worktree = await canonicalRoot(requestedRoot, context.abort);
  return canonicalPaths.map((canonicalPath) => {
    const value = exactRelativePath(worktree, canonicalPath);
    return value === "" ? basename(canonicalPath) : (value ?? canonicalPath);
  });
}

function assertRegular(stats: Stats): void {
  if (!stats.isFile()) fail("UNSUPPORTED_FILE", "Hashline only supports regular files.");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pinIdentity(stats: Stats): PinnedPathIdentity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function matchesPinnedIdentity(stats: Stats, identity: PinnedPathIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
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
  signal?: AbortSignal,
): Promise<ResolvedFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  let canonicalPath: string;
  try {
    canonicalPath = await retryObservation(() => realpath(requestedAbsolute), signal);
  } catch (error) {
    if (errorCode(error) === "ENOENT") fail("PATH_NOT_FOUND", `File not found: ${filePath}`);
    throw error;
  }
  assertSafePath(canonicalPath, "canonical");
  const stats = await retryObservation(() => stat(canonicalPath), signal);
  assertRegular(stats);
  return { requestedPath: filePath, requestedAbsolute, canonicalPath };
}

export async function resolveNewFile(
  filePath: string,
  directory: string,
  missingParentRecovery?: string,
  signal?: AbortSignal,
): Promise<ResolvedNewFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  const requestedParent = dirname(requestedAbsolute);
  let canonicalParent: string;
  try {
    canonicalParent = await retryObservation(() => realpath(requestedParent), signal);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      fail(
        "PATH_NOT_FOUND",
        `Parent directory for ${filePath} does not exist.${missingParentRecovery ? ` ${missingParentRecovery}` : ""}`,
      );
    }
    if (code === "ENOTDIR") {
      fail(
        "UNSUPPORTED_FILE",
        `Parent path for ${filePath} contains a non-directory component. No publication occurred; correct the parent path before retrying.`,
      );
    }
    throw error;
  }
  assertSafePath(canonicalParent, "canonical");
  const parentStats = await retryObservation(() => stat(canonicalParent), signal);
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

type LocatedNewFileAnchor = {
  requestedPath: string;
  canonicalPath: string;
  requestedType: "directory" | "symbolic-link";
  requestedStats: Stats;
  canonicalStats: Stats;
  missingNames: string[];
};

async function locateNewFileAnchor(
  requestedParent: string,
  signal?: AbortSignal,
): Promise<LocatedNewFileAnchor> {
  const missingNames: string[] = [];
  let current = requestedParent;

  while (true) {
    let requestedStats: Stats;
    try {
      requestedStats = await retryObservation(() => lstat(current), signal);
    } catch (error) {
      if (signal) throwIfAborted(signal);
      const code = errorCode(error);
      if (code === "ENOENT") {
        if (missingNames.length === MAX_NEW_FILE_MISSING_DIRECTORIES) {
          fail(
            "INVALID_ARGUMENT",
            `Creating more than ${MAX_NEW_FILE_MISSING_DIRECTORIES} parent directories is not supported.`,
          );
        }
        const parent = dirname(current);
        if (parent === current) {
          fail("PATH_NOT_FOUND", "No existing parent directory could be resolved.");
        }
        missingNames.unshift(basename(current));
        current = parent;
        continue;
      }
      if (code === "ENOTDIR" || code === "ELOOP") {
        fail("UNSUPPORTED_FILE", "A path in the target parent chain is not a directory.");
      }
      if (error instanceof HashlineError) throw error;
      fail("UNSUPPORTED_FILE", "The target parent chain could not be inspected safely.");
    }

    const requestedType = requestedStats.isSymbolicLink()
      ? "symbolic-link"
      : requestedStats.isDirectory()
        ? "directory"
        : undefined;
    if (!requestedType) {
      fail("UNSUPPORTED_FILE", "A path in the target parent chain is not a directory.");
    }

    let canonicalPath: string;
    try {
      canonicalPath = await retryObservation(() => realpath(current), signal);
    } catch (error) {
      if (signal) throwIfAborted(signal);
      if (
        requestedType === "symbolic-link" &&
        ["ENOENT", "ELOOP"].includes(errorCode(error) ?? "")
      ) {
        fail("UNSUPPORTED_FILE", "A path in the target parent chain is a dangling symbolic link.");
      }
      if (error instanceof HashlineError) throw error;
      fail("UNSUPPORTED_FILE", "The existing target ancestor could not be resolved safely.");
    }
    assertSafePath(canonicalPath, "canonical");

    let requestedAfter: Stats;
    let requestedCanonical: string;
    let canonicalDirect: Stats;
    let canonicalAfter: Stats;
    let canonicalSelf: string;
    try {
      [requestedAfter, requestedCanonical, canonicalDirect, canonicalAfter, canonicalSelf] =
        await retryObservation(
          () =>
            Promise.all([
              lstat(current),
              realpath(current),
              lstat(canonicalPath),
              stat(canonicalPath),
              realpath(canonicalPath),
            ]),
          signal,
        );
    } catch {
      if (signal) throwIfAborted(signal);
      fail("PATH_MISMATCH", "The existing target ancestor changed while it was being resolved.");
    }

    const requestedTypeAfter = requestedAfter.isSymbolicLink()
      ? "symbolic-link"
      : requestedAfter.isDirectory()
        ? "directory"
        : undefined;
    if (!canonicalDirect.isDirectory() || !canonicalAfter.isDirectory()) {
      fail("UNSUPPORTED_FILE", "The deepest existing target ancestor is not a directory.");
    }
    if (
      requestedTypeAfter !== requestedType ||
      !sameIdentity(requestedStats, requestedAfter) ||
      !samePath(requestedCanonical, canonicalPath) ||
      !samePath(canonicalSelf, canonicalPath) ||
      !sameIdentity(canonicalDirect, canonicalAfter) ||
      (requestedType === "directory" && !sameIdentity(requestedAfter, canonicalAfter))
    ) {
      fail("PATH_MISMATCH", "The existing target ancestor changed while it was being resolved.");
    }

    return {
      requestedPath: current,
      canonicalPath,
      requestedType,
      requestedStats: requestedAfter,
      canonicalStats: canonicalAfter,
      missingNames,
    };
  }
}

async function verifyNewFilePlanAnchor(
  plan: NewFileParentPlan,
  signal?: AbortSignal,
): Promise<Stats> {
  let requestedStats: Stats;
  let requestedCanonical: string;
  let canonicalDirect: Stats;
  let canonicalStats: Stats;
  let canonicalSelf: string;
  try {
    [requestedStats, requestedCanonical, canonicalDirect, canonicalStats, canonicalSelf] =
      await retryObservation(
        () =>
          Promise.all([
            lstat(plan.anchor.requestedPath),
            realpath(plan.anchor.requestedPath),
            lstat(plan.anchor.canonicalPath),
            stat(plan.anchor.canonicalPath),
            realpath(plan.anchor.canonicalPath),
          ]),
        signal,
      );
  } catch {
    if (signal) throwIfAborted(signal);
    fail("PATH_MISMATCH", "The existing target ancestor could not be revalidated.");
  }

  const requestedType = requestedStats.isSymbolicLink()
    ? "symbolic-link"
    : requestedStats.isDirectory()
      ? "directory"
      : undefined;
  if (
    requestedType !== plan.anchor.requestedType ||
    !matchesPinnedIdentity(requestedStats, plan.anchor.requestedIdentity) ||
    !samePath(requestedCanonical, plan.anchor.canonicalPath) ||
    !canonicalDirect.isDirectory() ||
    !canonicalStats.isDirectory() ||
    !samePath(canonicalSelf, plan.anchor.canonicalPath) ||
    !sameIdentity(canonicalDirect, canonicalStats) ||
    !matchesPinnedIdentity(canonicalStats, plan.anchor.canonicalIdentity) ||
    (requestedType === "directory" && !sameIdentity(requestedStats, canonicalStats))
  ) {
    fail("PATH_MISMATCH", "The existing target ancestor was retargeted or replaced.");
  }
  return canonicalStats;
}

async function assertPlannedPathsAbsent(
  paths: readonly string[],
  target: boolean,
  signal?: AbortSignal,
): Promise<void> {
  for (const path of new Set(paths)) {
    try {
      await retryObservation(() => lstat(path), signal);
    } catch (error) {
      if (signal) throwIfAborted(signal);
      if (errorCode(error) === "ENOENT") continue;
      if (errorCode(error) === "ENOTDIR") {
        fail(
          "RACE_BEFORE_WRITE",
          "The planned parent chain is no longer absent. No publication occurred; rebuild the plan before retrying.",
        );
      }
      if (error instanceof HashlineError) throw error;
      fail("UNSUPPORTED_FILE", "A planned path absence could not be verified safely.");
    }
    if (target) {
      fail(
        "TARGET_EXISTS",
        "The target already exists; create and move operations never overwrite. Inspect it and choose an absent target.",
      );
    }
    fail(
      "RACE_BEFORE_WRITE",
      "A planned parent directory path already exists. No publication occurred; rebuild the plan before retrying.",
    );
  }
}

async function revalidateNewFileParentPlanInternal(
  plan: NewFileParentPlan,
  signal?: AbortSignal,
): Promise<Stats> {
  await verifyNewFilePlanAnchor(plan, signal);
  for (const directory of plan.missingDirectories) {
    await assertPlannedPathsAbsent(
      [directory.requestedPath, directory.canonicalPath],
      false,
      signal,
    );
  }
  await assertPlannedPathsAbsent([plan.requestedAbsolute, plan.canonicalPath], true, signal);
  return verifyNewFilePlanAnchor(plan, signal);
}

export async function resolveNewFileParentPlan(
  filePath: string,
  directory: string,
  signal?: AbortSignal,
): Promise<NewFileParentPlan> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  assertSafePath(requestedAbsolute, "requested");
  const requestedParent = dirname(requestedAbsolute);
  const located = await locateNewFileAnchor(requestedParent, signal);
  const anchor: NewFileDirectoryAnchor = Object.freeze({
    requestedPath: located.requestedPath,
    canonicalPath: located.canonicalPath,
    requestedType: located.requestedType,
    requestedIdentity: pinIdentity(located.requestedStats),
    canonicalIdentity: pinIdentity(located.canonicalStats),
  });

  let plannedRequestedParent = anchor.requestedPath;
  let plannedCanonicalParent = anchor.canonicalPath;
  const missingDirectories = Object.freeze(
    located.missingNames.map((name): PlannedNewFileDirectory => {
      const requestedPath = join(plannedRequestedParent, name);
      const canonicalPath = join(plannedCanonicalParent, name);
      assertSafePath(requestedPath, "requested");
      assertSafePath(canonicalPath, "canonical");
      const planned = Object.freeze({
        requestedPath,
        canonicalPath,
        requestedParent: plannedRequestedParent,
        canonicalParent: plannedCanonicalParent,
      });
      plannedRequestedParent = requestedPath;
      plannedCanonicalParent = canonicalPath;
      return planned;
    }),
  );
  const canonicalPath = join(plannedCanonicalParent, basename(requestedAbsolute));
  assertSafePath(canonicalPath, "canonical");
  const mutationPaths = Object.freeze([
    ...missingDirectories.map((entry) => entry.canonicalPath),
    canonicalPath,
  ]);
  const plan: NewFileParentPlan = Object.freeze({
    requestedPath: filePath,
    requestedAbsolute,
    requestedParent,
    canonicalParent: plannedCanonicalParent,
    canonicalPath,
    anchor,
    missingDirectories,
    mutationPaths,
    lockPaths: mutationPaths,
  });
  await revalidateNewFileParentPlanInternal(plan, signal);
  return plan;
}

export async function revalidateNewFileParentPlan(
  plan: NewFileParentPlan,
  signal?: AbortSignal,
): Promise<void> {
  await revalidateNewFileParentPlanInternal(plan, signal);
}

async function plannedPathExists(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await retryObservation(() => lstat(path), signal);
    return true;
  } catch (error) {
    if (signal) throwIfAborted(signal);
    const code = errorCode(error);
    if (code === "ENOENT") return false;
    if (code === "ENOTDIR" || code === "ELOOP") {
      fail(
        "RACE_BEFORE_WRITE",
        "The planned parent chain changed before publication. No publication occurred.",
      );
    }
    if (error instanceof HashlineError) throw error;
    fail("UNSUPPORTED_FILE", "A planned parent path could not be inspected safely.");
  }
}

export async function stabilizeNewFileParentPlan(
  plan: NewFileParentPlan,
  signal?: AbortSignal,
): Promise<NewFileParentPlan> {
  if (signal) throwIfAborted(signal);
  let parentStats = await verifyNewFilePlanAnchor(plan, signal);
  const adoptedStats: Stats[] = [];

  for (const directory of plan.missingDirectories) {
    if (signal) throwIfAborted(signal);
    const [requestedExists, canonicalExists] = await Promise.all([
      plannedPathExists(directory.requestedPath, signal),
      plannedPathExists(directory.canonicalPath, signal),
    ]);
    if (!requestedExists && !canonicalExists) break;
    if (!requestedExists || !canonicalExists) {
      fail(
        "RACE_BEFORE_WRITE",
        "A planned parent appeared with an inconsistent path identity. No publication occurred.",
      );
    }
    parentStats = await verifyPlannedNewFileDirectory(directory, parentStats, undefined, signal);
    adoptedStats.push(parentStats);
  }

  if (adoptedStats.length === 0) {
    await revalidateNewFileParentPlanInternal(plan, signal);
    return plan;
  }

  parentStats = await verifyNewFilePlanAnchor(plan, signal);
  for (const [index, expected] of adoptedStats.entries()) {
    const directory = plan.missingDirectories[index];
    if (!directory) {
      fail("PATH_MISMATCH", "The stabilized parent prefix exceeded the reserved plan.");
    }
    parentStats = await verifyPlannedNewFileDirectory(directory, parentStats, expected, signal);
  }

  const lastDirectory = plan.missingDirectories[adoptedStats.length - 1];
  if (!lastDirectory) {
    fail("PATH_MISMATCH", "The stabilized parent prefix is missing from the reserved plan.");
  }
  const anchor: NewFileDirectoryAnchor = Object.freeze({
    requestedPath: lastDirectory.requestedPath,
    canonicalPath: lastDirectory.canonicalPath,
    requestedType: "directory",
    requestedIdentity: pinIdentity(parentStats),
    canonicalIdentity: pinIdentity(parentStats),
  });
  const missingDirectories = Object.freeze(plan.missingDirectories.slice(adoptedStats.length));
  const mutationPaths = Object.freeze([
    ...missingDirectories.map((entry) => entry.canonicalPath),
    plan.canonicalPath,
  ]);
  const stabilized: NewFileParentPlan = Object.freeze({
    ...plan,
    anchor,
    missingDirectories,
    mutationPaths,
    lockPaths: plan.lockPaths,
  });
  await revalidateNewFileParentPlanInternal(stabilized, signal);
  return stabilized;
}

export async function resolveMutableFile(
  filePath: string,
  directory: string,
  signal?: AbortSignal,
): Promise<ResolvedMutableFile> {
  const requestedAbsolute = absoluteFrom(filePath, directory);
  let terminalStats: Stats;
  try {
    terminalStats = await retryObservation(() => lstat(requestedAbsolute), signal);
  } catch (error) {
    if (errorCode(error) === "ENOENT") fail("PATH_NOT_FOUND", `File not found: ${filePath}`);
    throw error;
  }
  if (terminalStats.isSymbolicLink()) {
    fail("UNSUPPORTED_FILE", "Deleting or moving terminal symbolic links is not supported.");
  }
  assertRegular(terminalStats);

  const requestedParent = dirname(requestedAbsolute);
  const [canonicalPath, canonicalParent] = await retryObservation(
    () => Promise.all([realpath(requestedAbsolute), realpath(requestedParent)]),
    signal,
  );
  assertSafePath(canonicalPath, "canonical");
  assertSafePath(canonicalParent, "canonical");
  if (!pathsAlias(dirname(canonicalPath), canonicalParent)) {
    fail("PATH_MISMATCH", "The source parent does not resolve to the file parent.");
  }
  const [parentStats, terminalAfter, canonicalStats] = await retryObservation(
    () => Promise.all([stat(canonicalParent), lstat(requestedAbsolute), stat(canonicalPath)]),
    signal,
  );
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

function sameResolvedEnvelope(
  previous: ResolvedMutableFile | ResolvedNewFile,
  current: ResolvedMutableFile | ResolvedNewFile,
): boolean {
  return (
    samePath(previous.requestedAbsolute, current.requestedAbsolute) &&
    samePath(previous.requestedParent, current.requestedParent) &&
    samePath(previous.canonicalParent, current.canonicalParent) &&
    samePath(previous.canonicalPath, current.canonicalPath)
  );
}

export async function stabilizeMutableFile(
  resolved: ResolvedMutableFile,
  directory: string,
  signal?: AbortSignal,
): Promise<ResolvedMutableFile> {
  if (signal) throwIfAborted(signal);
  const current = await resolveMutableFile(resolved.requestedPath, directory, signal);
  if (!sameResolvedEnvelope(resolved, current)) {
    fail(
      "PATH_MISMATCH",
      "The source path or its canonical parent changed while the operation was waiting. No publication occurred.",
    );
  }
  return current;
}

export async function stabilizeNewFile(
  resolved: ResolvedNewFile,
  directory: string,
  signal?: AbortSignal,
): Promise<ResolvedNewFile> {
  if (signal) throwIfAborted(signal);
  const current = await resolveNewFile(resolved.requestedPath, directory, undefined, signal);
  if (!sameResolvedEnvelope(resolved, current)) {
    fail(
      "PATH_MISMATCH",
      "The destination path or its canonical parent changed while the operation was waiting. No publication occurred.",
    );
  }
  return current;
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

function pathStabilityMessage(error: "PATH_MISMATCH" | "RACE_AFTER_WRITE", detail: string): string {
  return error === "RACE_AFTER_WRITE"
    ? `${detail} Publication may have occurred; inspect the affected paths and take a fresh read before replanning. Do not blindly retry.`
    : detail;
}

async function assertNewParentStable(
  resolved: ResolvedNewFile,
  error: "PATH_MISMATCH" | "RACE_AFTER_WRITE",
  signal?: AbortSignal,
): Promise<void> {
  let currentParent: string;
  let currentParentStats: Stats;
  try {
    [currentParent, currentParentStats] = await retryObservation(
      () => Promise.all([realpath(resolved.requestedParent), stat(resolved.canonicalParent)]),
      signal,
    );
  } catch {
    if (signal) throwIfAborted(signal);
    fail(error, pathStabilityMessage(error, "The target parent directory could not be verified."));
  }
  if (
    !samePath(currentParent, resolved.canonicalParent) ||
    !sameIdentity(currentParentStats, resolved.parentStats)
  ) {
    fail(error, pathStabilityMessage(error, "The target parent directory was retargeted."));
  }
}

export async function authorizeRead(context: ToolContext, resolved: ResolvedFile): Promise<void> {
  const pattern =
    (await permissionPaths(context, [resolved.canonicalPath]))[0] ?? resolved.canonicalPath;
  await ask(context, {
    permission: "read",
    patterns: [pattern],
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
  createdDirectories?: readonly string[],
): Promise<void> {
  const patterns = [
    ...new Set(
      await permissionPaths(
        context,
        resolved.map((entry) => entry.canonicalPath),
      ),
    ),
  ];
  await ask(context, {
    permission: "edit",
    patterns,
    always: ["*"],
    metadata: {
      filepath: resolved[0]?.canonicalPath,
      filepaths: resolved.map((entry) => entry.canonicalPath),
      diff,
      ...(createdDirectories ? { createdDirectories: [...createdDirectories] } : {}),
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

export async function assertAliasStable(
  resolved: ResolvedFile,
  signal?: AbortSignal,
): Promise<void> {
  let current: string;
  try {
    current = await retryObservation(() => realpath(resolved.requestedAbsolute), signal);
  } catch {
    if (signal) throwIfAborted(signal);
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
  signal?: AbortSignal,
): Promise<void> {
  await assertAliasStable(resolved, signal);
  let terminalStats: Stats;
  let canonicalStats: Stats;
  try {
    [terminalStats, canonicalStats] = await retryObservation(
      () => Promise.all([lstat(resolved.requestedAbsolute), stat(resolved.canonicalPath)]),
      signal,
    );
  } catch {
    if (signal) throwIfAborted(signal);
    fail(error, pathStabilityMessage(error, "The source path could not be verified."));
  }
  if (
    terminalStats.isSymbolicLink() ||
    !terminalStats.isFile() ||
    !sameIdentity(terminalStats, canonicalStats)
  ) {
    fail(error, pathStabilityMessage(error, "The source path was retargeted."));
  }
}

async function readStableFileOnce(
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
      fail(
        "RACE_BEFORE_WRITE",
        "The file changed size while it was being read. This read published nothing; run a fresh hashline_read and, before mutating, replan against the newly delivered snapshot.",
      );
    }
    if (signal) throwIfAborted(signal);
    const after = await handle.stat();
    const pathStats = await stat(resolved.canonicalPath);
    if (!sameMetadata(before, after) || !sameMetadata(after, pathStats)) {
      fail(
        "RACE_BEFORE_WRITE",
        "The file changed while it was being read. This read published nothing; run a fresh hashline_read and, before mutating, replan against the newly delivered snapshot.",
      );
    }
    await assertAliasStable(resolved, signal);
    return { bytes, stats: after };
  } finally {
    await closeFileHandle(handle);
  }
}

export async function readStableFile(
  resolved: ResolvedFile,
  maxBytes: number,
  rejectHardlinks: boolean,
  signal?: AbortSignal,
): Promise<StableFile> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      return await readStableFileOnce(resolved, maxBytes, rejectHardlinks, signal);
    } catch (error) {
      const retryableRace =
        error instanceof HashlineError &&
        (error.code === "PATH_MISMATCH" ||
          (error.code === "RACE_BEFORE_WRITE" &&
            error.message.includes("while it was being read")));
      if (
        (!retryableRace && !isRetryableObservationError(error)) ||
        attempt + 1 === OBSERVATION_ATTEMPTS
      ) {
        throw error;
      }
      lastError = error;
      await waitForObservationRetry(attempt, signal);
    }
  }
  throw lastError;
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
  const fenceReservations = reservePathPublicationFences(keys);
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
    if (fenceReservations.some(({ generation, state }) => generation !== state.generation)) {
      fail(
        "RACE_BEFORE_WRITE",
        "An overlapping operation partially published while this call was waiting. This call published nothing; inspect and reconcile the affected paths, then issue a fresh call instead of continuing the queued plan.",
      );
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HashlineError && error.code === "PARTIAL_PUBLICATION") {
        for (const reservation of fenceReservations) reservation.state.generation += 1;
      }
      throw error;
    }
  } finally {
    for (const reservation of reservations.toReversed()) {
      reservation.release();
      void reservation.tail.then(() => {
        if (pathLocks.get(reservation.key) === reservation.tail) {
          pathLocks.delete(reservation.key);
        }
      });
    }
    releasePathPublicationFences(fenceReservations);
  }
}
const MOVE_PARTIAL_RECOVERY =
  "Inspect and reconcile both source and destination before retrying. Do not retry until their names match the intended state. Restart the plugin or host if necessary, then run a fresh hashline_read; old snapshots remain unusable.";

function failAfterNewFilePublication(detail: string): never {
  fail(
    "RACE_AFTER_WRITE",
    `${detail} The target file may already be committed; inspect it before retrying. If it exists, take a fresh hashline_read before editing; if it is absent, rebuild the creation plan. Do not blindly retry.`,
  );
}

type TemporaryFile = {
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
};

async function openTemporaryFile(
  canonicalTarget: string,
  mode: number,
  signal: AbortSignal,
): Promise<TemporaryFile> {
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const path = join(
      dirname(canonicalTarget),
      `.${basename(canonicalTarget)}.hashline-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(path, "wx", mode);
      return { path, handle };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  fail(
    "RACE_BEFORE_WRITE",
    "Internal staging names were already occupied. No publication occurred; rerun the operation to allocate a fresh staging name.",
  );
}

async function cleanupOwnedTemporary(path: string, identity: PinnedPathIdentity): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    let current: Stats;
    try {
      current = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (isRetryableObservationError(error) && attempt + 1 < OBSERVATION_ATTEMPTS) {
        lastError = error;
        await waitForObservationRetry(attempt);
        continue;
      }
      throw error;
    }
    if (!matchesPinnedIdentity(current, identity)) return;
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (isRetryableObservationError(error) && attempt + 1 < OBSERVATION_ATTEMPTS) {
        lastError = error;
        await waitForObservationRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function temporaryResolved(path: string): ResolvedFile {
  return { requestedPath: path, requestedAbsolute: path, canonicalPath: path };
}

function unprovenTemporaryError(error: unknown): HashlineError {
  if (error instanceof HashlineError) {
    error.message = `${error.message} Staging ownership could not be proved, so an internal temporary path may remain.`;
    return error;
  }
  return new HashlineError(
    "RACE_BEFORE_WRITE",
    "The internal staging path was created, but exact ownership could not be proved. No target publication occurred, but the temporary path may remain; inspect the parent before retrying.",
  );
}

function appendErrorMessage(error: Error, suffix: string): Error {
  try {
    error.message = `${error.message} ${suffix}`;
    return error;
  } catch {
    return Object.assign(new Error(`${error.message} ${suffix}`, { cause: error }), {
      name: error.name,
    });
  }
}

function normalizePublicationError(
  error: unknown,
  signal: AbortSignal,
  published: boolean,
  subject: string,
): unknown {
  if (error instanceof HashlineError) return error;
  if (!published && signal.aborted) return signal.reason ?? error;
  return new HashlineError(
    published ? "RACE_AFTER_WRITE" : "RACE_BEFORE_WRITE",
    published
      ? `${subject} publication may have occurred, but an unexpected filesystem failure escaped exact verification. Inspect affected paths before retrying; do not blindly retry.`
      : `${subject} preparation failed before publication. No publication occurred; wait for transient filesystem pressure to settle or restore filesystem access before retrying.`,
  );
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
  await assertAliasStable(resolved, signal);
  try {
    await retryObservation(() => access(resolved.canonicalPath, constants.W_OK), signal);
  } catch (error) {
    throwIfAborted(signal);
    if (["EACCES", "EPERM", "EROFS"].includes(errorCode(error) ?? "")) {
      fail("UNSUPPORTED_FILE", "The target is not writable.");
    }
    throw normalizePublicationError(error, signal, false, "Replacement");
  }
  if (process.platform !== "win32" && (expected.stats.mode & 0o222) === 0) {
    fail("UNSUPPORTED_FILE", "The target has no writable permission bits.");
  }
  const beforeTemp = await readStableFile(resolved, maxBytes, true, signal);
  if (
    !sameMetadata(expected.stats, beforeTemp.stats) ||
    !bytesEqual(expected.bytes, beforeTemp.bytes)
  ) {
    fail(
      "RACE_BEFORE_WRITE",
      "The file changed while edit permission was pending. No publication occurred; take a fresh read and replan before retrying.",
    );
  }

  let temporaryPath: string | undefined;
  let temporaryIdentity: PinnedPathIdentity | undefined;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let result: StableFile | undefined;
  let published = false;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    const temporary = await openTemporaryFile(
      resolved.canonicalPath,
      expected.stats.mode & 0o7777,
      signal,
    );
    temporaryPath = temporary.path;
    const stagingHandle = temporary.handle;
    temporaryHandle = stagingHandle;
    temporaryCreated = true;
    const openedStats = await retryObservation(() => stagingHandle.stat());
    temporaryIdentity = pinIdentity(openedStats);
    assertRegular(openedStats);
    await stagingHandle.writeFile(replacement);
    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      const currentGid = process.getgid?.();
      if (expected.stats.uid !== currentUid || expected.stats.gid !== currentGid) {
        await stagingHandle.chown(expected.stats.uid, expected.stats.gid);
      }
    }
    await stagingHandle.chmod(expected.stats.mode & 0o7777);
    await stagingHandle.sync();
    const completeStats = await retryObservation(() => stagingHandle.stat(), signal);
    if (
      !sameIdentity(openedStats, completeStats) ||
      completeStats.size !== replacement.byteLength ||
      completeStats.nlink !== 1
    ) {
      fail(
        "RACE_BEFORE_WRITE",
        "The staged replacement changed before publication. No replacement was published; take a fresh read before retrying.",
      );
    }
    await closeFileHandle(stagingHandle);
    temporaryHandle = undefined;

    let staged: StableFile;
    try {
      staged = await readStableFile(
        temporaryResolved(temporaryPath),
        replacement.byteLength,
        false,
        signal,
      );
    } catch {
      throwIfAborted(signal);
      fail(
        "RACE_BEFORE_WRITE",
        "The staged replacement could not be proved exact before publication. No replacement was published; take a fresh read before retrying.",
      );
    }
    if (
      !matchesPinnedIdentity(staged.stats, temporaryIdentity) ||
      staged.stats.nlink !== 1 ||
      !bytesEqual(staged.bytes, replacement)
    ) {
      fail(
        "RACE_BEFORE_WRITE",
        "The staged replacement changed before publication. No replacement was published; take a fresh read before retrying.",
      );
    }

    throwIfAborted(signal);
    await assertAliasStable(resolved, signal);
    const beforeRename = await readStableFile(resolved, maxBytes, true, signal);
    if (
      !sameMetadata(expected.stats, beforeRename.stats) ||
      !bytesEqual(expected.bytes, beforeRename.bytes)
    ) {
      fail(
        "RACE_BEFORE_WRITE",
        "The file changed before the replacement could be published. No publication occurred; take a fresh read and replan before retrying.",
      );
    }
    throwIfAborted(signal);

    consume();
    const publishedIdentity = temporaryIdentity;
    try {
      await rename(temporaryPath, resolved.canonicalPath);
      published = true;
    } catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")) {
        fail(
          "UNSUPPORTED_FILE",
          "The filesystem could not atomically replace the target. No replacement was published, but the snapshot was consumed; take a fresh read before choosing another workflow.",
        );
      }
      fail(
        "RACE_AFTER_WRITE",
        "Replacement publication returned an unexpected filesystem error. Publication may have occurred; inspect the target and take a fresh read before replanning. Do not blindly retry.",
      );
    }
    temporaryIdentity = undefined;
    temporaryCreated = false;
    try {
      await syncDirectory(dirname(resolved.canonicalPath));
      const verified = await readStableFile(resolved, maxBytes, false, signal);
      if (
        !matchesPinnedIdentity(verified.stats, publishedIdentity) ||
        verified.stats.nlink !== 1 ||
        !bytesEqual(verified.bytes, replacement)
      ) {
        fail(
          "RACE_AFTER_WRITE",
          "The published file was changed by another writer. Publication occurred; inspect the target and take a fresh read before replanning. Do not blindly retry.",
        );
      }
      result = verified;
    } catch (error) {
      if (error instanceof HashlineError && error.code === "RACE_AFTER_WRITE") throw error;
      fail(
        "RACE_AFTER_WRITE",
        "Replacement was published, but post-publication verification failed. Inspect the target and take a fresh read before replanning. Do not blindly retry.",
      );
    }
  } catch (error) {
    hasPrimaryError = true;
    const normalized = normalizePublicationError(error, signal, published, "Replacement");
    primaryError =
      temporaryCreated && temporaryIdentity === undefined
        ? unprovenTemporaryError(normalized)
        : normalized;
  }
  if (temporaryHandle) {
    try {
      await closeFileHandle(temporaryHandle);
      temporaryHandle = undefined;
    } catch (closeError) {
      if (!hasPrimaryError || !(primaryError instanceof Error)) {
        hasPrimaryError = true;
        primaryError = closeError;
      } else {
        primaryError = appendErrorMessage(
          primaryError,
          "Staging handle cleanup also failed; an internal file descriptor may remain open.",
        );
      }
    }
  }
  if (temporaryPath !== undefined && temporaryIdentity !== undefined) {
    try {
      await cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
      temporaryIdentity = undefined;
      temporaryCreated = false;
    } catch (cleanupError) {
      if (!hasPrimaryError) throw cleanupError;
      if (primaryError instanceof Error) {
        primaryError = appendErrorMessage(
          primaryError,
          "Staging cleanup also failed; an owned internal temporary file may remain.",
        );
      }
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (result !== undefined) return result;
  throw new HashlineError(
    "RACE_AFTER_WRITE",
    "Replacement ended without a verified result. Publication may have occurred; inspect the target and take a fresh read before replanning. Do not blindly retry.",
  );
}

export async function publishNewFile(input: {
  resolved: ResolvedNewFile;
  bytes: Uint8Array;
  signal: AbortSignal;
  consume?: () => void;
}): Promise<void> {
  const { resolved, bytes, signal, consume } = input;
  throwIfAborted(signal);
  await assertNewParentStable(resolved, "PATH_MISMATCH", signal);

  let temporaryPath: string | undefined;
  let temporaryIdentity: PinnedPathIdentity | undefined;
  let temporaryCreated = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primaryError: unknown;
  let published = false;
  try {
    const temporary = await openTemporaryFile(resolved.canonicalPath, 0o666, signal);
    temporaryPath = temporary.path;
    const stagingHandle = temporary.handle;
    handle = stagingHandle;
    temporaryCreated = true;
    const openedStats = await retryObservation(() => stagingHandle.stat());
    temporaryIdentity = pinIdentity(openedStats);
    assertRegular(openedStats);
    await stagingHandle.writeFile(bytes);
    throwIfAborted(signal);
    await stagingHandle.sync();
    const completeStats = await retryObservation(() => stagingHandle.stat(), signal);
    assertRegular(completeStats);
    if (
      !sameIdentity(openedStats, completeStats) ||
      completeStats.size !== bytes.byteLength ||
      completeStats.nlink !== 1
    ) {
      fail(
        "RACE_BEFORE_WRITE",
        "The staged file changed before publication. No target publication occurred; rebuild the plan before retrying.",
      );
    }
    await closeFileHandle(stagingHandle);
    handle = undefined;

    let staged: StableFile;
    try {
      staged = await readStableFile(
        temporaryResolved(temporaryPath),
        bytes.byteLength,
        false,
        signal,
      );
    } catch {
      throwIfAborted(signal);
      fail(
        "RACE_BEFORE_WRITE",
        "The staged file could not be proved exact before publication. No target publication occurred; rebuild the plan before retrying.",
      );
    }
    if (
      !matchesPinnedIdentity(staged.stats, temporaryIdentity) ||
      staged.stats.nlink !== 1 ||
      !bytesEqual(staged.bytes, bytes)
    ) {
      fail(
        "RACE_BEFORE_WRITE",
        "The staged file changed before publication. No target publication occurred; rebuild the plan before retrying.",
      );
    }
    await assertNewParentStable(resolved, "PATH_MISMATCH", signal);
    throwIfAborted(signal);
    consume?.();
    try {
      await link(temporaryPath, resolved.canonicalPath);
      published = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        fail(
          "TARGET_EXISTS",
          "The target appeared before no-replace publication; create operations never overwrite. Inspect it and choose an absent target before retrying.",
        );
      }
      if (
        ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV", "EMLINK"].includes(
          errorCode(error) ?? "",
        )
      ) {
        fail(
          "UNSUPPORTED_FILE",
          "The filesystem cannot publish a no-replace hard link. No target was published; choose another supported filesystem workflow.",
        );
      }
      failAfterNewFilePublication(
        "The target link operation returned an unexpected filesystem error.",
      );
    }

    let linkedStats: Stats;
    let stagedAfterLink: Stats;
    try {
      [linkedStats, stagedAfterLink] = await retryObservation(
        () => Promise.all([lstat(resolved.canonicalPath), lstat(temporaryPath as string)]),
        signal,
      );
    } catch {
      failAfterNewFilePublication("The created file changed before it could be verified.");
    }
    if (
      !sameIdentity(staged.stats, linkedStats) ||
      !sameIdentity(staged.stats, stagedAfterLink) ||
      linkedStats.nlink !== 2 ||
      stagedAfterLink.nlink !== 2
    ) {
      failAfterNewFilePublication("The created file identity changed during publication.");
    }

    try {
      await cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
      temporaryIdentity = undefined;
      temporaryCreated = false;
    } catch {
      failAfterNewFilePublication("The created file was committed but staging cleanup failed.");
    }
    await syncDirectory(resolved.canonicalParent);

    let verified: StableFile;
    try {
      verified = await readStableFile(resolved, bytes.byteLength, false, signal);
    } catch {
      failAfterNewFilePublication("The created file could not be verified after publication.");
    }
    if (
      !sameIdentity(staged.stats, verified.stats) ||
      verified.stats.nlink !== 1 ||
      !bytesEqual(verified.bytes, bytes)
    ) {
      failAfterNewFilePublication("The created file changed after publication.");
    }
    await assertNewParentStable(resolved, "RACE_AFTER_WRITE");
  } catch (error) {
    const normalized = normalizePublicationError(error, signal, published, "File creation");
    primaryError =
      temporaryCreated && temporaryIdentity === undefined
        ? unprovenTemporaryError(normalized)
        : normalized;
  } finally {
    if (handle) {
      try {
        await closeFileHandle(handle);
        handle = undefined;
      } catch (error) {
        if (primaryError instanceof Error) {
          primaryError = appendErrorMessage(
            primaryError,
            "Staging handle cleanup also failed; an internal file descriptor may remain open.",
          );
        } else {
          primaryError = error;
        }
      }
    }
    if (temporaryPath !== undefined && temporaryIdentity !== undefined) {
      try {
        await cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
        temporaryCreated = false;
      } catch (error) {
        if (primaryError instanceof Error) {
          primaryError = appendErrorMessage(
            primaryError,
            "Staging cleanup also failed; an owned internal temporary file may remain.",
          );
        } else {
          primaryError = error;
        }
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

async function verifyPlannedNewFileDirectory(
  directory: PlannedNewFileDirectory,
  expectedParent: Stats,
  expectedDirectory?: Stats,
  signal?: AbortSignal,
): Promise<Stats> {
  const [
    requestedCanonical,
    canonicalSelf,
    requestedStats,
    canonicalDirect,
    canonicalStats,
    requestedParentCanonical,
    canonicalParentSelf,
    parentDirect,
    parentStats,
  ] = await retryObservation(
    () =>
      Promise.all([
        realpath(directory.requestedPath),
        realpath(directory.canonicalPath),
        lstat(directory.requestedPath),
        lstat(directory.canonicalPath),
        stat(directory.canonicalPath),
        realpath(directory.requestedParent),
        realpath(directory.canonicalParent),
        lstat(directory.canonicalParent),
        stat(directory.canonicalParent),
      ]),
    signal,
  );
  if (
    !samePath(requestedCanonical, directory.canonicalPath) ||
    !samePath(canonicalSelf, directory.canonicalPath) ||
    !requestedStats.isDirectory() ||
    !canonicalDirect.isDirectory() ||
    !canonicalStats.isDirectory() ||
    !sameIdentity(requestedStats, canonicalStats) ||
    !sameIdentity(canonicalDirect, canonicalStats) ||
    (expectedDirectory !== undefined && !sameIdentity(canonicalStats, expectedDirectory)) ||
    !samePath(requestedParentCanonical, directory.canonicalParent) ||
    !samePath(canonicalParentSelf, directory.canonicalParent) ||
    !parentDirect.isDirectory() ||
    !parentStats.isDirectory() ||
    !sameIdentity(parentDirect, parentStats) ||
    !sameIdentity(parentStats, expectedParent)
  ) {
    fail("PATH_MISMATCH", "A created parent directory or its immediate parent changed identity.");
  }
  return canonicalStats;
}

async function verifyCreatedNewFileDirectories(
  plan: NewFileParentPlan,
  createdStats: readonly Stats[],
): Promise<Stats> {
  let parentStats = await verifyNewFilePlanAnchor(plan);
  for (const [index, expected] of createdStats.entries()) {
    const directory = plan.missingDirectories[index];
    if (!directory) {
      fail("PATH_MISMATCH", "The created parent chain exceeded the fixed plan.");
    }
    parentStats = await verifyPlannedNewFileDirectory(directory, parentStats, expected);
  }
  return parentStats;
}

function failBeforeParentCreation(error: unknown): never {
  const code = errorCode(error);
  if (code === "EEXIST") {
    fail(
      "RACE_BEFORE_WRITE",
      "A planned parent directory appeared before exclusive creation. No directory or target was published by this call; rebuild the fixed plan before retrying.",
    );
  }
  if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? "")) {
    fail("PATH_MISMATCH", "The planned parent chain changed before directory creation.");
  }
  fail("UNSUPPORTED_FILE", "A planned parent directory could not be created exclusively.");
}

function failPartialParentCreation(): never {
  fail(
    "PARTIAL_PUBLICATION",
    "Parent creation started but could not complete safely. Created directories are intentionally retained, and the target file may or may not exist. Inspect and reconcile the requested tree and target before retrying; restart the plugin or host if necessary, then run a fresh hashline_read. Old snapshots remain unusable.",
  );
}

export async function publishNewFileWithParents(input: {
  plan: NewFileParentPlan;
  bytes: Uint8Array;
  signal: AbortSignal;
  consume?: () => void;
}): Promise<void> {
  const { plan, signal } = input;
  const bytes = input.bytes.slice();
  const createdStats: Stats[] = [];
  let createdAnyDirectory = false;
  let consumed = false;
  const consume = (): void => {
    if (consumed) return;
    consumed = true;
    input.consume?.();
  };

  try {
    throwIfAborted(signal);
    let parentStats = await revalidateNewFileParentPlanInternal(plan);

    for (const directory of plan.missingDirectories) {
      parentStats = await verifyCreatedNewFileDirectories(plan, createdStats);
      await assertPlannedPathsAbsent([directory.requestedPath, directory.canonicalPath], false);
      throwIfAborted(signal);
      try {
        consume();
        await mkdir(directory.canonicalPath, { recursive: false, mode: 0o777 });
      } catch (error) {
        try {
          await assertPlannedPathsAbsent([directory.requestedPath, directory.canonicalPath], false);
        } catch {
          createdAnyDirectory = true;
          throw error;
        }
        failBeforeParentCreation(error);
      }
      createdAnyDirectory = true;
      parentStats = await verifyPlannedNewFileDirectory(directory, parentStats);
      createdStats.push(parentStats);
    }

    if (createdStats.length > 0) {
      parentStats = await verifyCreatedNewFileDirectories(plan, createdStats);
      await assertPlannedPathsAbsent([plan.requestedAbsolute, plan.canonicalPath], true);
      throwIfAborted(signal);
    }

    const resolved: ResolvedNewFile = {
      requestedPath: plan.requestedPath,
      requestedAbsolute: plan.requestedAbsolute,
      requestedParent: plan.requestedParent,
      canonicalParent: plan.canonicalParent,
      parentStats,
      canonicalPath: plan.canonicalPath,
    };
    await publishNewFile({ resolved, bytes, signal, consume });

    if (createdStats.length > 0) {
      throwIfAborted(signal);
      await verifyCreatedNewFileDirectories(plan, createdStats);
    }
  } catch (error) {
    if (!createdAnyDirectory) throw error;
    failPartialParentCreation();
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
  await assertNewParentStable(resolved, "PATH_MISMATCH", signal);
  await assertMutableStable(resolved, "PATH_MISMATCH", signal);
  const current = await readStableFile(resolved, maxBytes, true, signal);
  if (!sameMetadata(expected.stats, current.stats) || !bytesEqual(expected.bytes, current.bytes)) {
    fail(
      "RACE_BEFORE_WRITE",
      "The file changed while delete permission was pending. No deletion occurred; take a fresh read and replan before retrying.",
    );
  }
  await assertNewParentStable(resolved, "PATH_MISMATCH", signal);
  await assertMutableStable(resolved, "PATH_MISMATCH", signal);
  throwIfAborted(signal);
  consume();
  try {
    await unlink(resolved.canonicalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      fail(
        "RACE_BEFORE_WRITE",
        "The file disappeared during delete publication. This call did not remove it, but the snapshot was consumed; inspect the path and take a fresh read before replanning.",
      );
    }
    if (
      ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EBUSY"].includes(
        errorCode(error) ?? "",
      )
    ) {
      fail(
        "UNSUPPORTED_FILE",
        "The filesystem could not delete the file. No deletion was reported, but the snapshot was consumed; take a fresh read before another workflow.",
      );
    }
    fail(
      "RACE_AFTER_WRITE",
      "Delete publication returned an unexpected filesystem error. Deletion may have occurred; inspect the path and take a fresh read before replanning. Do not blindly retry.",
    );
  }
  await syncDirectory(resolved.canonicalParent);
  try {
    await retryObservation(() => lstat(resolved.canonicalPath));
    fail(
      "RACE_AFTER_WRITE",
      "The deleted path exists after publication. Deletion and recreation may both have occurred; inspect the path and take a fresh read before replanning.",
    );
  } catch (error) {
    if (error instanceof HashlineError && !(error instanceof ObservationError)) throw error;
    if (errorCode(error) !== "ENOENT") {
      fail(
        "RACE_AFTER_WRITE",
        "The deleted path could not be verified. Deletion may have occurred; inspect the path and take a fresh read before replanning. Do not blindly retry.",
      );
    }
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
    assertNewParentStable(source, "PATH_MISMATCH", signal),
    assertNewParentStable(destination, "PATH_MISMATCH", signal),
  ]);
  await assertMutableStable(source, "PATH_MISMATCH", signal);
  const current = await readStableFile(source, maxBytes, true, signal);
  if (!sameMetadata(expected.stats, current.stats) || !bytesEqual(expected.bytes, current.bytes)) {
    fail(
      "RACE_BEFORE_WRITE",
      "The file changed while move permission was pending. No move was published; take a fresh read and replan before retrying.",
    );
  }
  await assertTargetAbsent(destination, signal);
  await Promise.all([
    assertNewParentStable(source, "PATH_MISMATCH", signal),
    assertNewParentStable(destination, "PATH_MISMATCH", signal),
  ]);
  await assertMutableStable(source, "PATH_MISMATCH", signal);
  throwIfAborted(signal);
  consume();

  let linked = false;
  try {
    try {
      await link(source.canonicalPath, destination.canonicalPath);
      linked = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        fail(
          "TARGET_EXISTS",
          "The move destination appeared before no-replace publication. No move link was published, but the source snapshot was consumed; inspect the destination, choose an absent path, and take a fresh source read before retrying.",
        );
      }
      if (
        ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EXDEV", "EMLINK"].includes(
          errorCode(error) ?? "",
        )
      ) {
        fail(
          "UNSUPPORTED_FILE",
          "The filesystem cannot publish a no-replace file move. No move was reported, but the source snapshot was consumed; take a fresh source read before another workflow.",
        );
      }
      fail(
        "PARTIAL_PUBLICATION",
        `The destination link operation returned an unexpected filesystem error, so the destination may exist. ${MOVE_PARTIAL_RECOVERY}`,
      );
    }

    const [linkedSource, linkedDestination] = await Promise.all([
      readStableFile(source, maxBytes, false),
      retryObservation(() => lstat(destination.canonicalPath)),
    ]);
    if (
      !sameIdentity(expected.stats, linkedSource.stats) ||
      !sameIdentity(expected.stats, linkedDestination) ||
      linkedSource.stats.nlink !== 2 ||
      linkedDestination.nlink !== 2 ||
      !bytesEqual(expected.bytes, linkedSource.bytes)
    ) {
      fail(
        "PARTIAL_PUBLICATION",
        `The linked move state changed before source removal. ${MOVE_PARTIAL_RECOVERY}`,
      );
    }
    await assertMutableStable(source, "RACE_AFTER_WRITE");

    try {
      await unlink(source.canonicalPath);
    } catch {
      fail(
        "PARTIAL_PUBLICATION",
        `The destination was linked, but the source could not be removed. ${MOVE_PARTIAL_RECOVERY}`,
      );
    }
    const directories = [...new Set([source.canonicalParent, destination.canonicalParent])];
    await Promise.all(directories.map(syncDirectory));

    try {
      await retryObservation(() => lstat(source.canonicalPath));
      fail(
        "PARTIAL_PUBLICATION",
        `The source still exists after move publication. ${MOVE_PARTIAL_RECOVERY}`,
      );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const verified = await readStableFile(destination, maxBytes, false);
    if (
      !sameIdentity(expected.stats, verified.stats) ||
      verified.stats.nlink !== 1 ||
      !bytesEqual(expected.bytes, verified.bytes)
    ) {
      fail(
        "PARTIAL_PUBLICATION",
        `The destination changed after move publication. ${MOVE_PARTIAL_RECOVERY}`,
      );
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
      `Move publication started but could not be verified. ${MOVE_PARTIAL_RECOVERY}`,
    );
  }
}

export async function assertTargetAbsent(
  resolved: ResolvedNewFile,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await retryObservation(() => lstat(resolved.canonicalPath), signal);
    fail(
      "TARGET_EXISTS",
      "The target already exists; create and move operations never overwrite. Inspect it and choose an absent target.",
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
