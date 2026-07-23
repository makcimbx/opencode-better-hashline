import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { type Plugin, type ToolContext, type ToolResult, tool } from "@opencode-ai/plugin";
import { createTwoFilesPatch } from "diff";
import type { EditOperation, RebaseMode } from "./edits.js";
import { moveCorridor, planEdits, validateEditOperations } from "./edits.js";
import { fail, HashlineError } from "./errors.js";
import {
  assertTargetAbsent,
  authorizeEdit,
  authorizeEdits,
  authorizeExternal,
  authorizeRead,
  pathsAlias,
  publishDeletedFile,
  publishMovedFile,
  publishNewFile,
  publishNewFileWithParents,
  publishReplacement,
  readStableFile,
  resolveExistingFile,
  resolveMutableFile,
  resolveNewFile,
  resolveNewFileParentPlan,
  revalidateNewFileParentPlan,
  throwIfAborted,
  withPathLock,
  withPathLocks,
} from "./filesystem.js";
import { detectOpenCodeVersion, openCodeProviderSchema } from "./native-alias.js";
import { ABSOLUTE_MAX_LOGICAL_LINES, type ResolvedOptions, resolveOptions } from "./options.js";
import { exactRelativePath, sameFilesystemRoot } from "./path-identity.js";
import {
  buildNativeAliasMetadata,
  countUnifiedDiffChanges,
  isRendererPathSafe,
  jsonSha256,
  NATIVE_ALIAS_METADATA_MAX_BYTES,
  nativeAliasProtocolFingerprint,
} from "./presentation.js";
import { renderSnapshotPage } from "./render.js";
import {
  buildNativeAliasDisplayPrefixRejectionMetadata,
  displayPrefixRejectionMessage,
  findHashlineDisplayPrefix,
  type HashlineDisplayPrefixMatch,
  type NativeAliasBindingStatus,
  type NativeAliasProtocolIdentity,
  type NativeAliasSessionCandidate,
  NativeAliasSessionRegistry,
} from "./session-protocol.js";
import {
  type IssuedPage,
  type IssuedRange,
  type Snapshot,
  type SnapshotAuthority,
  type SnapshotScope,
  SnapshotStore,
  sha256,
} from "./snapshots.js";
import { assertLineLimit, bytesEqual, decodeTextDocument, encodeNewText } from "./text.js";
import { PACKAGE_VERSION } from "./version.js";

const NATIVE_MUTATORS = new Set(["edit", "write", "apply_patch"]);
const EDIT_SEMANTICS_GUIDANCE =
  "replace removes the one-based inclusive startLine..endLine range; lines is the complete replacement; neighboring lines outside the range remain, so do not repeat retained context such as a closing delimiter unless intentional. Every operation uses original immutable pre-batch coordinates; never shift later startLine/endLine/afterLine because of earlier operations and never target lines created by another operation.";

const readArgumentShape = {
  filePath: tool.schema
    .string()
    .min(1)
    .describe(
      "Existing UTF-8 file path. Relative paths resolve from the session directory; canonical targets outside allowed roots require external-directory authorization.",
    ),
  offset: tool.schema
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional one-based first line; defaults to 1."),
  limit: tool.schema
    .number()
    .int()
    .min(1)
    .max(ABSOLUTE_MAX_LOGICAL_LINES)
    .optional()
    .describe(
      "Maximum rendered lines; defaults to 1000. Output remains bounded by maxOutputBytes. @more means rendering stopped before EOF; @eof means the cursor reached EOF; partial=true may accompany either.",
    ),
};
const readArguments = tool.schema.object(readArgumentShape).strict();

function createEditSchema() {
  const editOperation = tool.schema
    .object({
      op: tool.schema
        .enum([
          "replace",
          "insert",
          "replace_file",
          "copy_range",
          "move_range",
          "delete_file",
          "move_file",
        ])
        .describe(
          "Required: replace(startLine,endLine,lines); insert(afterLine,lines); replace_file(lines); copy_range/move_range(startLine,endLine,afterLine); delete_file; move_file(destinationPath). Optional only: replace_file(finalNewline). All other fields are forbidden.",
        ),
      startLine: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Only for replace, copy_range, and move_range; first one-based inclusive source line, within the original snapshot and no later than endLine.",
        ),
      endLine: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Only for replace, copy_range, and move_range; last one-based inclusive source line, no earlier than startLine and within the original snapshot.",
        ),
      afterLine: tool.schema
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Only for insert, copy_range, and move_range; 0..snapshot line count, where 0 means before line 1. Copy may target its source; move forbids destinations strictly inside its source and rejects adjacent identity destinations.",
        ),
      lines: tool.schema
        .array(tool.schema.string().max(16 * 1024 * 1024))
        .max(ABSOLUTE_MAX_LOGICAL_LINES)
        .optional()
        .describe(
          "Only for replace, insert, and replace_file. replace accepts 0..20,000; insert 1..20,000. Each item is one logical line without CR, LF, NUL, or invalid Unicode.",
        ),
      finalNewline: tool.schema
        .boolean()
        .optional()
        .describe(
          "Only for replace_file; omit to preserve snapshot state. true requires non-empty lines; an empty file requires false.",
        ),
      destinationPath: tool.schema
        .string()
        .min(1)
        .optional()
        .describe(
          "Only for move_file; relative paths resolve from the session directory, and canonical targets outside allowed roots require external-directory authorization. The parent must exist and the destination must be absent. Native aliases require the destination inside the current worktree.",
        ),
    })
    .strict()
    .describe(
      "Fields not listed for the selected op are invalid; replace_file and file lifecycle operations must be sole. One move_range may compose with pairwise-disjoint replace operations wholly inside its intervening corridor and outside its source; the complete corridor must be issued and unchanged.",
    );
  const argumentShape = {
    filePath: tool.schema
      .string()
      .min(1)
      .describe(
        "Source path for this snapshot; must resolve to the same canonical file as snapshotId. Native aliases require the source inside the current worktree.",
      ),
    snapshotId: tool.schema
      .string()
      .regex(/^s_[A-Za-z0-9_-]{22}$/)
      .describe(
        "Exact snapshot ID delivered by hashline_read for filePath; do not invent it or reuse it after a successful mutation.",
      ),
    rebase: tool.schema
      .enum(["none", "unique"])
      .optional()
      .describe(
        "none is default; unique only relocates a still-retained snapshot after external changes. replace_file, delete_file, and move_file forbid unique.",
      ),
    allowHashlinePrefixes: tool.schema
      .boolean()
      .optional()
      .describe(
        "Default false. Column-0 prefixes like 17|, 17!|, and @hashline are rejected. Set true in the initial call only for intentional source text; applies to every payload line.",
      ),
    readback: tool.schema
      .boolean()
      .optional()
      .describe(
        "Optional; defaults to false. For a text edit, true requests one bounded successor page for verification or follow-up, but the attachment can be unavailable after a successful mutation. Lifecycle operations reject readback, readbackOffset, and readbackLimit.",
      ),
    readbackOffset: tool.schema
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Only with readback:true for text edits. One-based first line in the post-edit file; omit to start near the first hunk.",
      ),
    readbackLimit: tool.schema
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_MAX_LOGICAL_LINES)
      .optional()
      .describe(
        "Only with readback:true for text edits. Maximum rendered lines in the one contiguous successor page; defaults to 1000. Output remains bounded by maxOutputBytes. @more means rendering stopped before EOF; @eof means the cursor reached EOF; partial=true may accompany either.",
      ),
    operations: tool.schema
      .array(editOperation)
      .min(1)
      .max(100)
      .describe(
        "Array of 1..100 flat operation objects. Every coordinate refers to the original immutable snapshot.",
      ),
  };
  return {
    argumentShape,
    argumentsSchema: tool.schema.object(argumentShape).strict(),
  };
}

const editSchema = createEditSchema();
const editArgumentShape = editSchema.argumentShape;
export const hashlineEditArgumentsSchema = editSchema.argumentsSchema;

