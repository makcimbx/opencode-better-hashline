import { Buffer } from "node:buffer";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fail } from "./errors.js";
import { exactRelativePath } from "./path-identity.js";
import {
  canonicalJson,
  canonicalPathSha256,
  isRendererPathSafe,
  jsonSha256,
  NATIVE_ALIAS_PROTOCOL,
  type NativeAliasOperation,
  type NativeAliasSurface,
} from "./presentation.js";

export const SESSION_HISTORY_LIMIT = 200;
export const SESSION_HISTORY_FETCH_LIMIT = SESSION_HISTORY_LIMIT + 1;
export const SESSION_HISTORY_MAX_PARTS = 2_000;
export const SESSION_HISTORY_MAX_BYTES = 1_048_576;
export const SESSION_BINDING_LIMIT = 4_096;

export type NativeAliasProtocolIdentity = {
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
  worktree: string;
};

export class NativeAliasCurrentCallPendingError extends Error {
  override readonly name = "NativeAliasCurrentCallPendingError";

  constructor() {
    super(
      "SESSION_PROTOCOL_MISMATCH: The current alias call input has not stabilized in session history.",
    );
  }
}

type HistoryOptions = {
  currentCall?: { id: string; tool: NativeAliasSurface; input?: unknown };
  sessionId?: string;
  directory?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export type NativeAliasBindingStatus = "bound" | "unbound" | "mismatch";

export type HashlineDisplayPrefixMatch = {
  operationIndex: number;
  lineIndex: number;
  prefix: string;
};

function numericDisplayPrefix(line: string): "N|" | "N!|" | undefined {
  const first = line.charCodeAt(0);
  if (first < 49 || first > 57) return undefined;
  let index = 1;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code < 48 || code > 57) break;
    index += 1;
  }
  if (line.charCodeAt(index) === 124) return "N|";
  if (line.charCodeAt(index) === 33 && line.charCodeAt(index + 1) === 124) return "N!|";
  return undefined;
}

export function findHashlineDisplayPrefix(
  operationsValue: readonly unknown[],
): HashlineDisplayPrefixMatch | undefined {
  for (const [operationIndex, operationValue] of operationsValue.entries()) {
    const operation = record(operationValue);
    if (!operation || operation.op === "copy_range" || operation.op === "move_range") continue;
    if (!Array.isArray(operation.lines)) continue;
    for (const [lineIndex, line] of operation.lines.entries()) {
      if (typeof line !== "string") continue;
      const prefix =
        numericDisplayPrefix(line) ??
        /^@(?:hashline(?:-edit)?|more|eof|note)(?=\s|$)/u.exec(line)?.[0];
      if (prefix) return { operationIndex, lineIndex, prefix };
    }
  }
  return undefined;
}

export function displayPrefixRejectionMessage(match: HashlineDisplayPrefixMatch): string {
  return `operations[${match.operationIndex}].lines[${match.lineIndex}] starts with ${JSON.stringify(match.prefix)}, which looks copied from hashline_read. Remove the annotation, or retry with top-level allowHashlinePrefixes:true only when that prefix is intentional file content. No file was changed.`;
}

export function buildNativeAliasDisplayPrefixRejectionMetadata(
  toolName: NativeAliasSurface,
  input: unknown,
  identity: NativeAliasProtocolIdentity,
  match: HashlineDisplayPrefixMatch,
): Record<string, unknown> {
  return {
    betterHashlineRejection: {
      protocol: NATIVE_ALIAS_PROTOCOL,
      packageVersion: identity.packageVersion,
      schemaSha256: identity.schemaSha256,
      hostVersion: identity.hostVersion,
      worktreeSha256: canonicalPathSha256(identity.worktree),
      surface: toolName,
      errorCode: "DISPLAY_PREFIX_REJECTED",
      inputSha256: jsonSha256(input),
      operationIndex: match.operationIndex,
      lineIndex: match.lineIndex,
      prefix: match.prefix,
    },
  };
}

function rejectHistory(reason: string): never {
  fail("SESSION_PROTOCOL_MISMATCH", `${reason} Start a new session before editing.`);
}

function rejectOversizedHistory(): never {
  fail(
    "SESSION_PROTOCOL_MISMATCH",
    "OpenCode persisted session history exceeds the bounded inspection window. Start a genuinely new session; do not resume the same task ID.",
  );
}

function assertHistoryBounds(messagesValue: unknown): asserts messagesValue is unknown[] {
  if (!Array.isArray(messagesValue)) rejectHistory("OpenCode session history is unreadable.");
  if (messagesValue.length > SESSION_HISTORY_LIMIT) {
    rejectOversizedHistory();
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(messagesValue);
  } catch {
    rejectHistory("OpenCode session history is unreadable.");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > SESSION_HISTORY_MAX_BYTES
  ) {
    rejectOversizedHistory();
  }
}

