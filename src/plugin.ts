import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, parse, resolve } from "node:path";
import { type Plugin, type ToolContext, type ToolResult, tool } from "@opencode-ai/plugin";
import { createTwoFilesPatch } from "diff";
import type { EditOperation, RebaseMode } from "./edits.js";
import { moveCorridor, planEdits, resolveTextRebaseMode, validateEditOperations } from "./edits.js";
import { fail, HashlineError } from "./errors.js";
import {
  assertTargetAbsent,
  authorizeEdit,
  authorizeEdits,
  authorizeExternal,
  authorizeRead,
  canonicalizeRoot,
  pathsAlias,
  publishDeletedFile,
  publishMovedFile,
  publishNewFileWithParents,
  publishReplacement,
  type ResolvedFile,
  readStableFile,
  resolveExistingFile,
  resolveMutableFile,
  resolveNewFile,
  resolveNewFileParentPlan,
  type StableFile,
  stabilizeMutableFile,
  stabilizeNewFile,
  stabilizeNewFileParentPlan,
  throwIfAborted,
  withPathLock,
  withPathLocks,
} from "./filesystem.js";
import type { LspUnavailableWarning, NormalizedLspDiagnostic } from "./lsp-diagnostics.js";
import { createLspManager, type LspManager, type ResolvedLspServerConfig } from "./lsp-manager.js";
import {
  buildLspOutput,
  type HostOutputLimits,
  type LspAppendixReport,
  lspLegacyLimits,
  outputLineCount,
} from "./lsp-output.js";
import { detectOpenCodeVersion, openCodeProviderSchema } from "./native-alias.js";
import {
  ABSOLUTE_MAX_LOGICAL_LINES,
  type ResolvedOptions,
  resolveLspDiagnosticServers,
  resolveOptions,
} from "./options.js";
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
      "Maximum rendered lines; defaults to 1000. Output remains bounded by maxOutputBytes. Every @hashline header reports coverage=partial|complete from evidence issued when rendered plus the candidate page. complete becomes authoritative only if that exact page is delivered and attested; partial may later become complete after another page. partial=true remains page-local and may accompany @more or @eof, including with coverage=complete.",
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
          "Only for replace_file; omit to preserve snapshot state, except lines:[] defaults to false. true requires non-empty lines.",
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
      "Fields not listed for the selected op are invalid; replace_file is a text edit that supports readback and must be sole; file lifecycle operations must be sole. One move_range may compose with pairwise-disjoint replace operations wholly inside its intervening corridor and outside its source; the complete corridor must be issued and unchanged.",
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
        "When omitted, valid incremental batches (replace, insert, copy_range, move_range) use unique, while replace_file, delete_file, and move_file use none. Explicit none requires full-byte freshness; explicit unique relocates a still-retained snapshot after external changes and is forbidden for strict-only operations. Exact unique proves textual identity only, not semantic independence or edit-history causality.",
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
        "Optional; defaults to false unless readbackOffset or readbackLimit is supplied. For a text edit, including replace_file, true requests one bounded successor page for verification or follow-up, but the attachment can be unavailable after a successful mutation. Only delete_file and move_file reject true and all readback window fields.",
      ),
    readbackOffset: tool.schema
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "For text edits, including replace_file. Supplying this one-based post-edit start implies readback unless readback:false is explicit; omit to start near the first hunk.",
      ),
    readbackLimit: tool.schema
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_MAX_LOGICAL_LINES)
      .optional()
      .describe(
        "For text edits, including replace_file. Supplying this maximum rendered-line count implies readback unless readback:false is explicit; defaults to 1000. Output remains bounded by maxOutputBytes. Every attached @hashline header reports coverage=partial|complete from evidence issued when rendered plus the candidate page. complete becomes authoritative only if that exact page is delivered and attested; partial may later become complete after another page. partial=true remains page-local and may accompany @more or @eof, including with coverage=complete.",
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

export const hashlineEditDescription = `Mutate one exact hashline_read snapshot. Text batches, including sole strict replace_file, publish one atomic replacement. File lifecycle operations are sole calls; move_file is nontransactional, and PARTIAL_PUBLICATION may leave both source and destination names present. Pass required top-level filePath, snapshotId, and operations JSON plus only the documented optional controls; do not encode arguments as text. ${EDIT_SEMANTICS_GUIDANCE} copy reads pre-edit source. When rebase is omitted, valid incremental batches use exact unique relocation after byte drift; fresh bytes require no relocation. A changed-byte unique success reports "Exact unique rebase occurred." This does not imply coordinate movement. replace_file, delete_file, and move_file use strict freshness and require complete issued coverage; unique rebase is forbidden. Only delete_file and move_file are lifecycle operations; they never return successor readback and reject readback:true or either window field. Destructive writes may be adjacent but not overlap; insert/copy destinations may touch a destructive endpoint but may not lie inside a destructive span or share a destination. Successful publication invalidates every retained snapshot for the affected session paths and returns a diff plus receipt. For text edits, including replace_file, readback:true or either window field requests one successor page, but the attachment can be unavailable; without an attached successor, run hashline_read before another mutation. After PARTIAL_PUBLICATION, inspect and reconcile every affected path before retrying.`;

export const nativeAliasEditDescription = `Better Hashline alias; it does not accept native oldString/newString or patchText syntax. Wait for hashline_read's returned result before calling it; native-alias-session must be bound, and source and destination paths must be inside the current worktree. Persisted alias metadata is capped at ${NATIVE_ALIAS_METADATA_MAX_BYTES} UTF-8 bytes; split incremental changes into sequential calls, using an adequate attached successor or fresh read between calls. Oversized sole lifecycle calls require explicit enforce:true with toolSurface:"hashline", restart, and fresh delivered hashline_read. ${hashlineEditDescription}`;

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

async function canonicalDisplayRoot(
  worktree: string,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const candidate = hostWorktreePath(worktree, directory);
  try {
    return await canonicalizeRoot(candidate, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    fail(
      "PATH_MISMATCH",
      "OpenCode's display root could not be resolved consistently. No publication occurred; restore path access or repair the active worktree before retrying.",
    );
  }
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

function resolveEditRebase(batch: ParsedEditBatch, requested: RebaseMode | undefined): RebaseMode {
  if (batch.kind !== "text") return requested ?? "none";
  return resolveTextRebaseMode(batch.operations, requested);
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
        fail(
          "INVALID_ARGUMENT",
          "replace_file does not support unique rebase. No mutation occurred. An otherwise-valid supplied snapshot remains usable; omit rebase or set it to none, then retry.",
        );
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
  /^Applied (?:1 operation|(?:[2-9]|[1-9]\d+) operations)\.(?: Exact unique rebase occurred\.)?$/u;

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

type CommittedFile = Readonly<{
  bytes: Uint8Array;
  dev: number;
  ino: number;
  nlink: number;
}>;

type LspLifecycleCompletion = {
  lspCompletion: true;
  operation: "delete_file" | "move_file";
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  source: ResolvedFile;
  destination?: ResolvedFile;
  destinationShown?: string;
  destinationFile?: CommittedFile;
  text: string;
  sourceRevision: number;
  destinationRevision?: number;
};

type LspTextCompletion = {
  lspCompletion: true;
  title: string;
  metadata: Record<string, unknown>;
  diff: string;
  successOutput: string;
  publishedText: string;
  publishedFile: CommittedFile;
  successor: Snapshot | undefined;
  revision: number;
};

type LspWriteCompletion = {
  lspCompletion: true;
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  resultMetadata: Record<string, unknown>;
  resolved: ResolvedFile;
  publishedFile: CommittedFile;
  revision: number;
};

function lspRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lspPosition(value: unknown): { line: number; character: number } | undefined {
  const position = lspRecord(value);
  if (!position) return undefined;
  const { line, character } = position;
  if (
    typeof line !== "number" ||
    !Number.isSafeInteger(line) ||
    line < 0 ||
    typeof character !== "number" ||
    !Number.isSafeInteger(character) ||
    character < 0
  ) {
    return undefined;
  }
  return { line, character };
}

function normalizeLspDiagnostics(value: unknown, relativePath: string): NormalizedLspDiagnostic[] {
  const result = lspRecord(value);
  if (!result || !Array.isArray(result.servers)) return [];
  const normalized: NormalizedLspDiagnostic[] = [];
  for (const serverValue of result.servers) {
    const server = lspRecord(serverValue);
    if (
      server?.status !== "ok" ||
      typeof server.serverId !== "string" ||
      !Array.isArray(server.diagnostics)
    ) {
      continue;
    }
    for (const diagnosticValue of server.diagnostics) {
      const diagnostic = lspRecord(diagnosticValue);
      const range = lspRecord(diagnostic?.range);
      const start = lspPosition(range?.start);
      const end = lspPosition(range?.end);
      if (
        !diagnostic ||
        typeof diagnostic.message !== "string" ||
        !start ||
        !end ||
        end.line < start.line ||
        (end.line === start.line && end.character < start.character)
      ) {
        continue;
      }
      const severity =
        typeof diagnostic.severity === "number" && Number.isSafeInteger(diagnostic.severity)
          ? diagnostic.severity
          : 0;
      const code =
        typeof diagnostic.code === "string" ||
        (typeof diagnostic.code === "number" && Number.isFinite(diagnostic.code))
          ? diagnostic.code
          : undefined;
      normalized.push({
        relativePath,
        startLine: start.line,
        startCharacter: start.character,
        severity,
        serverId: server.serverId,
        ...(code === undefined ? {} : { code }),
        message: diagnostic.message,
      });
    }
  }
  return normalized;
}

function normalizeLspWarnings(value: unknown): LspUnavailableWarning[] {
  const result = lspRecord(value);
  if (!result) return [];
  const normalized: LspUnavailableWarning[] = [];
  const append = (warnings: unknown, fallbackServerId?: string): void => {
    if (!Array.isArray(warnings)) return;
    for (const warningValue of warnings) {
      const warning = lspRecord(warningValue);
      if (!warning || typeof warning.code !== "string") continue;
      const serverId = typeof warning.serverId === "string" ? warning.serverId : fallbackServerId;
      normalized.push({
        code: warning.code,
        ...(serverId === undefined ? {} : { serverId }),
      });
    }
  };
  append(result.warnings);
  if (Array.isArray(result.servers)) {
    for (const serverValue of result.servers) {
      const server = lspRecord(serverValue);
      if (!server) continue;
      append(server.warnings, typeof server.serverId === "string" ? server.serverId : undefined);
    }
  }
  return normalized;
}

function normalizeLspReport(value: unknown, relativePath: string): LspAppendixReport {
  return {
    diagnostics: normalizeLspDiagnostics(value, relativePath),
    warnings: normalizeLspWarnings(value),
  };
}

function failedLspReport(code: string): LspAppendixReport {
  return { diagnostics: [], warnings: [{ code }] };
}

const HOST_OUTPUT_DEFAULT_BYTES = 50 * 1024;
const HOST_OUTPUT_DEFAULT_LINES = 2_000;
const HOST_OUTPUT_MAX_BYTES = 1024 * 1024;
const HOST_OUTPUT_MAX_LINES = 100_000;

function committedFile(stable: StableFile): CommittedFile {
  return Object.freeze({
    bytes: stable.bytes,
    dev: stable.stats.dev,
    ino: stable.stats.ino,
    nlink: stable.stats.nlink,
  });
}

function hasFileIdentity(value: Pick<CommittedFile, "dev" | "ino">): boolean {
  return value.dev !== 0 || value.ino !== 0;
}

async function publishedFileStillMatchesUnlocked(
  resolved: ResolvedFile,
  expected: CommittedFile,
  maxBytes: number,
): Promise<boolean> {
  const stable = await readStableFile(resolved, maxBytes, false);
  const currentIdentity = { dev: stable.stats.dev, ino: stable.stats.ino };
  const expectedHasIdentity = hasFileIdentity(expected);
  const currentHasIdentity = hasFileIdentity(currentIdentity);
  return (
    expected.nlink === 1 &&
    stable.stats.nlink === 1 &&
    bytesEqual(stable.bytes, expected.bytes) &&
    ((!expectedHasIdentity && !currentHasIdentity) ||
      (expectedHasIdentity &&
        currentHasIdentity &&
        stable.stats.dev === expected.dev &&
        stable.stats.ino === expected.ino))
  );
}

async function publishedFileStillMatches(
  resolved: ResolvedFile,
  expected: CommittedFile,
  maxBytes: number,
): Promise<boolean> {
  try {
    return await withPathLock(resolved.canonicalPath, () =>
      publishedFileStillMatchesUnlocked(resolved, expected, maxBytes),
    );
  } catch {
    return false;
  }
}

async function publishedPathStillAbsentUnlocked(
  resolved: ResolvedFile,
  directory: string,
): Promise<boolean> {
  const missing = await resolveNewFile(
    resolved.requestedAbsolute,
    directory,
    "The published lifecycle source must remain absent.",
  );
  if (!sameCanonicalPath(missing.canonicalPath, resolved.canonicalPath)) return false;
  await assertTargetAbsent(missing);
  return true;
}

async function publishedPathStillAbsent(
  resolved: ResolvedFile,
  directory: string,
): Promise<boolean> {
  try {
    return await withPathLock(resolved.canonicalPath, () =>
      publishedPathStillAbsentUnlocked(resolved, directory),
    );
  } catch {
    return false;
  }
}

async function publishedMoveStillMatches(
  source: ResolvedFile,
  destination: ResolvedFile,
  expectedDestination: CommittedFile,
  directory: string,
  maxBytes: number,
): Promise<boolean> {
  try {
    return await withPathLocks(
      [source.canonicalPath, destination.canonicalPath],
      async () =>
        (await publishedPathStillAbsentUnlocked(source, directory)) &&
        (await publishedFileStillMatchesUnlocked(destination, expectedDestination, maxBytes)),
    );
  } catch {
    return false;
  }
}

const IMPORTED_LSP_MAX_ENTRIES = 64;
const IMPORTED_LSP_MAX_BYTES = 256 * 1024;
const CONFIG_FALLBACK_TIMEOUT_MS = 1_000;

function strictDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hostOutputLimitsFromConfig(config: unknown): HostOutputLimits {
  const root = strictDataRecord(config);
  const output = strictDataRecord(root ? dataValue(root, "tool_output") : undefined);
  const configuredBytes = output ? dataValue(output, "max_bytes") : undefined;
  const configuredLines = output ? dataValue(output, "max_lines") : undefined;
  return {
    maxBytes:
      typeof configuredBytes === "number" &&
      Number.isSafeInteger(configuredBytes) &&
      configuredBytes > 0
        ? Math.min(configuredBytes, HOST_OUTPUT_MAX_BYTES)
        : HOST_OUTPUT_DEFAULT_BYTES,
    maxLines:
      typeof configuredLines === "number" &&
      Number.isSafeInteger(configuredLines) &&
      configuredLines > 0
        ? Math.min(configuredLines, HOST_OUTPUT_MAX_LINES)
        : HOST_OUTPUT_DEFAULT_LINES,
  };
}

function importedLspServers(config: unknown): ResolvedLspServerConfig[] {
  try {
    const root = strictDataRecord(config);
    const lsp = root ? dataValue(root, "lsp") : undefined;
    if (lsp === undefined || typeof lsp === "boolean") return [];
    const configured = strictDataRecord(lsp);
    if (!configured) return [];
    const ids = Object.keys(configured).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (ids.length > IMPORTED_LSP_MAX_ENTRIES) return [];

    const imported: ResolvedLspServerConfig[] = [];
    let importedBytes = 0;
    for (const id of ids) {
      if (/^[._$]/u.test(id)) continue;
      const entry = strictDataRecord(dataValue(configured, id));
      if (!entry || dataValue(entry, "disabled") === true) continue;
      const command = dataValue(entry, "command");
      const extensions = dataValue(entry, "extensions");
      if (!Array.isArray(command) || command.length === 0) continue;
      if (!Array.isArray(extensions) || extensions.length === 0) continue;
      const candidate = {
        id,
        command,
        extensions,
        ...(dataValue(entry, "env") === undefined ? {} : { env: dataValue(entry, "env") }),
        ...(dataValue(entry, "initialization") === undefined
          ? {}
          : { initialization: dataValue(entry, "initialization") }),
      };
      try {
        const [server] = resolveLspDiagnosticServers([candidate], "effective config.lsp");
        if (!server) continue;
        const bytes = Buffer.byteLength(JSON.stringify(server), "utf8");
        if (importedBytes + bytes > IMPORTED_LSP_MAX_BYTES) break;
        importedBytes += bytes;
        imported.push(server);
      } catch {
        // Effective host config is advisory input: invalid or unroutable entries are skipped.
      }
    }
    return imported;
  } catch {
    return [];
  }
}

function mergedLspServers(
  imported: readonly ResolvedLspServerConfig[],
  overrides: readonly ResolvedLspServerConfig[],
): ResolvedLspServerConfig[] {
  const merged = new Map<string, ResolvedLspServerConfig>();
  for (const server of imported) merged.set(server.id, server);
  for (const server of overrides) merged.set(server.id, server);
  return [...merged.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
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
  let effectiveConfig: unknown;
  let effectiveConfigCaptured = false;
  let managerConfigurationFrozen = false;
  let hostOutputLimits: HostOutputLimits = {
    maxBytes: HOST_OUTPUT_DEFAULT_BYTES,
    maxLines: HOST_OUTPUT_DEFAULT_LINES,
  };
  let lspManagerPromise: Promise<LspManager | undefined> | undefined;
  let pluginDisposing = false;
  let pluginDisposePromise: Promise<void> | undefined;
  let activeCalls = 0;
  let resolveActiveDrain: (() => void) | undefined;
  let nextDocumentRevision = 0;
  const snapshots = new SnapshotStore(options);
  const pendingSnapshots = new Map<string, PendingSnapshot>();
  const sessions = new NativeAliasSessionRegistry();

  function assertConfigured(): void {
    if (pluginDisposing) {
      fail("CONFIG_INVALID", "Better Hashline is shutting down and no longer accepts tool calls.");
    }
    if (initializationError) {
      fail(
        "CONFIG_INVALID",
        `${initializationError} File mutation and editable snapshot issuance are disabled. Do not bypass this state with shell commands or another mutation tool. Repair the configuration, restart, then run a fresh delivered hashline_read.`,
      );
    }
  }

  async function admitted<T>(operation: () => Promise<T>): Promise<T> {
    assertConfigured();
    activeCalls += 1;
    try {
      return await operation();
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        resolveActiveDrain?.();
        resolveActiveDrain = undefined;
      }
    }
  }

  async function waitForActiveCalls(): Promise<void> {
    if (activeCalls === 0) return;
    await new Promise<void>((resolveDrain) => {
      resolveActiveDrain = resolveDrain;
    });
  }

  function captureEffectiveConfig(config: unknown): void {
    if (managerConfigurationFrozen || effectiveConfigCaptured) return;
    effectiveConfig = config;
    effectiveConfigCaptured = true;
  }

  async function fallbackEffectiveConfig(): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenCode config fallback timed out.")),
          CONFIG_FALLBACK_TIMEOUT_MS,
        );
      });
      const response = await Promise.race([
        input.client.config.get({ query: { directory: input.directory } }),
        timeout,
      ]);
      return lspRecord(response)?.data;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function lspManagerFor(): Promise<LspManager | undefined> {
    if (!lspManagerPromise) {
      const lspOptions = options.lspDiagnostics;
      lspManagerPromise =
        lspOptions === false || aliasAvailabilityError
          ? Promise.resolve(undefined)
          : (async () => {
              if (!effectiveConfigCaptured) {
                const fallback = await fallbackEffectiveConfig();
                captureEffectiveConfig(fallback);
              }
              const config = effectiveConfig;
              managerConfigurationFrozen = true;
              hostOutputLimits = hostOutputLimitsFromConfig(config);
              const servers = mergedLspServers(importedLspServers(config), lspOptions.servers);
              if (servers.length === 0) {
                return undefined;
              }
              return createLspManager({
                worktree: input.worktree === "/" ? input.directory : input.worktree,
                config: { ...lspOptions, servers },
              });
            })().catch((error) => {
              initializationError ??=
                error instanceof Error
                  ? `Managed LSP initialization failed: ${error.message}`
                  : "Managed LSP initialization failed.";
              assertConfigured();
              return undefined;
            });
    }
    return lspManagerPromise;
  }

  function allocateDocumentRevision(): number {
    if (nextDocumentRevision >= Number.MAX_SAFE_INTEGER) {
      fail("TOOL_SURFACE_UNAVAILABLE", "The managed-LSP document revision limit was reached.");
    }
    nextDocumentRevision += 1;
    return nextDocumentRevision;
  }

  function currentDocumentRevision(_canonicalPath: string): number {
    return allocateDocumentRevision();
  }

  function publishDocumentRevision(_canonicalPath: string): number {
    return allocateDocumentRevision();
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
      canonicalWorktree = await canonicalizeRoot(candidate);
    } catch (error) {
      if (error instanceof HashlineError && error.code !== "RACE_BEFORE_WRITE") throw error;
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
        ? "Read an existing UTF-8 text file for Better Hashline's edit or apply_patch alias and prepare a pending exact snapshot. Wait for the returned result; only successful delivery binds the session and makes N| lines editable. Output uses @hashline, N|, N!|, @more, and @eof; every header reports cumulative coverage from evidence issued when rendered plus the candidate page. coverage=complete becomes authoritative only if that exact page is delivered and attested; coverage=partial may later become complete after another page, while partial=true remains page-local. Prefixes are annotations, not file content. An N!| line is preview-only and cannot be issued by smaller pagination; raise maxOutputBytes and reread if it can fit, otherwise stop for manual restructuring or an explicit configuration change. Native-alias mutation requires the target inside the current worktree; external snapshots are inspection-only for aliases. Use native read for directories, media, PDFs, or inspection that will not be edited."
        : "Read an existing UTF-8 text file for hashline_edit and prepare a pending exact snapshot. Wait for the returned result; only successfully delivered N| lines become editable. Output uses @hashline, N|, N!|, @more, and @eof; every header reports cumulative coverage from evidence issued when rendered plus the candidate page. coverage=complete becomes authoritative only if that exact page is delivered and attested; coverage=partial may later become complete after another page, while partial=true remains page-local. Prefixes are annotations, not file content. An N!| line is preview-only and cannot be issued by smaller pagination; raise maxOutputBytes and reread if it can fit, otherwise stop for manual restructuring or an explicit configuration change. Use native read for directories, media, PDFs, or inspection that will not be edited.",
    args: readArgumentShape,
    async execute(rawArgs, context) {
      return admitted(async () => {
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
        const resolved = await resolveExistingFile(args.filePath, context.directory, context.abort);
        await authorizeExternal(context, resolved);
        await authorizeRead(context, resolved);
        const stable = await readStableFile(resolved, options.maxFileBytes, false, context.abort);
        const document = decodeTextDocument(stable.bytes, options.maxLines);
        const revision = currentDocumentRevision(resolved.canonicalPath);
        const manager = await lspManagerFor();
        const shownPath = displayPath(
          binding?.canonicalWorktree ??
            (await canonicalDisplayRoot(context.worktree, context.directory, context.abort)),
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
        if (manager) {
          void manager
            .warm({
              path: resolved.requestedAbsolute,
              canonicalPath: resolved.canonicalPath,
              text: document.text,
              revision,
              signal: context.abort,
            })
            .catch(() => {});
        }
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
      });
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
    const rebase = resolveEditRebase(batch, args.rebase);
    const hasReadbackWindow = args.readbackOffset !== undefined || args.readbackLimit !== undefined;
    const requestReadback = args.readback === true || hasReadbackWindow;
    if (rebase !== "none" && rebase !== "unique") {
      fail("INVALID_ARGUMENT", "rebase must be none or unique.");
    }
    if (batch.kind !== "text" && rebase !== "none") {
      fail(
        "INVALID_ARGUMENT",
        `${batch.kind} does not support unique rebase. No mutation occurred. An otherwise-valid supplied snapshot remains usable; omit rebase or set it to none, then retry.`,
      );
    }
    if (batch.kind !== "text" && requestReadback) {
      fail(
        "INVALID_ARGUMENT",
        `${batch.kind} does not accept readback, readbackOffset, or readbackLimit. Remove them and retry with the same snapshot.`,
      );
    }
    if (hasReadbackWindow && args.readback === false) {
      fail("INVALID_ARGUMENT", "readbackOffset and readbackLimit conflict with readback:false.");
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
    if (batch.kind !== "text") {
      const scope = scopeFor(context);
      const snapshot = snapshots.pin(scope, args.snapshotId);
      try {
        const displayRoot =
          aliasBinding?.canonicalWorktree ??
          (await canonicalDisplayRoot(context.worktree, context.directory, context.abort));
        const resolved = await resolveMutableFile(args.filePath, context.directory, context.abort);
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
                context.abort,
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

        if (!sameCanonicalPath(snapshot.canonicalPath, resolved.canonicalPath)) {
          fail("PATH_MISMATCH", "The snapshot belongs to a different canonical path.");
        }
        snapshots.assertComplete(snapshot, batch.kind);
        const manager = await lspManagerFor();
        await authorizeExternal(context, resolved);
        if (destination) await authorizeExternal(context, destination);

        const lockPaths = destination
          ? [resolved.canonicalPath, destination.canonicalPath]
          : [resolved.canonicalPath];
        const lockedResult = await withPathLocks(
          lockPaths,
          async () => {
            snapshots.assertPinned(snapshot);
            const currentResolved = await stabilizeMutableFile(
              resolved,
              context.directory,
              context.abort,
            );
            const currentDestination = destination
              ? await stabilizeNewFile(destination, context.directory, context.abort)
              : undefined;
            const stable = await readStableFile(
              currentResolved,
              options.maxFileBytes,
              true,
              context.abort,
            );
            if (!bytesEqual(stable.bytes, snapshot.document.bytes)) {
              fail(
                "TARGET_CHANGED",
                "The file no longer matches the exact issued snapshot bytes. This call published nothing; the stale snapshot remains retained but cannot be reused for this strict operation. Run a fresh hashline_read and replan before retrying.",
              );
            }
            if (currentDestination) {
              if (stable.stats.dev !== currentDestination.parentStats.dev) {
                fail(
                  "UNSUPPORTED_FILE",
                  "move_file requires source and destination on one filesystem.",
                );
              }
              await assertTargetAbsent(currentDestination, context.abort);
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
                  `Native alias metadata exceeds ${NATIVE_ALIAS_METADATA_MAX_BYTES} UTF-8 bytes. No publication occurred and the snapshot remains retained. Lifecycle operations cannot be split; explicitly configure enforce:true with toolSurface:"hashline", restart, then run a fresh hashline_read. Never fall back silently.`,
                );
              }
            }

            await authorizeEdits(
              context,
              currentDestination ? [currentResolved, currentDestination] : [currentResolved],
              diff,
            );
            let sourceRevision = currentDocumentRevision(resolved.canonicalPath);
            let destinationRevision = currentDestination
              ? currentDocumentRevision(currentDestination.canonicalPath)
              : undefined;
            let destinationFile: CommittedFile | undefined;
            if (batch.kind === "delete_file") {
              await publishDeletedFile({
                resolved: currentResolved,
                expected: stable,
                maxBytes: options.maxFileBytes,
                signal: context.abort,
                consume: () => {
                  if (aliasBinding) {
                    assertAliasAuthorityCurrent(context.sessionID, aliasBinding);
                  }
                  sourceRevision = publishDocumentRevision(resolved.canonicalPath);
                  snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
                },
              });
            } else if (currentDestination) {
              try {
                const moved = await publishMovedFile({
                  source: currentResolved,
                  destination: currentDestination,
                  expected: stable,
                  maxBytes: options.maxFileBytes,
                  signal: context.abort,
                  consume: () => {
                    if (aliasBinding) {
                      assertAliasAuthorityCurrent(context.sessionID, aliasBinding);
                    }
                    sourceRevision = publishDocumentRevision(resolved.canonicalPath);
                    destinationRevision = publishDocumentRevision(currentDestination.canonicalPath);
                    snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
                    snapshots.invalidateSessionPath(
                      context.sessionID,
                      currentDestination.canonicalPath,
                    );
                  },
                });
                destinationFile = committedFile(moved);
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
            if (!manager) {
              context.metadata({
                title,
                metadata,
              });
              return { title, output, metadata };
            }
            return {
              lspCompletion: true as const,
              operation: batch.kind,
              title,
              output,
              metadata,
              source: currentResolved,
              destination: currentDestination,
              sourceRevision,
              destinationRevision,
              destinationShown,
              destinationFile,
              text: snapshot.document.text,
            };
          },
          context.abort,
        );
        if (!manager || options.lspDiagnostics === false || !("lspCompletion" in lockedResult)) {
          return lockedResult as ToolResult;
        }
        const completion = lockedResult as LspLifecycleCompletion;

        let report: LspAppendixReport;
        let drift = false;
        if (completion.operation === "delete_file") {
          try {
            const lifecycle = await manager.notifyDelete({
              canonicalPath: completion.source.canonicalPath,
              revision: completion.sourceRevision,
              signal: context.abort,
            });
            report = { diagnostics: [], warnings: normalizeLspWarnings(lifecycle) };
          } catch {
            report = failedLspReport("LIFECYCLE_FAILED");
          }
          drift = !(await publishedPathStillAbsent(completion.source, context.directory));
        } else {
          try {
            const move = await manager.notifyMove({
              sourceCanonicalPath: completion.source.canonicalPath,
              sourceRevision: completion.sourceRevision,
              destinationCanonicalPath: completion.destination?.canonicalPath ?? "",
              destinationRevision: completion.destinationRevision ?? 0,
              text: completion.text,
              signal: context.abort,
            });
            report = normalizeLspReport(
              move.destination,
              completion.destinationShown ?? completion.title,
            );
            report.warnings.push(...normalizeLspWarnings(move.source));
          } catch {
            report = failedLspReport("LIFECYCLE_FAILED");
          }
          drift =
            !completion.destination ||
            !completion.destinationFile ||
            !(await publishedMoveStillMatches(
              completion.source,
              completion.destination,
              completion.destinationFile,
              context.directory,
              options.maxFileBytes,
            ));
        }
        if (drift) {
          report.diagnostics = [];
          const quarantines = [
            {
              canonicalPath: completion.source.canonicalPath,
              revision: completion.sourceRevision,
            },
            ...(completion.destination && completion.destinationRevision !== undefined
              ? [
                  {
                    canonicalPath: completion.destination.canonicalPath,
                    revision: completion.destinationRevision,
                  },
                ]
              : []),
          ];
          for (const quarantine of quarantines) {
            try {
              const quarantined = await manager.quarantine({
                ...quarantine,
                signal: context.abort,
              });
              report.warnings.push(...normalizeLspWarnings(quarantined));
            } catch {
              report.warnings.push(...failedLspReport("LIFECYCLE_FAILED").warnings);
            }
          }
        }
        const output = buildLspOutput({
          legacyOutput: completion.output,
          report,
          drift,
          host: hostOutputLimits,
          maxDiagnostics: options.lspDiagnostics.maxDiagnostics,
          maxDiagnosticsBytes: options.lspDiagnostics.maxDiagnosticsBytes,
          maxOutputBytes: options.maxOutputBytes,
        });
        context.metadata({ title: completion.title, metadata: completion.metadata });
        return {
          title: completion.title,
          output,
          metadata: completion.metadata,
        };
      } finally {
        snapshots.release(snapshot);
      }
    }

    const scope = scopeFor(context);
    const snapshot = snapshots.pin(scope, args.snapshotId);
    try {
      const displayRoot =
        aliasBinding?.canonicalWorktree ??
        (await canonicalDisplayRoot(context.worktree, context.directory, context.abort));
      const operations = batch.operations;
      const resolved = await resolveExistingFile(args.filePath, context.directory, context.abort);
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
      if (!sameCanonicalPath(snapshot.canonicalPath, resolved.canonicalPath)) {
        fail("PATH_MISMATCH", "The snapshot belongs to a different canonical path.");
      }
      validateEditOperations(snapshot.document, operations);
      assertIssued(snapshots, snapshot, operations, rebase);
      const manager = await lspManagerFor();
      await authorizeExternal(context, resolved);
      const lockedResult = await withPathLock(
        resolved.canonicalPath,
        async () => {
          snapshots.assertPinned(snapshot);
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
                `Native alias metadata exceeds ${NATIVE_ALIAS_METADATA_MAX_BYTES} UTF-8 bytes. No publication occurred and the snapshot remains retained. Split the edit into smaller sequential calls. After each success, use its attached successor only if it issued the next call's evidence; otherwise run a fresh hashline_read. Alternatively, explicitly configure enforce:true with toolSurface:"hashline", restart, then run a fresh hashline_read. Never fall back silently.`,
              );
            }
          }
          await authorizeEdit(context, resolved, diff);
          let revision = currentDocumentRevision(resolved.canonicalPath);
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
              revision = publishDocumentRevision(resolved.canonicalPath);
              snapshots.invalidateSessionPath(context.sessionID, resolved.canonicalPath);
            },
          });
          const appliedOutput = `Applied ${plan.operationCount} operation${plan.operationCount === 1 ? "" : "s"}.`;
          const successOutput = plan.rebased
            ? `${appliedOutput} Exact unique rebase occurred.`
            : appliedOutput;
          if (!manager) {
            let output = editResultOutput(successOutput, "none");
            let resultMetadata = metadata;
            if (requestReadback) {
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
          }

          let successor: Snapshot | undefined;
          if (requestReadback) {
            try {
              successor = snapshots.remember(
                scope,
                resolved.canonicalPath,
                decodeTextDocument(verified.bytes, options.maxLines),
                aliasBinding?.authority,
              );
            } catch {
              successor = undefined;
            }
          }
          return {
            lspCompletion: true as const,
            title: shownPath,
            metadata,
            diff,
            successOutput,
            publishedText: plan.text,
            publishedFile: committedFile(verified),
            revision,
            successor,
          };
        },
        context.abort,
      );
      if (!manager || options.lspDiagnostics === false || !("lspCompletion" in lockedResult)) {
        return lockedResult as ToolResult;
      }
      const completion = lockedResult as LspTextCompletion;

      let report: LspAppendixReport;
      try {
        const checked = await manager.update({
          canonicalPath: resolved.canonicalPath,
          text: completion.publishedText,
          revision: completion.revision,
          kind: "change",
          signal: context.abort,
        });
        report = normalizeLspReport(checked, shownPath);
      } catch {
        report = failedLspReport("CLIENT_UNAVAILABLE");
      }
      const drift = !(await publishedFileStillMatches(
        resolved,
        completion.publishedFile,
        options.maxFileBytes,
      ));
      if (drift) {
        if (completion.successor) snapshots.invalidate(completion.successor);
        report.diagnostics = [];
        try {
          const quarantined = await manager.quarantine({
            canonicalPath: resolved.canonicalPath,
            revision: completion.revision,
            signal: context.abort,
          });
          report.warnings.push(...normalizeLspWarnings(quarantined));
        } catch {
          report.warnings.push(...failedLspReport("LIFECYCLE_FAILED").warnings);
        }
      }

      let output: string;
      let resultMetadata = completion.metadata;
      const outputInput = {
        report,
        drift,
        host: hostOutputLimits,
        maxDiagnostics: options.lspDiagnostics.maxDiagnostics,
        maxDiagnosticsBytes: options.lspDiagnostics.maxDiagnosticsBytes,
        maxOutputBytes: options.maxOutputBytes,
      };
      if (!requestReadback) {
        output = buildLspOutput({
          ...outputInput,
          legacyOutput: editResultOutput(completion.successOutput, "none"),
        });
      } else {
        const fallbackOutput = buildLspOutput({
          ...outputInput,
          legacyOutput: editResultOutput(completion.successOutput, "unavailable"),
        });
        output = fallbackOutput;
        if (!drift && completion.successor) {
          try {
            const successor = snapshots.peek(scope, completion.successor.id);
            const attachedBase = editResultOutput(completion.successOutput, "attached");
            const legacyLimits = lspLegacyLimits({
              ...outputInput,
              maxOutputBytes: options.maxOutputBytes,
            });
            const prefix = `${attachedBase}\n`;
            const remaining =
              Math.min(options.maxOutputBytes, legacyLimits.maxBytes) -
              Buffer.byteLength(prefix, "utf8");
            if (remaining < 1) throw new Error("No output budget remains for edit readback.");
            const requestedLimit = args.readbackLimit ?? 1000;
            if (
              Number.isFinite(legacyLimits.maxLines) &&
              legacyLimits.maxLines < outputLineCount(attachedBase) + 2
            ) {
              throw new Error("No output line budget remains for edit readback.");
            }
            const availablePageLines = Number.isFinite(legacyLimits.maxLines)
              ? Math.max(0, legacyLimits.maxLines - outputLineCount(attachedBase) - 2)
              : requestedLimit;
            let renderLimit = Math.min(requestedLimit, availablePageLines);
            let rendered = renderSnapshotPage({
              snapshot: successor,
              offset: args.readbackOffset ?? firstNewFileHunkLine(completion.diff),
              limit: renderLimit,
              maxOutputBytes: remaining,
            });
            if (
              Number.isFinite(legacyLimits.maxLines) &&
              outputLineCount(attachedBase) + outputLineCount(rendered.output) >
                legacyLimits.maxLines &&
              renderLimit > 0
            ) {
              renderLimit -= 1;
              rendered = renderSnapshotPage({
                snapshot: successor,
                offset: args.readbackOffset ?? firstNewFileHunkLine(completion.diff),
                limit: renderLimit,
                maxOutputBytes: remaining,
              });
            }
            const legacyOutput = `${prefix}${rendered.output}`;
            output = buildLspOutput({ ...outputInput, legacyOutput });
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
            resultMetadata = { ...completion.metadata, hashlinePending: pendingId };
          } catch {
            output = fallbackOutput;
          }
        }
      }
      context.metadata({
        title: shownPath,
        metadata: toolName === "hashline_edit" ? { diff: completion.diff } : completion.metadata,
      });
      return {
        title: shownPath,
        output,
        metadata: resultMetadata,
      };
    } finally {
      snapshots.release(snapshot);
    }
  }

  async function executeAdmittedSnapshotBoundEdit(
    toolName: SnapshotEditToolName,
    rawArgs: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    return admitted(() => executeSnapshotBoundEdit(toolName, rawArgs, context));
  }

  const hashlineEdit = createSnapshotEditTool("hashline_edit", executeAdmittedSnapshotBoundEdit);
  const nativeEdit = createSnapshotEditTool(
    "edit",
    executeAdmittedSnapshotBoundEdit,
    nativeAliasEditDescription,
  );
  const nativeApplyPatch = createSnapshotEditTool(
    "apply_patch",
    executeAdmittedSnapshotBoundEdit,
    nativeAliasEditDescription,
  );

  const hashlineWrite = tool({
    description:
      options.toolSurface === "native-aliases"
        ? "CREATE ONLY: create an absent UTF-8 file; never use it to overwrite or edit an existing target. A hashline_read of another path does not prohibit creation. For an existing target, use hashline_read followed by edit or apply_patch. Missing parents are reserved automatically, up to 64. Under the original locks and before approval, an exact verified parent prefix that appeared while this call waited may be reused; only the remaining parents are created. After this call creates a directory or a mkdir outcome becomes ambiguous, an error can leave the target and created directories present; inspect them before retrying."
        : "CREATE ONLY: create an absent UTF-8 file; never use it to overwrite or edit an existing target. For an existing target, use hashline_read followed by hashline_edit. Missing parents are reserved automatically, up to 64. Under the original locks and before approval, an exact verified parent prefix that appeared while this call waited may be reused; only the remaining parents are created. After this call creates a directory or a mkdir outcome becomes ambiguous, an error can leave the target and created directories present; inspect them before retrying.",
    args: writeArgumentShape,
    async execute(rawArgs, context) {
      return admitted(async () => {
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
        const reservationPlan = await resolveNewFileParentPlan(
          args.filePath,
          context.directory,
          context.abort,
        );
        const reservedEntries = [
          {
            requestedPath: reservationPlan.requestedPath,
            requestedAbsolute: reservationPlan.requestedAbsolute,
            canonicalPath: reservationPlan.canonicalPath,
          },
          ...reservationPlan.missingDirectories.map((entry) => ({
            requestedPath: entry.requestedPath,
            requestedAbsolute: entry.requestedPath,
            canonicalPath: entry.canonicalPath,
          })),
        ];
        const manager = await lspManagerFor();
        for (const entry of reservedEntries) await authorizeExternal(context, entry);
        const displayRoot = await canonicalDisplayRoot(
          context.worktree,
          context.directory,
          context.abort,
        );
        const shownPath = displayPath(displayRoot, reservationPlan.canonicalPath);
        const diff = unifiedDiff(shownPath, "", args.content);

        const lockedResult = await withPathLocks(
          reservationPlan.lockPaths,
          async () => {
            const plan = await stabilizeNewFileParentPlan(reservationPlan, context.abort);
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
            const shownDirectories = plan.missingDirectories.map((entry) =>
              displayPath(displayRoot, entry.canonicalPath),
            );
            const reusedDirectoryCount =
              reservationPlan.missingDirectories.length - plan.missingDirectories.length;
            const shownReusedDirectories = reservationPlan.missingDirectories
              .slice(0, reusedDirectoryCount)
              .map((entry) => displayPath(displayRoot, entry.canonicalPath));
            await authorizeEdits(
              context,
              plannedEntries,
              diff,
              plan.missingDirectories.map((entry) => entry.canonicalPath),
            );
            let revision = currentDocumentRevision(plan.canonicalPath);
            let verified: StableFile;
            try {
              verified = await publishNewFileWithParents({
                plan,
                bytes,
                signal: context.abort,
                consume: () => {
                  revision = publishDocumentRevision(plan.canonicalPath);
                  for (const mutationPath of reservationPlan.mutationPaths) {
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
            const metadata = {
              diff,
              createdDirectories: shownDirectories,
              ...(shownReusedDirectories.length > 0
                ? { reusedDirectories: shownReusedDirectories }
                : {}),
            };
            const creationNotice =
              shownDirectories.length === 0
                ? "Created the file."
                : `Created ${shownDirectories.length} parent ${shownDirectories.length === 1 ? "directory" : "directories"} and the file.`;
            const reuseNotice =
              shownReusedDirectories.length === 0
                ? ""
                : ` Reused ${shownReusedDirectories.length} verified parent ${shownReusedDirectories.length === 1 ? "directory" : "directories"} that appeared while this call was waiting.`;
            const output = `${creationNotice}${reuseNotice} Use hashline_read before editing it.`;
            const resultMetadata = { ...metadata, created: true };
            if (!manager) {
              context.metadata({ title: shownPath, metadata });
              return {
                title: shownPath,
                output,
                metadata: resultMetadata,
              };
            }
            return {
              lspCompletion: true as const,
              title: shownPath,
              output,
              metadata,
              resultMetadata,
              resolved: {
                requestedPath: plan.requestedPath,
                requestedAbsolute: plan.requestedAbsolute,
                canonicalPath: plan.canonicalPath,
              },
              publishedFile: committedFile(verified),
              revision,
            };
          },
          context.abort,
        );
        if (!manager || options.lspDiagnostics === false || !("lspCompletion" in lockedResult)) {
          return lockedResult as ToolResult;
        }
        const completion = lockedResult as LspWriteCompletion;

        let report: LspAppendixReport;
        try {
          const checked = await manager.check({
            canonicalPath: completion.resolved.canonicalPath,
            text: args.content,
            revision: completion.revision,
            kind: "create",
            signal: context.abort,
          });
          report = normalizeLspReport(checked, shownPath);
        } catch {
          report = failedLspReport("CLIENT_UNAVAILABLE");
        }
        const drift = !(await publishedFileStillMatches(
          completion.resolved,
          completion.publishedFile,
          options.maxFileBytes,
        ));
        if (drift) {
          report.diagnostics = [];
          try {
            const quarantined = await manager.quarantine({
              canonicalPath: completion.resolved.canonicalPath,
              revision: completion.revision,
              signal: context.abort,
            });
            report.warnings.push(...normalizeLspWarnings(quarantined));
          } catch {
            report.warnings.push(...failedLspReport("LIFECYCLE_FAILED").warnings);
          }
        }
        const output = buildLspOutput({
          legacyOutput: completion.output,
          report,
          drift,
          host: hostOutputLimits,
          maxDiagnostics: options.lspDiagnostics.maxDiagnostics,
          maxDiagnosticsBytes: options.lspDiagnostics.maxDiagnosticsBytes,
          maxOutputBytes: options.maxOutputBytes,
        });
        context.metadata({ title: shownPath, metadata: completion.metadata });
        return {
          title: shownPath,
          output,
          metadata: completion.resultMetadata,
        };
      });
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
    async config(config) {
      if (pluginDisposing) return;
      if (!managerConfigurationFrozen && !effectiveConfigCaptured) {
        captureEffectiveConfig(config);
        hostOutputLimits = hostOutputLimitsFromConfig(config);
      }
    },
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
      const toolKind =
        hookInput.tool === "hashline_read"
          ? "read"
          : hookInput.tool === "hashline_edit" ||
              hookInput.tool === "edit" ||
              hookInput.tool === "apply_patch"
            ? "edit"
            : undefined;
      const outputLines = output.output.split("\n", 3);
      const hasSuccessorHeader =
        toolKind === "edit" && /(?:^|\n)@hashline snapshot=\S+(?:\s|$)/u.test(output.output);
      const expectedPendingKind =
        toolKind === "read"
          ? "read"
          : toolKind === "edit" &&
              ((BETTER_HASHLINE_APPLIED_RECEIPT.test(outputLines[0] ?? "") &&
                outputLines[1] === editLifecycleReceipt("attached")) ||
                hasSuccessorHeader)
            ? "edit"
            : undefined;
      const pendingId = output.metadata?.hashlinePending;
      if (typeof pendingId !== "string" && expectedPendingKind === undefined) return;
      if (pluginDisposing) {
        output.metadata = withoutPendingMetadata(output.metadata);
        if (toolKind === "read") {
          output.metadata = withoutPendingSnapshotMetadata(output.metadata);
          output.output =
            "SNAPSHOT_REQUIRED: Better Hashline was disposed before delivery could be attested. Restart and rerun hashline_read; old snapshot IDs cannot be revived.";
        } else if (toolKind === "edit") {
          unavailableEditReadback(output);
        }
        return;
      }
      return admitted(async () => {
        if (typeof pendingId !== "string") {
          if (expectedPendingKind === undefined) return;
          output.metadata = withoutPendingMetadata(output.metadata);
          if (expectedPendingKind === "read") {
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
          if (expectedPendingKind === "read") {
            output.metadata = withoutPendingSnapshotMetadata(output.metadata);
            output.output =
              "SNAPSHOT_REQUIRED: The delivered read did not match a live pending snapshot. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.";
          } else if (toolKind === "edit") {
            unavailableEditReadback(output);
          } else {
            protocolKindMismatch(output);
          }
          return;
        }
        if (toolKind !== pending.kind) {
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
      });
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
        guidance = `Better Hashline native aliases are active. ${concurrency} Use native read for inspection and hashline_read before edit or apply_patch. These aliases accept Better Hashline filePath/snapshotId/operations JSON, never native oldString/newString or patchText syntax, and require source and destination paths inside the current worktree. hashline_write is create-only and reserves up to 64 missing parents; while holding the original locks and before approval, it may reuse only an exact verified parent prefix that appeared while waiting. Native write and hashline_edit are disabled. Do not mutate files via shell. Hashline line/control prefixes are annotations; allowHashlinePrefixes:true is only for intentional source text. After configuration, schema, host, or surface changes, restart and run a fresh hashline_read; alternatively, explicitly configure enforce:true with toolSurface:"hashline", restart, and reread. Never fall back silently or reuse old IDs. Better Hashline must be the last plugin defining these aliases.`;
      } else if (options.enforce) {
        guidance = `Better Hashline is active. Use native read for inspection, directories, images, and PDFs. Before changing an existing text file, use hashline_read and then hashline_edit. ${EDIT_SEMANTICS_GUIDANCE} Use hashline_write only to create an absent file; it reserves up to 64 missing parents and may reuse only an exact verified parent prefix that appeared while waiting before approval. Inspect the target and tree after PARTIAL_PUBLICATION. Native edit, write, and apply_patch are disabled. Do not use shell commands to modify files. N| and N!| prefixes from hashline_read are annotations, not file content.`;
      } else {
        guidance = `Better Hashline migration mode exposes two separate workflows. Prefer hashline_read followed by hashline_edit for an existing UTF-8 text file, and hashline_write for a new file; hashline_write creates missing parents automatically. When a native mutator changes an existing file, first use native read. Native write or apply_patch may create an absent target without a preceding read. Never pass hashline output or snapshot IDs to native mutators. ${EDIT_SEMANTICS_GUIDANCE}`;
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
      if (!pluginDisposePromise) {
        pluginDisposing = true;
        pluginDisposePromise = (async () => {
          try {
            await waitForActiveCalls();
            const manager = await lspManagerPromise?.catch(() => undefined);
            await manager?.dispose();
          } catch {
            // Disposal is advisory, but retained provenance must always be cleared.
          } finally {
            pendingSnapshots.clear();
            snapshots.clear();
            sessions.clear();
            nextDocumentRevision = 0;
          }
        })();
      }
      await pluginDisposePromise;
    },
  };
};