export const hashlineEditDescription = `Mutate one exact hashline_read snapshot. Text batches publish one atomic replacement. File lifecycle operations are sole calls; move_file is nontransactional, and PARTIAL_PUBLICATION may leave both source and destination names present. Pass required top-level filePath, snapshotId, and operations JSON plus only the documented optional controls; do not encode arguments as text. ${EDIT_SEMANTICS_GUIDANCE} copy reads pre-edit source. replace_file, delete_file, and move_file require rebase:none and complete issued coverage. Lifecycle operations reject readback, readbackOffset, and readbackLimit and never overwrite. Destructive writes may be adjacent but not overlap; insert/copy destinations may touch a destructive endpoint but may not lie inside a destructive span or share a destination. Successful publication invalidates every retained snapshot for the affected session paths and returns a diff plus receipt. For text edits, readback:true requests one successor page, but the attachment can be unavailable; without an attached successor, run hashline_read before another mutation. After PARTIAL_PUBLICATION, inspect and reconcile every affected path before retrying.`;

export const nativeAliasEditDescription = `Better Hashline alias; it does not accept native oldString/newString or patchText syntax. Wait for hashline_read's returned result before calling it; native-alias-session must be bound, and source and destination paths must be inside the current worktree. ${hashlineEditDescription}`;

type SnapshotEditToolName = "hashline_edit" | "edit" | "apply_patch";

type SnapshotBoundEditExecutor = (
  toolName: SnapshotEditToolName,
  rawArgs: unknown,
  context: ToolContext,
) => Promise<ToolResult>;

function createSnapshotEditTool(
  toolName: SnapshotEditToolName,
  executeSnapshotBoundEdit: SnapshotBoundEditExecutor,
  description = hashlineEditDescription,
) {
  return tool({
    description,
    args: editArgumentShape,
    execute(rawArgs, context) {
      return executeSnapshotBoundEdit(toolName, rawArgs, context);
    },
  });
}

const writeArgumentShape = {
  filePath: tool.schema
    .string()
    .min(1)
    .describe(
      "Absent target file path. Relative paths resolve from the session directory; canonical targets outside allowed roots require external-directory authorization.",
    ),
  content: tool.schema
    .string()
    .max(16 * 1024 * 1024)
    .describe(
      "Complete UTF-8 text as one string; NUL, invalid Unicode, and control-heavy content are rejected.",
    ),
  createParents: tool.schema
    .boolean()
    .optional()
    .describe(
      "Default false: a missing parent fails with PATH_NOT_FOUND. true creates up to 64 missing parents through one fixed, approved no-rollback plan. After publication starts, an error can leave the target file and created directories present; inspect them before retrying.",
    ),
};
const writeArguments = tool.schema.object(writeArgumentShape).strict();
export const hashlineWriteArgumentsSchema = writeArguments;

interface PendingSnapshotBase {
  snapshotId: string;
  scope: SnapshotScope;
  directory: string;
  page: IssuedPage;
  outputDigest: string;
  createdAt: number;
  fallbackOutput?: string;
}

type PendingSnapshot =
  | (PendingSnapshotBase & {
      kind: "read";
      candidate: NativeAliasSessionCandidate | undefined;
    })
  | (PendingSnapshotBase & {
      kind: "edit";
      authority: SnapshotAuthority | undefined;
      canonicalWorktree: string | undefined;
      fingerprint: string | undefined;
    });

type NativeAliasAdmission = {
  authority: SnapshotAuthority;
  canonicalWorktree: string;
  fingerprint: string;
  identity: NativeAliasProtocolIdentity;
};

type RawEditOperation = {
  op:
    | "replace"
    | "insert"
    | "replace_file"
    | "copy_range"
    | "move_range"
    | "delete_file"
    | "move_file";
  startLine?: number | undefined;
  endLine?: number | undefined;
  afterLine?: number | undefined;
  lines?: string[] | undefined;
  finalNewline?: boolean | undefined;
  destinationPath?: string | undefined;
};

type ParsedEditBatch =
  | { kind: "text"; operations: EditOperation[] }
  | { kind: "delete_file" }
  | { kind: "move_file"; destinationPath: string };

function scopeFor(context: { sessionID: string; worktree: string }): SnapshotScope {
  return { sessionId: context.sessionID, worktree: context.worktree };
}

function sameCanonicalPath(left: string, right: string): boolean {
  return left === right;
}

function displayPath(worktree: string, canonicalPath: string): string {
  return exactRelativePath(worktree, canonicalPath) ?? canonicalPath;
}

function hostWorktreePath(worktree: string, directory: string): string {
  if (worktree === "/") return parse(resolve(directory)).root;
  return resolve(worktree);
}

async function canonicalDisplayRoot(worktree: string, directory: string): Promise<string> {
  const candidate = hostWorktreePath(worktree, directory);
  if (candidate === parse(candidate).root) return candidate;
  return realpath(candidate);
}

function samePathRoot(left: string, right: string): boolean {
  return sameFilesystemRoot(left, right);
}

function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, "before", "after", { context: 3 });
}

function firstNewFileHunkLine(diff: string): number {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/mu.exec(diff);
  const line = match?.[1] ? Number(match[1]) : 1;
  return Math.max(1, line);
}

type ValidationIssue = Record<string, unknown>;

function validationPath(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "arguments";
  let result = "";
  for (const part of value) {
    if (typeof part === "number") result += `[${part}]`;
    else if (typeof part === "string" && /^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(part)) {
      result += result.length === 0 ? part : `.${part}`;
    }
  }
  return result || "arguments";
}

function describeValidationIssue(toolName: string, error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error)) return undefined;
  const rawIssues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(rawIssues)) return undefined;
  const issues = rawIssues.filter(
    (issue): issue is ValidationIssue => typeof issue === "object" && issue !== null,
  );
  const issue = issues.find((candidate) => candidate.code === "unrecognized_keys") ?? issues[0];
  if (!issue) return undefined;

  const path = validationPath(issue.path);
  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    const key = issue.keys
      .filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/u.test(candidate),
      )
      .sort()[0];
    if (!key) return `An unsupported field is not accepted by ${toolName}.`;
    const field = path === "arguments" ? key : `${path}.${key}`;
    return `${field} is not accepted by ${toolName}.`;
  }
  if (issue.code === "invalid_type") {
    const expected = typeof issue.expected === "string" ? issue.expected : "the documented type";
    const label = ["array", "integer", "object"].includes(expected)
      ? `an ${expected}`
      : ["boolean", "number", "string"].includes(expected)
        ? `a ${expected}`
        : expected;
    return `${path} must be ${label}.`;
  }
  if (issue.code === "too_big") {
    const maximum = typeof issue.maximum === "number" ? ` of ${issue.maximum}` : "";
    return `${path} exceeds its maximum${maximum}.`;
  }
  if (issue.code === "too_small") {
    const minimum = typeof issue.minimum === "number" ? ` of ${issue.minimum}` : "";
    return `${path} is below its minimum${minimum}.`;
  }
  if (issue.code === "invalid_format") return `${path} has an invalid format.`;
  if (issue.code === "invalid_value") return `${path} is not an accepted value.`;
  return `${path} is invalid.`;
}

function invalidArguments(toolName: string, error?: unknown): never {
  const detail = describeValidationIssue(toolName, error) ?? `Invalid ${toolName} arguments.`;
  const recovery = ["hashline_edit", "edit", "apply_patch"].includes(toolName)
    ? "No mutation occurred; a valid supplied snapshot remains usable."
    : "No mutation occurred.";
  fail("INVALID_ARGUMENT", `${detail} ${recovery}`);
}

function rejectDisplayPrefix(match: HashlineDisplayPrefixMatch): never {
  fail("DISPLAY_PREFIX_REJECTED", displayPrefixRejectionMessage(match));
}

function assertRendererPaths(paths: readonly string[]): void {
  if (paths.some((path) => !isRendererPathSafe(path))) {
    fail("UNSUPPORTED_FILE", "Renderer paths cannot contain CR or LF characters.");
  }
}