function shownPath(identity: NativeAliasProtocolIdentity, canonicalPath: string): string {
  const value = exactRelativePath(identity.worktree, canonicalPath)?.replaceAll("\\", "/");
  if (!isRendererPathSafe(canonicalPath) || (value !== undefined && !isRendererPathSafe(value))) {
    rejectHistory("Completed historical alias renderer path contains a line break.");
  }
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    rejectHistory("Completed historical alias path is outside the bound worktree.");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export type NativeAliasCompletedEvidence = {
  canonicalPath: string;
  operation: NativeAliasOperation;
  destinationCanonicalPath?: string;
};

type ValidatedMarker = {
  canonicalPathSha256: string;
  operation: NativeAliasOperation;
  destinationPathSha256?: string;
};

const PATCH_SEPARATOR = "===================================================================";

function assertPatch(
  patch: string,
  expectedPath: string,
  operation: NativeAliasOperation,
  expectedDestinationPath?: string,
): { additions: number; deletions: number; destinationPath: string } {
  const lines = patch.split("\n");
  let headerIndex = 0;
  if (operation !== "move_file" && lines[0] === `Index: ${expectedPath}`) {
    if (lines[1] !== PATCH_SEPARATOR) {
      rejectHistory("Completed historical alias patch headers are inconsistent.");
    }
    headerIndex = 2;
  } else if (operation === "move_file" && lines[0] === PATCH_SEPARATOR) {
    headerIndex = 1;
  }

  const destinationHeader = lines[headerIndex + 1] ?? "";
  const destinationPrefix = "+++ ";
  const destinationSuffix = "\tafter";
  if (
    lines[headerIndex] !== `--- ${expectedPath}\tbefore` ||
    !destinationHeader.startsWith(destinationPrefix) ||
    !destinationHeader.endsWith(destinationSuffix)
  ) {
    rejectHistory("Completed historical alias patch headers are inconsistent.");
  }
  const destinationPath = destinationHeader.slice(
    destinationPrefix.length,
    -destinationSuffix.length,
  );
  const requiredDestinationPath =
    operation === "move_file" ? expectedDestinationPath : expectedPath;
  if (
    !destinationPath ||
    (requiredDestinationPath !== undefined && destinationPath !== requiredDestinationPath) ||
    (operation === "move_file" && destinationPath === expectedPath)
  ) {
    rejectHistory("Completed historical alias patch headers are inconsistent.");
  }

  let index = headerIndex + 2;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  while (index < lines.length && lines[index] !== "") {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(lines[index] ?? "");
    if (!header) rejectHistory("Completed historical alias patch is malformed.");
    hunks += 1;
    const oldStart = Number(header[1]);
    const oldExpected = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newExpected = header[4] === undefined ? 1 : Number(header[4]);
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldExpected) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newExpected) ||
      oldExpected < 0 ||
      newExpected < 0 ||
      (oldExpected === 0 ? oldStart < 0 : oldStart < 1) ||
      (newExpected === 0 ? newStart < 0 : newStart < 1) ||
      oldStart < previousOldEnd ||
      newStart < previousNewEnd ||
      (operation === "delete_file" &&
        (hunks !== 1 || oldStart !== 1 || oldExpected < 1 || newStart !== 0 || newExpected !== 0))
    ) {
      rejectHistory("Completed historical alias patch hunk ranges are inconsistent.");
    }
    previousOldEnd = oldStart + oldExpected;
    previousNewEnd = newStart + newExpected;
    let oldCount = 0;
    let newCount = 0;
    let newlineMarkerAllowed = false;
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("@@ ") || line === "") break;
      if (line === "\\ No newline at end of file") {
        if (!newlineMarkerAllowed) {
          rejectHistory("Completed historical alias patch is malformed.");
        }
        newlineMarkerAllowed = false;
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        oldCount += 1;
        newCount += 1;
      } else if (line.startsWith("-")) {
        oldCount += 1;
        deletions += 1;
      } else if (line.startsWith("+")) {
        newCount += 1;
        additions += 1;
      } else {
        rejectHistory("Completed historical alias patch is malformed.");
      }
      newlineMarkerAllowed = true;
      index += 1;
    }
    if (oldCount !== oldExpected || newCount !== newExpected) {
      rejectHistory("Completed historical alias patch hunk ranges are inconsistent.");
    }
  }
  const validHunks =
    operation === "update"
      ? hunks > 0
      : operation === "delete_file"
        ? hunks === 0 || (hunks === 1 && additions === 0 && deletions > 0)
        : hunks === 0;
  if (!validHunks || index !== lines.length - 1) {
    rejectHistory("Completed historical alias patch is malformed.");
  }
  return { additions, deletions, destinationPath };
}

function assertMarker(
  toolName: NativeAliasSurface,
  metadata: Record<string, unknown>,
  identity: NativeAliasProtocolIdentity,
): ValidatedMarker {
  const marker = record(metadata.betterHashline);
  if (!marker) rejectHistory(`Completed historical ${toolName} has no Better Hashline marker.`);
  const operation = marker.operation;
  if (operation !== "update" && operation !== "delete_file" && operation !== "move_file") {
    rejectHistory(`Completed historical ${toolName} uses an incompatible protocol marker.`);
  }
  const markerKeys = [
    "canonicalPathSha256",
    "hostVersion",
    "operation",
    "packageVersion",
    "protocol",
    "schemaSha256",
    "surface",
  ];
  if (operation === "move_file") markerKeys.push("destinationPathSha256");
  if (
    !exactKeys(marker, markerKeys) ||
    marker.protocol !== NATIVE_ALIAS_PROTOCOL ||
    marker.packageVersion !== identity.packageVersion ||
    marker.schemaSha256 !== identity.schemaSha256 ||
    marker.hostVersion !== identity.hostVersion ||
    marker.surface !== toolName ||
    typeof marker.canonicalPathSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(marker.canonicalPathSha256) ||
    (operation === "move_file" &&
      (typeof marker.destinationPathSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(marker.destinationPathSha256)))
  ) {
    rejectHistory(`Completed historical ${toolName} uses an incompatible protocol marker.`);
  }
  return {
    canonicalPathSha256: marker.canonicalPathSha256,
    operation,
    ...(operation === "move_file"
      ? { destinationPathSha256: marker.destinationPathSha256 as string }
      : {}),
  };
}

function canonicalPathFromShown(
  identity: NativeAliasProtocolIdentity,
  relativePath: string,
): string {
  const canonicalPath = resolve(identity.worktree, relativePath);
  if (shownPath(identity, canonicalPath) !== relativePath) {
    rejectHistory("Completed historical alias destination path is inconsistent.");
  }
  return canonicalPath;
}

function assertCounts(
  metadata: { patch: string; additions: unknown; deletions: unknown },
  expectedPath: string,
  operation: NativeAliasOperation,
  expectedDestinationPath?: string,
): string {
  if (
    !Number.isSafeInteger(metadata.additions) ||
    (metadata.additions as number) < 0 ||
    !Number.isSafeInteger(metadata.deletions) ||
    (metadata.deletions as number) < 0
  ) {
    rejectHistory("Completed historical alias metadata has invalid change counts.");
  }
  const counts = assertPatch(metadata.patch, expectedPath, operation, expectedDestinationPath);
  if (metadata.additions !== counts.additions || metadata.deletions !== counts.deletions) {
    rejectHistory("Completed historical alias metadata has inconsistent change counts.");
  }
  return counts.destinationPath;
}