function parseTextOperations(
  operations: readonly RawEditOperation[],
  maxFileBytes: number,
  maxLines: number,
): EditOperation[] {
  if (operations.some((operation) => operation.destinationPath !== undefined)) {
    fail("INVALID_ARGUMENT", "destinationPath is only accepted by move_file.");
  }
  for (const operation of operations) {
    if (operation.op !== "copy_range" && operation.op !== "move_range") continue;
    if (
      operation.startLine === undefined ||
      operation.endLine === undefined ||
      operation.afterLine === undefined ||
      operation.lines !== undefined ||
      operation.finalNewline !== undefined
    ) {
      fail(
        "INVALID_ARGUMENT",
        `${operation.op} requires startLine, endLine, and afterLine, and does not accept lines or finalNewline.`,
      );
    }
  }

  for (const operation of operations) {
    if (operation.op === "copy_range" || operation.op === "move_range") continue;
    if (operation.lines !== undefined) continue;
    if (operation.op === "replace") {
      fail(
        "INVALID_ARGUMENT",
        "replace requires startLine, endLine, and lines, and does not accept afterLine or finalNewline.",
      );
    }
    if (operation.op === "insert") {
      fail(
        "INVALID_ARGUMENT",
        "insert requires afterLine and lines, and does not accept startLine, endLine, or finalNewline.",
      );
    }
    fail("INVALID_ARGUMENT", "replace_file requires lines and does not accept line coordinates.");
  }

  let totalBytes = 0;
  let totalLines = 0;
  for (const operation of operations) {
    if (operation.op === "copy_range" || operation.op === "move_range") continue;
    const lines = operation.lines;
    if (lines === undefined) continue;
    totalLines += lines.length;
    for (const line of lines) {
      totalBytes += Buffer.byteLength(line, "utf8") + 2;
      if (totalBytes > maxFileBytes || totalLines > maxLines) {
        fail(
          "UNSUPPORTED_FILE",
          `Replacement payload exceeds maxFileBytes=${maxFileBytes} or maxLines=${maxLines}. No publication occurred and the snapshot was not consumed; reduce the payload before retrying.`,
        );
      }
    }
  }

  return operations.map((operation): EditOperation => {
    if (operation.op === "replace") {
      if (
        operation.lines === undefined ||
        operation.startLine === undefined ||
        operation.endLine === undefined ||
        operation.afterLine !== undefined ||
        operation.finalNewline !== undefined
      ) {
        fail(
          "INVALID_ARGUMENT",
          "replace requires startLine, endLine, and lines, and does not accept afterLine or finalNewline.",
        );
      }
      if (operation.lines.length > 20_000) {
        fail("INVALID_ARGUMENT", "replace accepts at most 20,000 replacement lines.");
      }
      return {
        op: "replace",
        startLine: operation.startLine,
        endLine: operation.endLine,
        lines: operation.lines,
      };
    }

    if (operation.op === "insert") {
      if (
        operation.lines === undefined ||
        operation.afterLine === undefined ||
        operation.startLine !== undefined ||
        operation.endLine !== undefined ||
        operation.finalNewline !== undefined
      ) {
        fail(
          "INVALID_ARGUMENT",
          "insert requires afterLine and lines, and does not accept startLine, endLine, or finalNewline.",
        );
      }
      if (operation.lines.length === 0 || operation.lines.length > 20_000) {
        fail("INVALID_ARGUMENT", "insert requires between 1 and 20,000 lines.");
      }
      return { op: "insert", afterLine: operation.afterLine, lines: operation.lines };
    }

    if (operation.op === "replace_file") {
      if (
        operation.lines === undefined ||
        operation.startLine !== undefined ||
        operation.endLine !== undefined ||
        operation.afterLine !== undefined
      ) {
        fail(
          "INVALID_ARGUMENT",
          "replace_file requires lines and does not accept line coordinates.",
        );
      }
      return {
        op: "replace_file",
        lines: operation.lines,
        ...(operation.finalNewline === undefined ? {} : { finalNewline: operation.finalNewline }),
      };
    }

    if (
      operation.startLine === undefined ||
      operation.endLine === undefined ||
      operation.afterLine === undefined ||
      operation.lines !== undefined ||
      operation.finalNewline !== undefined
    ) {
      fail(
        "INVALID_ARGUMENT",
        `${operation.op} requires startLine, endLine, and afterLine, and does not accept lines or finalNewline.`,
      );
    }
    return {
      op: operation.op as "copy_range" | "move_range",
      startLine: operation.startLine,
      endLine: operation.endLine,
      afterLine: operation.afterLine,
    };
  });
}

function parseOperations(
  operations: readonly RawEditOperation[],
  maxFileBytes: number,
  maxLines: number,
): ParsedEditBatch {
  const lifecycle = operations.filter(
    (operation) => operation.op === "delete_file" || operation.op === "move_file",
  );
  if (lifecycle.length === 0) {
    return { kind: "text", operations: parseTextOperations(operations, maxFileBytes, maxLines) };
  }
  if (operations.length !== 1 || lifecycle.length !== 1) {
    fail("INVALID_ARGUMENT", "File lifecycle operations must be the only operation.");
  }
  const operation = lifecycle[0];
  if (!operation) fail("INVALID_ARGUMENT", "A file lifecycle operation is required.");
  if (
    operation.startLine !== undefined ||
    operation.endLine !== undefined ||
    operation.afterLine !== undefined ||
    operation.lines !== undefined ||
    operation.finalNewline !== undefined
  ) {
    fail(
      "INVALID_ARGUMENT",
      `${operation.op} does not accept line coordinates, lines, or finalNewline.`,
    );
  }
  if (operation.op === "delete_file") {
    if (operation.destinationPath !== undefined) {
      fail("INVALID_ARGUMENT", "delete_file does not accept destinationPath.");
    }
    return { kind: "delete_file" };
  }
  if (!operation.destinationPath) {
    fail("INVALID_ARGUMENT", "move_file requires destinationPath.");
  }
  return { kind: "move_file", destinationPath: operation.destinationPath };
}

function assertIssued(
  store: SnapshotStore,
  snapshot: Snapshot,
  operations: readonly EditOperation[],
  rebase: RebaseMode,
): void {
  const lineCount = snapshot.document.lines.length;
  const ranges: IssuedRange[] = [];
  const boundaryRanges: IssuedRange[] = [];
  let bof = false;
  let eof = false;
  const addRange = (start: number, end: number): void => {
    ranges.push({ start, end });
  };
  const addBoundary = (position: number): void => {
    if (position === 0) bof = true;
    if (position === lineCount) eof = true;
    if (position > 0) boundaryRanges.push({ start: position, end: position });
    if (position < lineCount) boundaryRanges.push({ start: position + 1, end: position + 1 });
  };

  for (const operation of operations) {
    if (operation.op === "replace") {
      addRange(operation.startLine, operation.endLine);
    } else if (operation.op === "insert") {
      addBoundary(operation.afterLine);
    } else if (operation.op === "replace_file") {
      if (rebase !== "none") {
        fail("INVALID_ARGUMENT", "replace_file does not support unique rebase.");
      }
      bof = true;
      eof = true;
      if (lineCount > 0) addRange(1, lineCount);
    } else if (operation.op === "copy_range") {
      addRange(operation.startLine, operation.endLine);
      addBoundary(operation.afterLine);
    } else {
      addRange(operation.startLine, operation.endLine);
      const corridor = moveCorridor(operation);
      addRange(corridor.startLine, corridor.endLine);
      addBoundary(operation.afterLine);
    }
  }

  store.assertIssuedCoverage(snapshot, { ranges, boundaryRanges, bof, eof });
}

function withoutPendingMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  const { hashlinePending: _pending, ...rest } = metadata as Record<string, unknown>;
  return rest;
}

function withoutPendingSnapshotMetadata(metadata: unknown): Record<string, unknown> {
  const sanitized = withoutPendingMetadata(metadata);
  delete sanitized.snapshotId;
  return sanitized;
}

function protocolKindMismatch(output: { output: string; metadata: Record<string, unknown> }): void {
  output.metadata = withoutPendingSnapshotMetadata(output.metadata);
  output.output =
    "SESSION_PROTOCOL_MISMATCH: The delivered tool kind did not match the pending Better Hashline operation. No snapshot was issued. An underlying mutation may need inspection; run a fresh hashline_read before retrying.";
}

type EditSuccessorState = "none" | "attached" | "unavailable";

function editLifecycleReceipt(state: EditSuccessorState): string {
  return state === "attached"
    ? "@hashline-edit previous=consumed successor=attached"
    : `@hashline-edit previous=consumed successor=${state} next=hashline_read`;
}