function assertCompletedMetadata(
  toolName: NativeAliasSurface,
  metadataValue: unknown,
  identity: NativeAliasProtocolIdentity,
): NativeAliasCompletedEvidence {
  const metadata = record(metadataValue);
  const diagnostics = record(metadata?.diagnostics);
  if (!metadata || !diagnostics || Object.keys(diagnostics).length !== 0) {
    rejectHistory(`Completed historical ${toolName} metadata is unreadable.`);
  }
  const marker = assertMarker(toolName, metadata, identity);
  const metadataKeys =
    toolName === "edit"
      ? ["betterHashline", "diagnostics", "diff", "filediff", "truncated"]
      : ["betterHashline", "diagnostics", "files", "truncated"];
  const keysWithoutHostEnvelope = metadataKeys.filter((key) => key !== "truncated");
  if (
    (!exactKeys(metadata, metadataKeys) && !exactKeys(metadata, keysWithoutHostEnvelope)) ||
    ("truncated" in metadata && metadata.truncated !== false)
  ) {
    rejectHistory(`Completed historical ${toolName} metadata has unexpected fields.`);
  }

  if (toolName === "edit") {
    const filediff = record(metadata.filediff);
    if (
      typeof metadata.diff !== "string" ||
      !filediff ||
      typeof filediff.file !== "string" ||
      typeof filediff.patch !== "string" ||
      filediff.patch !== metadata.diff ||
      !exactKeys(filediff, ["additions", "deletions", "file", "patch"])
    ) {
      rejectHistory("Completed historical edit metadata is unreadable.");
    }
    const expectedPath = shownPath(identity, filediff.file);
    const destinationRelativePath = assertCounts(
      { patch: filediff.patch, additions: filediff.additions, deletions: filediff.deletions },
      expectedPath,
      marker.operation,
    );
    const destinationCanonicalPath =
      marker.operation === "move_file"
        ? canonicalPathFromShown(identity, destinationRelativePath)
        : undefined;
    if (
      marker.canonicalPathSha256 !== canonicalPathSha256(filediff.file) ||
      (marker.operation === "move_file" &&
        marker.destinationPathSha256 !== canonicalPathSha256(destinationCanonicalPath as string))
    ) {
      rejectHistory("Completed historical edit path metadata is inconsistent.");
    }
    return {
      canonicalPath: filediff.file,
      operation: marker.operation,
      ...(destinationCanonicalPath ? { destinationCanonicalPath } : {}),
    };
  }

  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    rejectHistory("Completed historical apply_patch metadata is unreadable.");
  }
  const file = record(metadata.files[0]);
  const expectedType =
    marker.operation === "delete_file"
      ? "delete"
      : marker.operation === "move_file"
        ? "move"
        : "update";
  const fileKeys = ["additions", "deletions", "filePath", "patch", "relativePath", "type"];
  if (marker.operation === "move_file") fileKeys.push("movePath");
  if (
    !file ||
    typeof file.filePath !== "string" ||
    typeof file.relativePath !== "string" ||
    file.type !== expectedType ||
    typeof file.patch !== "string" ||
    !exactKeys(file, fileKeys) ||
    (marker.operation === "move_file" && typeof file.movePath !== "string")
  ) {
    rejectHistory("Completed historical apply_patch metadata is unreadable.");
  }
  const expectedSourceRelative = shownPath(identity, file.filePath);
  const destinationCanonicalPath =
    marker.operation === "move_file" ? (file.movePath as string) : undefined;
  const expectedRelative = destinationCanonicalPath
    ? shownPath(identity, destinationCanonicalPath)
    : expectedSourceRelative;
  assertCounts(
    { patch: file.patch, additions: file.additions, deletions: file.deletions },
    expectedSourceRelative,
    marker.operation,
    expectedRelative,
  );
  if (
    marker.canonicalPathSha256 !== canonicalPathSha256(file.filePath) ||
    file.relativePath !== expectedRelative ||
    (marker.operation === "move_file" &&
      (destinationCanonicalPath === file.filePath ||
        marker.destinationPathSha256 !== canonicalPathSha256(destinationCanonicalPath as string)))
  ) {
    rejectHistory("Completed historical apply_patch path metadata is inconsistent.");
  }
  return {
    canonicalPath: file.filePath,
    operation: marker.operation,
    ...(destinationCanonicalPath ? { destinationCanonicalPath } : {}),
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validLineNumber(value: unknown, allowZero = false): boolean {
  return Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1);
}

function assertOperation(value: unknown): void {
  const operation = record(value);
  if (!operation || typeof operation.op !== "string") {
    rejectHistory("Completed historical alias operation is unreadable.");
  }
  const lines = operation.lines;
  const validLines =
    Array.isArray(lines) &&
    lines.length <= 100_000 &&
    lines.every(
      (line) =>
        typeof line === "string" &&
        line.isWellFormed() &&
        !/[\r\n\0]/u.test(line) &&
        Buffer.byteLength(line, "utf8") <= 16 * 1024 * 1024,
    );
  if (
    operation.op === "replace" &&
    exactKeys(operation, ["endLine", "lines", "op", "startLine"]) &&
    validLineNumber(operation.startLine) &&
    validLineNumber(operation.endLine) &&
    (operation.startLine as number) <= (operation.endLine as number) &&
    validLines &&
    (lines as unknown[]).length <= 20_000
  ) {
    return;
  }
  if (
    operation.op === "insert" &&
    exactKeys(operation, ["afterLine", "lines", "op"]) &&
    validLineNumber(operation.afterLine, true) &&
    validLines &&
    (lines as unknown[]).length <= 20_000 &&
    (lines as unknown[]).length > 0
  ) {
    return;
  }
  if (
    operation.op === "replace_file" &&
    (exactKeys(operation, ["lines", "op"]) ||
      exactKeys(operation, ["finalNewline", "lines", "op"])) &&
    validLines &&
    (operation.finalNewline === undefined || typeof operation.finalNewline === "boolean") &&
    (operation.finalNewline !== true || (lines as unknown[]).length > 0)
  ) {
    return;
  }
  if (
    (operation.op === "copy_range" || operation.op === "move_range") &&
    exactKeys(operation, ["afterLine", "endLine", "op", "startLine"]) &&
    validLineNumber(operation.startLine) &&
    validLineNumber(operation.endLine) &&
    validLineNumber(operation.afterLine, true) &&
    (operation.startLine as number) <= (operation.endLine as number) &&
    (operation.op !== "move_range" ||
      (operation.afterLine as number) < (operation.startLine as number) - 1 ||
      (operation.afterLine as number) > (operation.endLine as number))
  ) {
    return;
  }
  if (operation.op === "delete_file" && exactKeys(operation, ["op"])) {
    return;
  }
  if (
    operation.op === "move_file" &&
    exactKeys(operation, ["destinationPath", "op"]) &&
    typeof operation.destinationPath === "string" &&
    operation.destinationPath.length > 0
  ) {
    return;
  }
  rejectHistory("Completed historical alias operation is unreadable.");
}

function assertInputPath(
  toolName: NativeAliasSurface,
  requestedValue: string,
  canonicalPath: string,
  directory: string,
  requireSurvivingParent: boolean,
): void {
  let pathMatches = false;
  const requestedPath = resolve(directory, requestedValue);
  try {
    pathMatches = samePath(realpathSync(requestedPath), canonicalPath);
  } catch {
    if (!requireSurvivingParent && samePath(requestedPath, canonicalPath)) {
      pathMatches = true;
    } else {
      try {
        const canonicalParentPath = dirname(canonicalPath);
        const resolvedCanonicalParent = realpathSync(canonicalParentPath);
        if (samePath(resolvedCanonicalParent, canonicalParentPath)) {
          const requestedParent = statSync(realpathSync(dirname(requestedPath)), { bigint: true });
          const canonicalParent = statSync(resolvedCanonicalParent, { bigint: true });
          pathMatches =
            samePath(basename(requestedPath), basename(canonicalPath)) &&
            requestedParent.dev === canonicalParent.dev &&
            requestedParent.ino === canonicalParent.ino;
        }
      } catch {}
    }
  }
  if (!pathMatches) {
    rejectHistory(`Completed historical ${toolName} input path is inconsistent.`);
  }
}

function assertAliasInput(
  toolName: NativeAliasSurface,
  inputValue: unknown,
  completed?: NativeAliasCompletedEvidence,
  directory?: string,
): Record<string, unknown> {
  const input = record(inputValue);
  const allowed = [
    "allowHashlinePrefixes",
    "filePath",
    "operations",
    "readback",
    "readbackLimit",
    "readbackOffset",
    "rebase",
    "snapshotId",
  ];
  if (
    !input ||
    !Object.keys(input).every((key) => allowed.includes(key)) ||
    typeof input.filePath !== "string" ||
    !input.filePath ||
    typeof input.snapshotId !== "string" ||
    !/^s_[A-Za-z0-9_-]{22}$/u.test(input.snapshotId) ||
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > 100 ||
    (input.rebase !== undefined && input.rebase !== "none" && input.rebase !== "unique") ||
    (input.allowHashlinePrefixes !== undefined &&
      typeof input.allowHashlinePrefixes !== "boolean") ||
    (input.readback !== undefined && typeof input.readback !== "boolean") ||
    (input.readbackOffset !== undefined && !validLineNumber(input.readbackOffset)) ||
    (input.readbackLimit !== undefined &&
      (!validLineNumber(input.readbackLimit) || (input.readbackLimit as number) > 1000)) ||
    ((input.readbackOffset !== undefined || input.readbackLimit !== undefined) &&
      input.readback !== true)
  ) {
    rejectHistory(`Completed historical ${toolName} input is unreadable.`);
  }
  for (const operation of input.operations) assertOperation(operation);
  const replaceFile = input.operations.filter(
    (operation) => record(operation)?.op === "replace_file",
  );
  if (replaceFile.length > 0 && (input.operations.length !== 1 || input.rebase === "unique")) {
    rejectHistory(`Completed historical ${toolName} input is unreadable.`);
  }
  const lifecycle = input.operations.filter((operation) => {
    const name = record(operation)?.op;
    return name === "delete_file" || name === "move_file";
  });
  if (
    lifecycle.length > 0 &&
    (lifecycle.length !== 1 ||
      input.operations.length !== 1 ||
      input.rebase === "unique" ||
      input.readback === true ||
      input.readbackOffset !== undefined ||
      input.readbackLimit !== undefined)
  ) {
    rejectHistory(`Completed historical ${toolName} input is unreadable.`);
  }
  const inputOperation: NativeAliasOperation =
    lifecycle.length === 0 ? "update" : (record(lifecycle[0])?.op as NativeAliasOperation);
  if (completed && completed.operation !== inputOperation) {
    rejectHistory(`Completed historical ${toolName} input operation is inconsistent.`);
  }

  let totalLines = 0;
  let totalBytes = 0;
  for (const operationValue of input.operations) {
    const operation = record(operationValue);
    if (!operation || !Array.isArray(operation.lines)) continue;
    totalLines += operation.lines.length;
    for (const line of operation.lines) totalBytes += Buffer.byteLength(line as string, "utf8") + 2;
  }
  if (totalLines > 100_000 || totalBytes > 16 * 1024 * 1024) {
    rejectHistory(`Completed historical ${toolName} input is unreadable.`);
  }
  if (directory && completed) {
    assertInputPath(
      toolName,
      input.filePath,
      completed.canonicalPath,
      directory,
      completed.operation !== "update",
    );
    if (completed.operation === "move_file") {
      const operation = record(input.operations[0]);
      if (typeof operation?.destinationPath !== "string" || !completed.destinationCanonicalPath) {
        rejectHistory(`Completed historical ${toolName} input is unreadable.`);
      }
      assertInputPath(
        toolName,
        operation.destinationPath,
        completed.destinationCanonicalPath,
        directory,
        true,
      );
    }
  }
  return input;
}