function editResultOutput(success: string, state: EditSuccessorState): string {
  return `${success}\n${editLifecycleReceipt(state)}`;
}

const BETTER_HASHLINE_APPLIED_RECEIPT =
  /^Applied (?:1 operation|(?:[2-9]|[1-9]\d+) operations)\.$/u;

function unavailableEditReadback(
  result: { output: string; metadata: Record<string, unknown> },
  fallbackOutput?: string,
): void {
  result.metadata = withoutPendingSnapshotMetadata(result.metadata);
  const firstLine = result.output.split("\n", 1)[0] ?? "";
  result.output = BETTER_HASHLINE_APPLIED_RECEIPT.test(firstLine)
    ? (fallbackOutput ?? editResultOutput(firstLine, "unavailable"))
    : "SESSION_PROTOCOL_MISMATCH: Better Hashline could not attest this edit result. No successor snapshot was issued. Whether a mutation occurred is unknown; inspect the target and run a fresh hashline_read before retrying.";
}

export const betterHashlinePlugin: Plugin = async (input, rawOptions) => {
  const requestedToolSurface =
    rawOptions?.toolSurface === "native-aliases" ? "native-aliases" : "hashline";
  let initializationError: string | undefined;
  let options: ResolvedOptions;
  try {
    options = resolveOptions(rawOptions);
  } catch (error) {
    initializationError = error instanceof Error ? error.message : "Invalid plugin options.";
    options = resolveOptions({ enforce: true, toolSurface: requestedToolSurface });
  }
  let aliasAvailabilityError: string | undefined;
  let aliasIdentity: NativeAliasProtocolIdentity | undefined;
  let aliasFingerprint: string | undefined;
  if (options.toolSurface === "native-aliases" && !initializationError) {
    try {
      const hostVersion = await detectOpenCodeVersion(input.client);
      const schemaSha256 = jsonSha256(
        openCodeProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
      );
      aliasIdentity = {
        packageVersion: PACKAGE_VERSION,
        schemaSha256,
        hostVersion,
        worktree: input.worktree,
      };
      aliasFingerprint = nativeAliasProtocolFingerprint(aliasIdentity);
    } catch (error) {
      aliasAvailabilityError =
        error instanceof Error ? error.message : "Native alias initialization failed.";
    }
  }
  const snapshots = new SnapshotStore(options);
  const pendingSnapshots = new Map<string, PendingSnapshot>();
  const sessions = new NativeAliasSessionRegistry();

  function assertConfigured(): void {
    if (initializationError) {
      fail(
        "CONFIG_INVALID",
        `${initializationError} File mutation and editable snapshot issuance are disabled. Do not bypass this state with shell commands or another mutation tool. Repair the configuration, restart, then run a fresh delivered hashline_read.`,
      );
    }
  }

  function assertAliasAvailable(): {
    identity: NativeAliasProtocolIdentity;
    fingerprint: string;
  } {
    if (aliasAvailabilityError || !aliasIdentity || !aliasFingerprint) {
      const reason = aliasAvailabilityError ?? "Native alias protocol identity is unavailable.";
      fail(
        "TOOL_SURFACE_UNAVAILABLE",
        `${reason} File mutation and editable snapshot issuance are disabled. Do not bypass this state with shell commands or another mutation tool. Repair the host/plugin configuration, restart, then run a fresh delivered hashline_read.`,
      );
    }
    return { identity: aliasIdentity, fingerprint: aliasFingerprint };
  }

  function requireFreshAliasRead(reason: string): never {
    fail(
      "SNAPSHOT_REQUIRED",
      `${reason} Rerun hashline_read in this same session and use only the snapshot ID returned by that read; old snapshot IDs cannot be revived.`,
    );
  }

  async function resolveAliasSessionBinding(
    directory: string,
    worktree: string,
  ): Promise<{
    canonicalWorktree: string;
    identity: NativeAliasProtocolIdentity;
    fingerprint: string;
  }> {
    const alias = assertAliasAvailable();
    let canonicalWorktree: string;
    try {
      const candidate = hostWorktreePath(worktree, directory);
      if (!samePathRoot(candidate, resolve(directory))) {
        fail(
          "SESSION_PROTOCOL_MISMATCH",
          "OpenCode worktree and directory use different filesystem roots. Repair the active worktree/directory configuration, restart the plugin or host if necessary, then rerun hashline_read in this same session.",
        );
      }
      canonicalWorktree =
        parse(candidate).root === candidate ? candidate : await realpath(candidate);
    } catch (error) {
      if (error instanceof HashlineError) throw error;
      fail(
        "SESSION_PROTOCOL_MISMATCH",
        "OpenCode worktree identity could not be inspected. Restore path access or repair the active worktree configuration, restart the plugin or host if necessary, then rerun hashline_read in this same session.",
      );
    }
    const identity = { ...alias.identity, worktree: canonicalWorktree };
    return {
      canonicalWorktree,
      identity,
      fingerprint: jsonSha256({ protocol: alias.fingerprint, worktree: identity.worktree }),
    };
  }

  async function aliasSessionStatus(
    sessionId: string | undefined,
  ): Promise<NativeAliasBindingStatus> {
    if (!sessionId) return "unbound";
    try {
      const binding = await resolveAliasSessionBinding(input.directory, input.worktree);
      return sessions.status(sessionId, binding.fingerprint);
    } catch {
      return "mismatch";
    }
  }

  async function assertAliasSnapshotAdmission(
    sessionId: string,
    directory: string,
    worktree: string,
    snapshotId: string,
  ): Promise<NativeAliasAdmission> {
    const scope = { sessionId, worktree };
    const binding = await resolveAliasSessionBinding(directory, worktree);
    const authority = sessions.activeAuthority(
      sessionId,
      binding.fingerprint,
      binding.canonicalWorktree,
    );
    if (authority === undefined) {
      requireFreshAliasRead(
        "No exact native-alias process epoch is active for this session and canonical worktree.",
      );
    }
    const snapshot = snapshots.peek(scope, snapshotId);
    snapshots.assertAuthority(snapshot, authority);
    snapshots.assertDelivered(snapshot);
    return { ...binding, authority };
  }

  function assertAliasAuthorityCurrent(sessionId: string, admission: NativeAliasAdmission): void {
    if (
      sessions.isActive(
        sessionId,
        admission.fingerprint,
        admission.canonicalWorktree,
        admission.authority,
      )
    ) {
      return;
    }
    requireFreshAliasRead(
      "The admitted native-alias read epoch retired before publication could begin.",
    );
  }

  function rememberPending(pendingId: string, pending: PendingSnapshot): void {
    const expiredBefore = Date.now() - options.snapshotTtlMs;
    for (const [id, value] of pendingSnapshots) {
      if (value.createdAt >= expiredBefore && pendingSnapshots.size < options.maxSnapshots) break;
      pendingSnapshots.delete(id);
    }
    pendingSnapshots.set(pendingId, pending);
  }

  const hashlineRead = tool({
    description:
      options.toolSurface === "native-aliases"
        ? "Read an existing UTF-8 text file for Better Hashline's edit or apply_patch alias and prepare a pending exact snapshot. Wait for the returned result; only successful delivery binds the session and makes N| lines editable. Output uses @hashline, N|, N!|, @more, and @eof; prefixes are annotations, not file content. An N!| line is preview-only and cannot be issued by smaller pagination; raise maxOutputBytes and reread if it can fit, otherwise stop for manual restructuring or an explicit configuration change. Native-alias mutation requires the target inside the current worktree; external snapshots are inspection-only for aliases. Use native read for directories, media, PDFs, or inspection that will not be edited."
        : "Read an existing UTF-8 text file for hashline_edit and prepare a pending exact snapshot. Wait for the returned result; only successfully delivered N| lines become editable. Output uses @hashline, N|, N!|, @more, and @eof; prefixes are annotations, not file content. An N!| line is preview-only and cannot be issued by smaller pagination; raise maxOutputBytes and reread if it can fit, otherwise stop for manual restructuring or an explicit configuration change. Use native read for directories, media, PDFs, or inspection that will not be edited.",
    args: readArgumentShape,
    async execute(rawArgs, context) {
      assertConfigured();
      throwIfAborted(context.abort);
      const parsed = readArguments.safeParse(rawArgs);
      if (!parsed.success) invalidArguments("hashline_read", parsed.error);
      const args = parsed.data;
      const binding =
        options.toolSurface === "native-aliases"
          ? await resolveAliasSessionBinding(context.directory, context.worktree)
          : undefined;
      const candidate = binding
        ? sessions.prepare(context.sessionID, binding.fingerprint, binding.canonicalWorktree)
        : undefined;
      const resolved = await resolveExistingFile(args.filePath, context.directory);
      await authorizeExternal(context, resolved);
      await authorizeRead(context, resolved);
      const stable = await readStableFile(resolved, options.maxFileBytes, false, context.abort);
      const document = decodeTextDocument(stable.bytes, options.maxLines);
      const shownPath = displayPath(
        await canonicalDisplayRoot(context.worktree, context.directory),
        resolved.canonicalPath,
      );
      const snapshot = snapshots.remember(
        scopeFor(context),
        resolved.canonicalPath,
        document,
        candidate?.authority,
      );
      const rendered = renderSnapshotPage({
        snapshot,
        offset: args.offset ?? 1,
        limit: args.limit ?? 1000,
        maxOutputBytes: options.maxOutputBytes,
      });
      const pendingId = randomUUID();
      rememberPending(pendingId, {
        kind: "read",
        snapshotId: snapshot.id,
        scope: snapshot.scope,
        directory: context.directory,
        page: rendered.page,
        outputDigest: sha256(new TextEncoder().encode(rendered.output)),
        createdAt: Date.now(),
        candidate,
      });
      context.metadata({
        title: shownPath,
        metadata: { snapshotId: snapshot.id, nextOffset: rendered.nextOffset },
      });
      return {
        title: shownPath,
        output: rendered.output,
        metadata: {
          hashlinePending: pendingId,
          snapshotId: snapshot.id,
          nextOffset: rendered.nextOffset,
          displayedLines: rendered.displayedLines,
        },
      };
    },
  });

  async function executeSnapshotBoundEdit(
    toolName: SnapshotEditToolName,
    rawArgs: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    assertConfigured();
    throwIfAborted(context.abort);
    const parsed = hashlineEditArgumentsSchema.safeParse(rawArgs);
    if (!parsed.success) invalidArguments(toolName, parsed.error);
    const args = parsed.data;
    const batch = parseOperations(args.operations, options.maxFileBytes, options.maxLines);
    const rebase = args.rebase ?? "none";
    const hasReadbackWindow = args.readbackOffset !== undefined || args.readbackLimit !== undefined;
    if (rebase !== "none" && rebase !== "unique") {
      fail("INVALID_ARGUMENT", "rebase must be none or unique.");
    }
    if (batch.kind !== "text" && rebase !== "none") {
      fail("INVALID_ARGUMENT", `${batch.kind} does not support unique rebase.`);
    }
    if (batch.kind !== "text" && (args.readback || hasReadbackWindow)) {
      fail(
        "INVALID_ARGUMENT",
        `${batch.kind} does not accept readback, readbackOffset, or readbackLimit. Remove them and retry with the same snapshot.`,
      );
    }
    if (hasReadbackWindow && args.readback !== true) {
      fail("INVALID_ARGUMENT", "readbackOffset and readbackLimit require readback:true.");
    }
    const aliasBinding =
      toolName === "hashline_edit"
        ? undefined
        : await assertAliasSnapshotAdmission(
            context.sessionID,
            context.directory,
            context.worktree,
            args.snapshotId,
          );
    const displayPrefix =
      batch.kind === "text" && !args.allowHashlinePrefixes
        ? findHashlineDisplayPrefix(batch.operations)
        : undefined;
    if (displayPrefix) {
      if (toolName === "hashline_edit" || !aliasBinding) rejectDisplayPrefix(displayPrefix);
      const metadata = buildNativeAliasDisplayPrefixRejectionMetadata(
        toolName,
        args,
        aliasBinding.identity,
        displayPrefix,
      );
      return {
        title: args.filePath,
        output: `DISPLAY_PREFIX_REJECTED: ${displayPrefixRejectionMessage(displayPrefix)}`,
        metadata,
      };
    }
    const displayRoot =
      aliasBinding?.canonicalWorktree ??
      (await canonicalDisplayRoot(context.worktree, context.directory));
    if (batch.kind !== "text") {
      const resolved = await resolveMutableFile(args.filePath, context.directory);
      const shownPath = displayPath(displayRoot, resolved.canonicalPath);
      assertRendererPaths([resolved.canonicalPath, shownPath]);
      const aliasPath = shownPath.replaceAll("\\", "/");
      if (
        toolName !== "hashline_edit" &&
        (isAbsolute(shownPath) || aliasPath === ".." || aliasPath.startsWith("../"))
      ) {
        fail(
          "UNSUPPORTED_FILE",
          'Native aliases require source files inside the current worktree. To mutate an authorized external path, explicitly configure enforce:true with toolSurface:"hashline", restart, then run a fresh hashline_read; never fall back silently.',
        );
      }

      const destination =
        batch.kind === "move_file"
          ? await resolveNewFile(
              batch.destinationPath,
              context.directory,
              "move_file never creates parent directories. Create the destination parent before retrying.",
            )
          : undefined;
      const destinationShown = destination
        ? displayPath(displayRoot, destination.canonicalPath)
        : undefined;
      if (destination && destinationShown) {
        assertRendererPaths([destination.canonicalPath, destinationShown]);
      }
      const destinationAlias = destinationShown?.replaceAll("\\", "/");
      if (
        destination &&
        (pathsAlias(resolved.canonicalPath, destination.canonicalPath) ||
          (toolName !== "hashline_edit" &&
            (isAbsolute(destinationShown ?? "") ||
              destinationAlias === ".." ||
              destinationAlias?.startsWith("../"))))
      ) {
        fail(
          pathsAlias(resolved.canonicalPath, destination.canonicalPath)
            ? "INVALID_ARGUMENT"
            : "UNSUPPORTED_FILE",
          pathsAlias(resolved.canonicalPath, destination.canonicalPath)
            ? "move_file source and destination must be different paths."
            : 'Native aliases require move_file destinations inside the current worktree. To mutate an authorized external path, explicitly configure enforce:true with toolSurface:"hashline", restart, then run a fresh hashline_read; never fall back silently.',
        );
      }

      const scope = scopeFor(context);
      const snapshot = snapshots.pin(scope, args.snapshotId);
      try {
        if (!sameCanonicalPath(snapshot.canonicalPath, resolved.canonicalPath)) {
          fail("PATH_MISMATCH", "The snapshot belongs to a different canonical path.");
        }
        snapshots.assertComplete(snapshot, batch.kind);
        await authorizeExternal(context, resolved);
        if (destination) await authorizeExternal(context, destination);

        const lockPaths = destination
          ? [resolved.canonicalPath, destination.canonicalPath]
          : [resolved.canonicalPath];
        return await withPathLocks(
          lockPaths,
          async () => {
            snapshots.peek(scope, snapshot.id);
            const stable = await readStableFile(
              resolved,
              options.maxFileBytes,
              true,
              context.abort,
            );
            if (!bytesEqual(stable.bytes, snapshot.document.bytes)) {
              fail("TARGET_CHANGED", "The file no longer matches the exact issued snapshot bytes.");
            }
            if (destination) {
              if (stable.stats.dev !== destination.parentStats.dev) {
                fail(
                  "UNSUPPORTED_FILE",
                  "move_file requires source and destination on one filesystem.",
                );
              }
              await assertTargetAbsent(destination);
            }

            const diffPath = toolName === "hashline_edit" ? shownPath : aliasPath;
            const nextDiffPath = destination
              ? toolName === "hashline_edit"
                ? (destinationShown ?? destination.canonicalPath)
                : (destinationAlias ?? destination.canonicalPath)
              : diffPath;
            const diff = createTwoFilesPatch(
              diffPath,
              nextDiffPath,
              snapshot.document.text,
              batch.kind === "delete_file" ? "" : snapshot.document.text,
              "before",
              "after",
              { context: 3 },
            );
            let metadata: Record<string, unknown>;
            if (toolName === "hashline_edit") {
              metadata = {
                diff,
                operation: batch.kind,
                ...(destination ? { destinationPath: destination.canonicalPath } : {}),
              };
            } else {
              metadata = buildNativeAliasMetadata({
                surface: toolName,
                operation: batch.kind,
                canonicalPath: resolved.canonicalPath,
                relativePath: shownPath,
                ...(destination
                  ? {
                      destinationCanonicalPath: destination.canonicalPath,
                      destinationRelativePath: destinationShown as string,
                    }
                  : {}),
                unifiedDiff: diff,
                ...countUnifiedDiffChanges(diff),
                ...assertAliasAvailable().identity,
              });
              const persistedBytes = Buffer.byteLength(
                JSON.stringify({ ...metadata, truncated: false }),
                "utf8",
              );
              if (persistedBytes > NATIVE_ALIAS_METADATA_MAX_BYTES) {
                fail(
                  "UNSUPPORTED_FILE",
                  `Native alias metadata exceeds ${NATIVE_ALIAS_METADATA_MAX_BYTES} UTF-8 bytes.`,
                );
              }
            }

            await authorizeEdits(context, destination ? [resolved, destination] : [resolved], diff);
            if (batch.kind === "delete_file") {
              await publishDeletedFile({
                resolved,
                expected: stable,
                maxBytes: options.maxFileBytes,
                signal: context.abort,
                consume: () => {
                  if (aliasBinding) {
                    assertAliasAuthorityCurrent(context.sessionID, aliasBinding);
                  }
                  snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
                },
              });
            } else if (destination) {
              try {
                await publishMovedFile({
                  source: resolved,
                  destination,
                  expected: stable,
                  maxBytes: options.maxFileBytes,
                  signal: context.abort,
                  consume: () => {
                    if (aliasBinding) {
                      assertAliasAuthorityCurrent(context.sessionID, aliasBinding);
                    }
                    snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
                    snapshots.invalidateSessionPath(context.sessionID, destination.canonicalPath);
                  },
                });
              } catch (error) {
                if (
                  aliasBinding &&
                  error instanceof HashlineError &&
                  error.code === "PARTIAL_PUBLICATION"
                ) {
                  sessions.unbind(context.sessionID);
                }
                throw error;
              }
            }
            const title = destinationShown ? `${shownPath} -> ${destinationShown}` : shownPath;
            const success =
              batch.kind === "delete_file"
                ? `Deleted ${shownPath}.`
                : `Moved ${shownPath} to ${destinationShown}.`;
            const output = editResultOutput(success, "none");
            context.metadata({
              title,
              metadata,
            });
            return { title, output, metadata };
          },
          context.abort,
        );
      } finally {
        snapshots.release(snapshot);
      }
    }

    const operations = batch.operations;
    const resolved = await resolveExistingFile(args.filePath, context.directory);
    const shownPath = displayPath(displayRoot, resolved.canonicalPath);
    const aliasPath = shownPath.replaceAll("\\", "/");
    if (
      toolName !== "hashline_edit" &&
      (isAbsolute(shownPath) || aliasPath === ".." || aliasPath.startsWith("../"))
    ) {
      fail(
        "UNSUPPORTED_FILE",
        'Native aliases require source files inside the current worktree. To mutate an authorized external path, explicitly configure enforce:true with toolSurface:"hashline", restart, then run a fresh hashline_read; never fall back silently.',
      );
    }
    const scope = scopeFor(context);
    const snapshot = snapshots.pin(scope, args.snapshotId);
    try {
      if (!sameCanonicalPath(snapshot.canonicalPath, resolved.canonicalPath)) {
        fail("PATH_MISMATCH", "The snapshot belongs to a different canonical path.");
      }
      validateEditOperations(snapshot.document, operations);
      assertIssued(snapshots, snapshot, operations, rebase);
      await authorizeExternal(context, resolved);

      return await withPathLock(
        resolved.canonicalPath,
        async () => {
          snapshots.peek(scope, snapshot.id);
          const stable = await readStableFile(resolved, options.maxFileBytes, true, context.abort);
          const current = decodeTextDocument(stable.bytes, options.maxLines);
          const plan = planEdits({
            base: snapshot.document,
            current,
            operations,
            rebase,
            maxContextLines: options.maxContextLines,
            maxFileBytes: options.maxFileBytes,
            maxLines: options.maxLines,
          });
          if (plan.bytes.byteLength > options.maxFileBytes) {
            fail("UNSUPPORTED_FILE", "The edited file exceeds maxFileBytes.");
          }
          assertLineLimit(plan.bytes, options.maxLines);

          const diffPath =
            toolName === "hashline_edit" ? shownPath : shownPath.replaceAll("\\", "/");
          const diff = unifiedDiff(diffPath, current.text, plan.text);
          let metadata: Record<string, unknown>;
          if (toolName === "hashline_edit") {
            metadata = {
              diff,
              operationCount: plan.operationCount,
              rebased: plan.rebased,
            };
          } else {
            const metadataInput = {
              surface: toolName,
              canonicalPath: resolved.canonicalPath,
              relativePath: shownPath,
              unifiedDiff: diff,
              ...countUnifiedDiffChanges(diff),
              ...assertAliasAvailable().identity,
            };
            metadata = buildNativeAliasMetadata(metadataInput);
            const persistedBytes = Buffer.byteLength(
              JSON.stringify({ ...metadata, truncated: false }),
              "utf8",
            );
            if (persistedBytes > NATIVE_ALIAS_METADATA_MAX_BYTES) {
              fail(
                "UNSUPPORTED_FILE",
                `Native alias metadata exceeds ${NATIVE_ALIAS_METADATA_MAX_BYTES} UTF-8 bytes. Split the edit into smaller operations.`,
              );
            }
          }
          await authorizeEdit(context, resolved, diff);
          const verified = await publishReplacement({
            resolved,
            expected: stable,
            replacement: plan.bytes,
            maxBytes: options.maxFileBytes,
            signal: context.abort,
            consume: () => {
              if (aliasBinding) {
                assertAliasAuthorityCurrent(context.sessionID, aliasBinding);
              }
              snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
            },
          });
          const successOutput = `Applied ${plan.operationCount} operation${plan.operationCount === 1 ? "" : "s"}.`;
          let output = editResultOutput(successOutput, "none");
          let resultMetadata = metadata;
          if (args.readback) {
            const fallbackOutput = editResultOutput(successOutput, "unavailable");
            try {
              const document = decodeTextDocument(verified.bytes, options.maxLines);
              const successor = snapshots.remember(
                scope,
                resolved.canonicalPath,
                document,
                aliasBinding?.authority,
              );
              const prefix = `${editResultOutput(successOutput, "attached")}\n`;
              const rendered = renderSnapshotPage({
                snapshot: successor,
                offset: args.readbackOffset ?? firstNewFileHunkLine(diff),
                limit: args.readbackLimit ?? 1000,
                maxOutputBytes: options.maxOutputBytes - Buffer.byteLength(prefix, "utf8"),
              });
              output = `${prefix}${rendered.output}`;
              const pendingId = randomUUID();
              rememberPending(pendingId, {
                kind: "edit",
                snapshotId: successor.id,
                scope: successor.scope,
                directory: context.directory,
                page: rendered.page,
                outputDigest: sha256(new TextEncoder().encode(output)),
                createdAt: Date.now(),
                fallbackOutput,
                authority: aliasBinding?.authority,
                canonicalWorktree: aliasBinding?.canonicalWorktree,
                fingerprint: aliasBinding?.fingerprint,
              });
              resultMetadata = { ...metadata, hashlinePending: pendingId };
            } catch {
              output = fallbackOutput;
            }
          }
          context.metadata({
            title: shownPath,
            metadata: toolName === "hashline_edit" ? { diff } : metadata,
          });
          return {
            title: shownPath,
            output,
            metadata: resultMetadata,
          };
        },
        context.abort,
      );
    } finally {
      snapshots.release(snapshot);
    }
  }

  const hashlineEdit = createSnapshotEditTool("hashline_edit", executeSnapshotBoundEdit);
  const nativeEdit = createSnapshotEditTool(
    "edit",
    executeSnapshotBoundEdit,
    nativeAliasEditDescription,
  );
  const nativeApplyPatch = createSnapshotEditTool(
    "apply_patch",
    executeSnapshotBoundEdit,
    nativeAliasEditDescription,
  );

  const hashlineWrite = tool({
    description:
      options.toolSurface === "native-aliases"
        ? "CREATE ONLY: create an absent UTF-8 file; never use it to overwrite or edit an existing target. A hashline_read of another path does not prohibit creation. For an existing target, use hashline_read followed by edit or apply_patch. Omitted/false createParents requires an existing parent and fails with PATH_NOT_FOUND otherwise; true may create up to 64 parents. After publication starts, an error can leave the target file and created directories present; inspect them before retrying."
        : "CREATE ONLY: create an absent UTF-8 file; never use it to overwrite or edit an existing target. For an existing target, use hashline_read followed by hashline_edit. Omitted/false createParents requires an existing parent and fails with PATH_NOT_FOUND otherwise; true may create up to 64 parents. After publication starts, an error can leave the target file and created directories present; inspect them before retrying.",
    args: writeArgumentShape,
    async execute(rawArgs, context) {
      assertConfigured();
      if (options.toolSurface === "native-aliases") assertAliasAvailable();
      throwIfAborted(context.abort);
      const parsed = writeArguments.safeParse(rawArgs);
      if (!parsed.success) invalidArguments("hashline_write", parsed.error);
      const args = parsed.data;
      if (Buffer.byteLength(args.content, "utf8") > options.maxFileBytes) {
        fail(
          "UNSUPPORTED_FILE",
          `The new file exceeds maxFileBytes=${options.maxFileBytes}. No publication occurred; reduce the content before retrying.`,
        );
      }
      const bytes = encodeNewText(args.content);
      decodeTextDocument(bytes, options.maxLines);
      if (args.createParents) {
        const plan = await resolveNewFileParentPlan(args.filePath, context.directory);
        const plannedEntries = [
          {
            requestedPath: plan.requestedPath,
            requestedAbsolute: plan.requestedAbsolute,
            canonicalPath: plan.canonicalPath,
          },
          ...plan.missingDirectories.map((entry) => ({
            requestedPath: entry.requestedPath,
            requestedAbsolute: entry.requestedPath,
            canonicalPath: entry.canonicalPath,
          })),
        ];
        for (const entry of plannedEntries) await authorizeExternal(context, entry);
        const displayRoot = await canonicalDisplayRoot(context.worktree, context.directory);
        const shownPath = displayPath(displayRoot, plan.canonicalPath);
        const shownDirectories = plan.missingDirectories.map((entry) =>
          displayPath(displayRoot, entry.canonicalPath),
        );
        const diff = unifiedDiff(shownPath, "", args.content);

        return await withPathLocks(
          plan.lockPaths,
          async () => {
            await revalidateNewFileParentPlan(plan);
            await authorizeEdits(
              context,
              plannedEntries,
              diff,
              plan.missingDirectories.map((entry) => entry.canonicalPath),
            );
            try {
              await publishNewFileWithParents({
                plan,
                bytes,
                signal: context.abort,
                consume: () => {
                  for (const mutationPath of plan.mutationPaths) {
                    snapshots.invalidateSessionPath(context.sessionID, mutationPath);
                  }
                },
              });
            } catch (error) {
              if (
                options.toolSurface === "native-aliases" &&
                error instanceof HashlineError &&
                error.code === "PARTIAL_PUBLICATION"
              ) {
                sessions.unbind(context.sessionID);
              }
              throw error;
            }
            const metadata = { diff, createdDirectories: shownDirectories };
            context.metadata({ title: shownPath, metadata });
            return {
              title: shownPath,
              output:
                shownDirectories.length === 0
                  ? "Created the file. Use hashline_read before editing it."
                  : `Created ${shownDirectories.length} parent ${shownDirectories.length === 1 ? "directory" : "directories"} and the file. Use hashline_read before editing it.`,
              metadata: { ...metadata, created: true },
            };
          },
          context.abort,
        );
      }
      const resolved = await resolveNewFile(
        args.filePath,
        context.directory,
        "Missing parents are not created by default; pass createParents:true only if this write should create them.",
      );
      await authorizeExternal(context, resolved);
      const shownPath = displayPath(
        await canonicalDisplayRoot(context.worktree, context.directory),
        resolved.canonicalPath,
      );
      const diff = unifiedDiff(shownPath, "", args.content);

      return await withPathLock(
        resolved.canonicalPath,
        async () => {
          await assertTargetAbsent(resolved);
          await authorizeEdit(context, resolved, diff);
          await publishNewFile({
            resolved,
            bytes,
            signal: context.abort,
            consume: () =>
              snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath),
          });
          context.metadata({ title: shownPath, metadata: { diff } });
          return {
            title: shownPath,
            output: "Created the file. Use hashline_read before editing it.",
            metadata: { diff, created: true },
          };
        },
        context.abort,
      );
    },
  });

  const toolRegistry =
    options.toolSurface === "native-aliases"
      ? initializationError || aliasAvailabilityError
        ? {
            hashline_read: hashlineRead,
            hashline_write: hashlineWrite,
          }
        : {
            hashline_read: hashlineRead,
            edit: nativeEdit,
            apply_patch: nativeApplyPatch,
            hashline_write: hashlineWrite,
          }
      : {
          hashline_read: hashlineRead,
          hashline_edit: hashlineEdit,
          hashline_write: hashlineWrite,
        };

  function suppressMutators(tools: Record<string, boolean>): void {
    if (!options.enforce) return;
    if (options.toolSurface === "hashline") {
      for (const name of NATIVE_MUTATORS) tools[name] = false;
      return;
    }
    tools.write = false;
    tools.hashline_edit = false;
    if (initializationError || aliasAvailabilityError) {
      tools.edit = false;
      tools.apply_patch = false;
    }
  }

  return {
    tool: toolRegistry,
    async "chat.message"(_input, output) {
      if (!options.enforce) return;
      output.message.tools ??= {};
      suppressMutators(output.message.tools);
    },
    async "tool.execute.before"(hookInput, output) {
      if (options.toolSurface === "hashline") {
        if (!options.enforce || !NATIVE_MUTATORS.has(hookInput.tool)) return;
        assertConfigured();
        fail(
          "NATIVE_TOOL_DISABLED",
          `Use hashline_read followed by hashline_edit for an existing file, or hashline_write for a new file, instead of ${hookInput.tool}. Do not bypass this restriction with shell mutation.`,
        );
      }
      if (!options.enforce) return;
      if (hookInput.tool === "write" || hookInput.tool === "hashline_edit") {
        assertConfigured();
        fail(
          "NATIVE_TOOL_DISABLED",
          hookInput.tool === "write"
            ? "Use hashline_write only to create an absent file; native write is disabled."
            : 'hashline_edit is unavailable on the native-aliases surface. Restart after changing surfaces and run a fresh hashline_read, or explicitly configure enforce:true with toolSurface:"hashline", restart, and reread. Never fall back silently.',
        );
      }
      if (hookInput.tool !== "edit" && hookInput.tool !== "apply_patch") return;
      assertConfigured();
      const parsed = hashlineEditArgumentsSchema.safeParse(output.args);
      if (!parsed.success) invalidArguments(hookInput.tool, parsed.error);
      await assertAliasSnapshotAdmission(
        hookInput.sessionID,
        input.directory,
        input.worktree,
        parsed.data.snapshotId,
      );
    },
    async "tool.execute.after"(hookInput, output) {
      if (
        (hookInput.tool === "edit" || hookInput.tool === "apply_patch") &&
        output.output.startsWith("DISPLAY_PREFIX_REJECTED:") &&
        typeof output.metadata?.betterHashlineRejection === "object" &&
        output.metadata.betterHashlineRejection !== null
      ) {
        return;
      }
      const reportedKind =
        hookInput.tool === "hashline_read"
          ? "read"
          : (hookInput.tool === "hashline_edit" ||
                hookInput.tool === "edit" ||
                hookInput.tool === "apply_patch") &&
              typeof hookInput.args === "object" &&
              hookInput.args !== null &&
              (hookInput.args as Record<string, unknown>).readback === true
            ? "edit"
            : undefined;
      const pendingId = output.metadata?.hashlinePending;
      if (typeof pendingId !== "string") {
        if (reportedKind === undefined) return;
        output.metadata = withoutPendingMetadata(output.metadata);
        if (reportedKind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: OpenCode did not preserve the snapshot marker. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else {
          unavailableEditReadback(output);
        }
        return;
      }

      const deliveredSnapshotId = output.metadata?.snapshotId;
      const pending = pendingSnapshots.get(pendingId);
      pendingSnapshots.delete(pendingId);
      output.metadata = withoutPendingMetadata(output.metadata);
      if (!pending) {
        if (reportedKind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: The delivered read did not match a live pending snapshot. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else if (reportedKind === "edit") {
          unavailableEditReadback(output);
        } else {
          protocolKindMismatch(output);
        }
        return;
      }
      if (reportedKind !== pending.kind) {
        protocolKindMismatch(output);
        return;
      }
      if (
        pending.scope.sessionId !== hookInput.sessionID ||
        (pending.kind === "read" && deliveredSnapshotId !== pending.snapshotId)
      ) {
        if (pending.kind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: The delivered read did not match its exact pending session and snapshot. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else {
          unavailableEditReadback(output, pending.fallbackOutput);
        }
        return;
      }
      if (output.metadata.truncated === true) {
        if (pending.kind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: OpenCode truncated this result, so no editable lines were issued. Use a smaller limit and rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else {
          unavailableEditReadback(output, pending.fallbackOutput);
        }
        return;
      }
      if (sha256(new TextEncoder().encode(output.output)) !== pending.outputDigest) {
        if (pending.kind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: Another hook changed this result, so no editable lines were issued. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else {
          unavailableEditReadback(output, pending.fallbackOutput);
        }
        return;
      }

      try {
        if (pending.kind === "read" && pending.candidate) {
          const binding = await resolveAliasSessionBinding(
            pending.directory,
            pending.scope.worktree,
          );
          if (
            binding.fingerprint !== pending.candidate.fingerprint ||
            binding.canonicalWorktree !== pending.candidate.canonicalWorktree ||
            !sessions.isCandidateCurrent(pending.candidate)
          ) {
            requireFreshAliasRead(
              "The delivered read no longer matches its exact prepared native-alias epoch and canonical worktree.",
            );
          }
          const snapshot = snapshots.peek(pending.scope, pending.snapshotId);
          snapshots.assertAuthority(snapshot, pending.candidate.authority);
          if (!sessions.isCandidateCurrent(pending.candidate)) {
            requireFreshAliasRead(
              "The prepared native-alias read epoch retired before delivery could be committed.",
            );
          }
          snapshots.issue(snapshot, pending.page);
          if (!sessions.commit(pending.candidate)) {
            throw new Error("Native alias candidate changed during synchronous delivery commit.");
          }
          return;
        }

        const snapshot = snapshots.peek(pending.scope, pending.snapshotId);
        if (pending.kind === "edit" && pending.authority) {
          if (
            !pending.fingerprint ||
            !pending.canonicalWorktree ||
            !sessions.isActive(
              hookInput.sessionID,
              pending.fingerprint,
              pending.canonicalWorktree,
              pending.authority,
            )
          ) {
            requireFreshAliasRead(
              "The native-alias epoch that produced this edit readback is no longer active.",
            );
          }
          snapshots.assertAuthority(snapshot, pending.authority);
          if (
            !sessions.isActive(
              hookInput.sessionID,
              pending.fingerprint,
              pending.canonicalWorktree,
              pending.authority,
            )
          ) {
            requireFreshAliasRead(
              "The native-alias epoch that produced this edit readback retired before delivery.",
            );
          }
        }
        snapshots.issue(snapshot, pending.page);
      } catch (error) {
        if (pending.kind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            error instanceof HashlineError
              ? error.message
              : "SNAPSHOT_REQUIRED: Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
        } else {
          unavailableEditReadback(output, pending.fallbackOutput);
        }
      }
    },
    async "experimental.chat.system.transform"(hookInput, output) {
      let guidance: string;
      if (initializationError) {
        guidance = `Better Hashline configuration is invalid and file mutation is disabled: ${initializationError} Do not bypass this state with shell commands or another mutation tool. Repair the configuration, restart, then begin with a fresh delivered hashline_read.`;
      } else if (options.toolSurface === "native-aliases" && aliasAvailabilityError) {
        guidance = `Better Hashline native aliases are unavailable and file mutation is disabled: ${aliasAvailabilityError} Do not bypass this state with shell commands or another mutation tool. Repair the host/plugin configuration, restart, then begin with a fresh delivered hashline_read.`;
      } else if (options.toolSurface === "native-aliases") {
        const state = await aliasSessionStatus(hookInput.sessionID);
        const concurrency =
          state === "bound"
            ? "native-alias-session=bound. Alias calls with disjoint complete source/destination path sets may run concurrently; overlapping path sets serialize. Calls remain independently approved; move_file remains nontransactional."
            : state === "mismatch"
              ? "native-alias-session=mismatch. Run hashline_read again and wait for its returned result; use only that new snapshot ID, because old IDs cannot be revived."
              : "native-alias-session=unbound. Do not call edit or apply_patch. Run hashline_read and wait for its returned result; only successful delivery binds the session.";
        guidance = `Better Hashline native aliases are active. ${concurrency} Use native read for inspection and hashline_read before edit or apply_patch. These aliases accept Better Hashline filePath/snapshotId/operations JSON, never native oldString/newString or patchText syntax, and require source and destination paths inside the current worktree. hashline_write is create-only; omitted/false createParents requires an existing parent. Native write and hashline_edit are disabled. Do not mutate files via shell. Hashline line/control prefixes are annotations; allowHashlinePrefixes:true is only for intentional source text. After configuration, schema, host, or surface changes, restart and run a fresh hashline_read; alternatively, explicitly configure enforce:true with toolSurface:"hashline", restart, and reread. Never fall back silently or reuse old IDs. Better Hashline must be the last plugin defining these aliases.`;
      } else if (options.enforce) {
        guidance = `Better Hashline is active. Use native read for inspection, directories, images, and PDFs. Before changing an existing text file, use hashline_read and then hashline_edit. ${EDIT_SEMANTICS_GUIDANCE} Use hashline_write only to create an absent file; omitted/false createParents requires an existing parent, while true intentionally creates missing parents. Inspect the target and tree after PARTIAL_PUBLICATION. Native edit, write, and apply_patch are disabled. Do not use shell commands to modify files. N| and N!| prefixes from hashline_read are annotations, not file content.`;
      } else {
        guidance = `Better Hashline migration mode exposes two separate workflows. Prefer hashline_read followed by hashline_edit for an existing UTF-8 text file, and hashline_write for a new file; omitted/false createParents requires an existing parent. When a native mutator changes an existing file, first use native read. Native write or apply_patch may create an absent target without a preceding read. Never pass hashline output or snapshot IDs to native mutators. ${EDIT_SEMANTICS_GUIDANCE}`;
      }
      output.system.push(guidance);
    },
    async "tool.definition"(input, output) {
      if (input.toolID === "read") {
        output.description += initializationError
          ? "\nBetter Hashline is fail-closed because its configuration is invalid. Editable snapshot issuance and file mutation are unavailable. Do not bypass this state; repair the configuration, restart, then run a fresh hashline_read."
          : options.toolSurface === "native-aliases" && aliasAvailabilityError
            ? "\nBetter Hashline is fail-closed because native aliases are unavailable. Editable snapshot issuance and file mutation are unavailable. Do not bypass this state; repair the host/plugin configuration, restart, then run a fresh hashline_read."
            : !options.enforce
              ? "\nMigration mode has two separate workflows: use native read before a native mutator changes an existing file; native write or apply_patch may create an absent target without a preceding read. Use hashline_read only with hashline_edit, and never pass hashline output or snapshot IDs to native mutators."
              : options.toolSurface === "native-aliases"
                ? "\nFor any worktree text file that may be changed with Better Hashline's edit or apply_patch alias, use hashline_read and wait for its returned result first."
                : "\nFor any text file that may be edited, use hashline_read instead so the edit has an exact snapshot.";
      }
    },
    async dispose() {
      pendingSnapshots.clear();
      snapshots.clear();
      sessions.clear();
    },
  };
};