function assertCompletedInput(
  toolName: NativeAliasSurface,
  inputValue: unknown,
  completed: NativeAliasCompletedEvidence,
  directory: string | undefined,
): void {
  assertAliasInput(toolName, inputValue, completed, directory);
}

function isKnownNativeShapeRejection(toolName: NativeAliasSurface, state: Record<string, unknown>) {
  const input = record(state.input);
  const expectedError = `INVALID_ARGUMENT: Invalid ${toolName} arguments.`;
  if (!input || state.error !== expectedError || state.metadata !== undefined) return false;
  if (toolName === "apply_patch") {
    return exactKeys(input, ["patchText"]) && typeof input.patchText === "string";
  }
  return (
    (exactKeys(input, ["filePath", "newString", "oldString"]) ||
      exactKeys(input, ["filePath", "newString", "oldString", "replaceAll"])) &&
    typeof input.filePath === "string" &&
    typeof input.oldString === "string" &&
    typeof input.newString === "string" &&
    (input.replaceAll === undefined || typeof input.replaceAll === "boolean")
  );
}

function isAttestedCompletedDisplayPrefixRejection(
  toolName: NativeAliasSurface,
  state: Record<string, unknown>,
  identity: NativeAliasProtocolIdentity,
): boolean {
  const metadata = record(state.metadata);
  const marker = record(metadata?.betterHashlineRejection);
  if (
    state.status !== "completed" ||
    !metadata ||
    metadata.truncated !== false ||
    !marker ||
    !exactKeys(metadata, ["betterHashlineRejection", "truncated"]) ||
    !exactKeys(marker, [
      "errorCode",
      "hostVersion",
      "inputSha256",
      "lineIndex",
      "operationIndex",
      "packageVersion",
      "prefix",
      "protocol",
      "schemaSha256",
      "surface",
      "worktreeSha256",
    ]) ||
    marker.protocol !== NATIVE_ALIAS_PROTOCOL ||
    marker.packageVersion !== identity.packageVersion ||
    marker.schemaSha256 !== identity.schemaSha256 ||
    marker.hostVersion !== identity.hostVersion ||
    marker.worktreeSha256 !== canonicalPathSha256(identity.worktree) ||
    marker.surface !== toolName ||
    marker.errorCode !== "DISPLAY_PREFIX_REJECTED" ||
    typeof marker.inputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(marker.inputSha256)
  ) {
    return false;
  }
  const input = assertAliasInput(toolName, state.input);
  const match = findHashlineDisplayPrefix(input.operations as unknown[]);
  return (
    match !== undefined &&
    marker.inputSha256 === jsonSha256(input) &&
    marker.operationIndex === match.operationIndex &&
    marker.lineIndex === match.lineIndex &&
    marker.prefix === match.prefix &&
    input.allowHashlinePrefixes !== true &&
    state.output === `DISPLAY_PREFIX_REJECTED: ${displayPrefixRejectionMessage(match)}`
  );
}

function isKnownRejectedAliasCall(
  toolName: NativeAliasSurface,
  state: Record<string, unknown>,
): boolean {
  return isKnownNativeShapeRejection(toolName, state);
}

function assertTime(value: unknown, completed: boolean): void {
  const time = record(value);
  const expectedKeys = completed ? ["end", "start"] : ["start"];
  if (completed && time && "compacted" in time) expectedKeys.push("compacted");
  if (
    !time ||
    !exactKeys(time, expectedKeys) ||
    typeof time.start !== "number" ||
    !Number.isFinite(time.start) ||
    (completed && (typeof time.end !== "number" || !Number.isFinite(time.end))) ||
    (time.compacted !== undefined &&
      (typeof time.compacted !== "number" || !Number.isFinite(time.compacted)))
  ) {
    rejectHistory("OpenCode session history contains an invalid tool state time.");
  }
}

function assertToolState(state: Record<string, unknown>): void {
  if (state.status === "pending") {
    if (
      !exactKeys(state, ["input", "raw", "status"]) ||
      !record(state.input) ||
      typeof state.raw !== "string"
    ) {
      rejectHistory("OpenCode session history contains an invalid pending tool state.");
    }
    return;
  }
  if (state.status === "running") {
    const keys = ["input", "status", "time"];
    if ("title" in state) keys.push("title");
    if ("metadata" in state) keys.push("metadata");
    if (
      !exactKeys(state, keys) ||
      !record(state.input) ||
      (state.title !== undefined && typeof state.title !== "string") ||
      (state.metadata !== undefined && !record(state.metadata))
    ) {
      rejectHistory("OpenCode session history contains an invalid running tool state.");
    }
    assertTime(state.time, false);
    return;
  }
  if (state.status === "completed") {
    const keys = ["input", "metadata", "output", "status", "time", "title"];
    if ("attachments" in state) keys.push("attachments");
    if (
      !exactKeys(state, keys) ||
      !record(state.input) ||
      !record(state.metadata) ||
      typeof state.output !== "string" ||
      typeof state.title !== "string" ||
      (state.attachments !== undefined && !Array.isArray(state.attachments))
    ) {
      rejectHistory("OpenCode session history contains an invalid completed tool state.");
    }
    assertTime(state.time, true);
    return;
  }
  if (state.status === "error") {
    const keys = ["error", "input", "status", "time"];
    if ("metadata" in state) keys.push("metadata");
    if (
      !exactKeys(state, keys) ||
      !record(state.input) ||
      typeof state.error !== "string" ||
      (state.metadata !== undefined && !record(state.metadata))
    ) {
      rejectHistory("OpenCode session history contains an invalid error tool state.");
    }
    assertTime(state.time, true);
    return;
  }
  rejectHistory("OpenCode session history contains an unknown tool state.");
}

function assertToolPart(part: Record<string, unknown>): void {
  const keys = ["callID", "id", "messageID", "sessionID", "state", "tool", "type"];
  if ("metadata" in part) keys.push("metadata");
  if (
    !exactKeys(part, keys) ||
    part.type !== "tool" ||
    typeof part.id !== "string" ||
    !part.id ||
    typeof part.callID !== "string" ||
    !part.callID ||
    typeof part.sessionID !== "string" ||
    !part.sessionID ||
    typeof part.messageID !== "string" ||
    !part.messageID ||
    typeof part.tool !== "string" ||
    !part.tool ||
    (part.metadata !== undefined && !record(part.metadata))
  ) {
    rejectHistory("OpenCode session history contains an invalid tool part.");
  }
}

function inspectHistory(
  messagesValue: unknown,
  identity: NativeAliasProtocolIdentity,
  options: HistoryOptions,
): NativeAliasCompletedEvidence[] {
  assertHistoryBounds(messagesValue);
  const inspectedMessages: Record<string, unknown>[] = [];
  let partCount = 0;
  let currentMatches = 0;
  const completedAliases: NativeAliasCompletedEvidence[] = [];
  const currentInput =
    options.currentCall?.input === undefined ? undefined : canonicalJson(options.currentCall.input);
  const messageIds = new Set<string>();
  const partIds = new Set<string>();
  const callIds = new Set<string>();
  for (const messageValue of messagesValue) {
    const message = record(messageValue);
    const messageInfo = record(message?.info);
    if (!message || !Array.isArray(message.parts)) {
      rejectHistory("OpenCode session history is unreadable.");
    }
    partCount += message.parts.length;
    if (partCount > SESSION_HISTORY_MAX_PARTS) {
      rejectOversizedHistory();
    }
    if (
      options.sessionId &&
      (!messageInfo || typeof messageInfo.id !== "string" || !messageInfo.id)
    ) {
      rejectHistory("OpenCode session history contains an unbound message.");
    }
    if (options.sessionId && messageInfo && messageIds.has(messageInfo.id as string)) {
      rejectHistory("OpenCode session history contains a duplicate message identity.");
    }
    if (options.sessionId && messageInfo) messageIds.add(messageInfo.id as string);
    if (options.sessionId && messageInfo?.sessionID !== options.sessionId) {
      rejectHistory("OpenCode session history contains an unbound message.");
    }
    const inspectedParts: unknown[] = [];
    for (const partValue of message.parts) {
      const part = record(partValue);
      if (!part) {
        rejectHistory("OpenCode session history contains an unbound part.");
      }
      if (
        options.sessionId &&
        (typeof part.id !== "string" ||
          !part.id ||
          !messageInfo ||
          part.messageID !== messageInfo.id ||
          part.sessionID !== options.sessionId)
      ) {
        rejectHistory("OpenCode session history contains an unbound part.");
      }
      if (options.sessionId && partIds.has(part.id as string)) {
        rejectHistory("OpenCode session history contains a duplicate part identity.");
      }
      if (options.sessionId) partIds.add(part.id as string);
      if (part?.type !== "tool") {
        inspectedParts.push(partValue);
        continue;
      }
      if (options.sessionId) assertToolPart(part);
      const state = record(part.state);
      if (!state) {
        rejectHistory("OpenCode session history contains an unbound tool call.");
      }
      if (options.sessionId) assertToolState(state);
      const callIdentity = JSON.stringify([part.messageID, part.callID]);
      if (options.sessionId && callIds.has(callIdentity)) {
        rejectHistory("OpenCode session history contains a duplicate call identity.");
      }
      if (options.sessionId) callIds.add(callIdentity);
      const activeCurrentCall =
        options.currentCall &&
        part.callID === options.currentCall.id &&
        part.tool === options.currentCall.tool &&
        (state.status === "pending" || state.status === "running");
      const currentInputMatches =
        currentInput === undefined ||
        ((state.status === "pending" || state.status === "running") &&
          canonicalJson(state.input) === currentInput);
      if (activeCurrentCall && !currentInputMatches) {
        throw new NativeAliasCurrentCallPendingError();
      }
      const currentCall = activeCurrentCall && currentInputMatches;
      if (currentCall) {
        currentMatches += 1;
        if (currentMatches !== 1) {
          rejectHistory("The current alias call is ambiguous in session history.");
        }
        continue;
      }
      if (
        part.tool !== "hashline_edit" &&
        part.tool !== "edit" &&
        part.tool !== "apply_patch" &&
        part.tool !== "write"
      ) {
        inspectedParts.push(partValue);
        continue;
      }
      inspectedParts.push(partValue);
      if (part.tool === "hashline_edit" || part.tool === "write") {
        rejectHistory("This session contains the hashline tool surface.");
      }
      if (state?.status === "error" && isKnownRejectedAliasCall(part.tool, state)) continue;
      if (
        state?.status === "completed" &&
        isAttestedCompletedDisplayPrefixRejection(part.tool, state, identity)
      ) {
        continue;
      }
      if (state?.status !== "completed") {
        const correlation = options.currentCall
          ? ` Current correlation: id=${part.callID === options.currentCall.id ? "match" : "mismatch"}, tool=${part.tool === options.currentCall.tool ? "match" : "mismatch"}, input=${currentInputMatches ? "match" : "mismatch"}.`
          : "";
        rejectHistory(
          `Historical ${String(part.tool)} has an ambiguous execution state.${correlation}`,
        );
      }
      const completed = assertCompletedMetadata(part.tool, state.metadata, identity);
      if (options.directory || completed.operation !== "update") {
        assertCompletedInput(part.tool, state.input, completed, options.directory);
      }
      completedAliases.push(completed);
    }
    inspectedMessages.push({ ...message, parts: inspectedParts });
  }
  if (options.currentCall && currentMatches !== 1) {
    rejectHistory("The current alias call is missing from session history.");
  }
  return completedAliases;
}

export function inspectNativeAliasHistory(
  messagesValue: unknown,
  identity: NativeAliasProtocolIdentity,
  options: HistoryOptions = {},
): NativeAliasCompletedEvidence[] {
  return inspectHistory(messagesValue, identity, options);
}

export function assertNativeAliasHistory(
  messagesValue: unknown,
  identity: NativeAliasProtocolIdentity,
  options: HistoryOptions = {},
): void {
  inspectHistory(messagesValue, identity, options);
}

export class NativeAliasSessionRegistry {
  readonly #bindings = new Map<string, string>();

  status(sessionId: string, fingerprint: string): NativeAliasBindingStatus {
    const existing = this.#bindings.get(sessionId);
    if (existing === undefined) return "unbound";
    return existing === fingerprint ? "bound" : "mismatch";
  }

  isBound(sessionId: string, fingerprint: string): boolean {
    const status = this.status(sessionId, fingerprint);
    if (status === "mismatch") {
      rejectHistory("This session is already bound to another Better Hashline protocol.");
    }
    return status === "bound";
  }

  bind(sessionId: string, fingerprint: string): void {
    if (this.isBound(sessionId, fingerprint)) return;
    this.#bindings.set(sessionId, fingerprint);
    if (this.#bindings.size <= SESSION_BINDING_LIMIT) return;
    const oldest = this.#bindings.keys().next().value;
    if (oldest !== undefined) this.#bindings.delete(oldest);
  }

  clear(): void {
    this.#bindings.clear();
  }
}
