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
  authorizeExternal,
  authorizeRead,
  publishNewFile,
  publishReplacement,
  readStableFile,
  resolveExistingFile,
  resolveNewFile,
  throwIfAborted,
  withPathLock,
} from "./filesystem.js";
import {
  detectOpenCodeVersion,
  openCodeProviderSchema,
  readOpenCodeSessionHistory,
} from "./native-alias.js";
import { type ResolvedOptions, resolveOptions } from "./options.js";
import { exactRelativePath, sameFilesystemRoot } from "./path-identity.js";
import {
  buildNativeAliasMetadata,
  countUnifiedDiffChanges,
  jsonSha256,
  NATIVE_ALIAS_METADATA_MAX_BYTES,
  nativeAliasProtocolFingerprint,
} from "./presentation.js";
import { renderSnapshotPage } from "./render.js";
import {
  assertNativeAliasHistory,
  buildNativeAliasDisplayPrefixRejectionMetadata,
  displayPrefixRejectionMessage,
  findHashlineDisplayPrefix,
  type HashlineDisplayPrefixMatch,
  type NativeAliasBindingStatus,
  NativeAliasCurrentCallPendingError,
  type NativeAliasProtocolIdentity,
  NativeAliasSessionRegistry,
  SESSION_HISTORY_FETCH_LIMIT,
} from "./session-protocol.js";
import {
  type IssuedPage,
  type Snapshot,
  type SnapshotScope,
  SnapshotStore,
  sha256,
} from "./snapshots.js";
import { assertLineLimit, decodeTextDocument, encodeNewText } from "./text.js";
import { PACKAGE_VERSION } from "./version.js";

const NATIVE_MUTATORS = new Set(["edit", "write", "apply_patch"]);

const readArgumentShape = {
  filePath: tool.schema.string().min(1).describe("Path relative to the session directory"),
  offset: tool.schema.number().int().min(1).optional().describe("One-based first line"),
  limit: tool.schema
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum rendered lines; defaults to 1000"),
};
const readArguments = tool.schema.object(readArgumentShape).strict();

function createEditSchema() {
  const editOperation = tool.schema
    .object({
      op: tool.schema
        .enum(["replace", "insert", "replace_file", "copy_range", "move_range"])
        .describe(
          "Required: replace(startLine,endLine,lines); insert(afterLine,lines); replace_file(lines); copy_range/move_range(startLine,endLine,afterLine). Optional only: replace_file(finalNewline). All other fields are forbidden.",
        ),
      startLine: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only for replace, copy_range, and move_range; one-based inclusive."),
      endLine: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only for replace, copy_range, and move_range; one-based inclusive."),
      afterLine: tool.schema
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Only for insert, copy_range, and move_range; 0 means before line 1. Copy may target its source; move forbids destinations strictly inside its source and rejects adjacent identity destinations.",
        ),
      lines: tool.schema
        .array(tool.schema.string().max(16 * 1024 * 1024))
        .max(100_000)
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
    })
    .strict()
    .describe("Fields not listed for the selected op are invalid; replace_file must be sole.");
  const argumentShape = {
    filePath: tool.schema.string().min(1),
    snapshotId: tool.schema.string().regex(/^s_[A-Za-z0-9_-]{22}$/),
    rebase: tool.schema
      .enum(["none", "unique"])
      .optional()
      .describe(
        "none is default; unique only relocates a still-retained snapshot after external changes, and replace_file forbids unique.",
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
        "Use for structural verification or a follow-up edit; returns a bounded, potentially partial attested successor near the first hunk.",
      ),
    operations: tool.schema.array(editOperation).min(1).max(100),
  };
  return {
    argumentShape,
    argumentsSchema: tool.schema.object(argumentShape).strict(),
  };
}

const editSchema = createEditSchema();
const editArgumentShape = editSchema.argumentShape;
export const hashlineEditArgumentsSchema = editSchema.argumentsSchema;

export const hashlineEditDescription =
  'Atomically edit one exact hashline_read snapshot. Batch changes to this file. Pass top-level snapshotId and operations JSON; do not encode arguments as text. Operations use one immutable pre-batch snapshot: copy reads pre-edit source, and afterLine is never adjusted. replace_file must be sole and use rebase:none; finalNewline is replace_file-only. Destructive writes may be adjacent but not overlap. Insert/copy destinations may touch a destructive endpoint, but may not lie inside a destructive span or share a destination. replace lines:[] deletes; insert forbids []; an empty file uses replace_file with lines:[],finalNewline:false. lines:[""] is one empty logical line and may change only EOL bytes. readback:true returns a successor for verification/follow-up; partial pages say partial=true. unique exactly relocates a still-retained snapshot after external changes; it cannot revive a consumed or unknown snapshot.';

export const nativeAliasEditDescription = `${hashlineEditDescription} Native aliases: serialize while system guidance says native-alias-session=unbound; when bound, different paths may run concurrently but the same path remains serialized.`;

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
  filePath: tool.schema.string().min(1),
  content: tool.schema
    .string()
    .max(16 * 1024 * 1024)
    .describe("Complete file content"),
};
const writeArguments = tool.schema.object(writeArgumentShape).strict();

type PendingSnapshot = {
  kind: "read" | "edit";
  snapshotId: string;
  scope: SnapshotScope;
  page: IssuedPage;
  outputDigest: string;
  createdAt: number;
  fallbackOutput?: string;
};

type RawEditOperation = {
  op: "replace" | "insert" | "replace_file" | "copy_range" | "move_range";
  startLine?: number | undefined;
  endLine?: number | undefined;
  afterLine?: number | undefined;
  lines?: string[] | undefined;
  finalNewline?: boolean | undefined;
};

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

function invalidArguments(toolName: string): never {
  fail("INVALID_ARGUMENT", `Invalid ${toolName} arguments.`);
}

function rejectDisplayPrefix(match: HashlineDisplayPrefixMatch): never {
  fail("DISPLAY_PREFIX_REJECTED", displayPrefixRejectionMessage(match));
}

function parseOperations(
  operations: readonly RawEditOperation[],
  maxFileBytes: number,
  maxLines: number,
): EditOperation[] {
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
        fail("UNSUPPORTED_FILE", "Replacement payload exceeds the configured safety limits.");
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
      op: operation.op,
      startLine: operation.startLine,
      endLine: operation.endLine,
      afterLine: operation.afterLine,
    };
  });
}

function assertIssued(
  store: SnapshotStore,
  snapshot: Snapshot,
  operations: readonly EditOperation[],
  rebase: RebaseMode,
): void {
  const hasTransfer = operations.some(
    (operation) => operation.op === "copy_range" || operation.op === "move_range",
  );
  if (hasTransfer) {
    const ranges = new Map<string, { startLine: number; endLine: number }>();
    const boundaries = new Set<number>();
    const addRange = (startLine: number, endLine: number): void => {
      ranges.set(`${startLine}:${endLine}`, { startLine, endLine });
    };
    for (const operation of operations) {
      if (operation.op === "replace") {
        addRange(operation.startLine, operation.endLine);
      } else if (operation.op === "insert") {
        boundaries.add(operation.afterLine);
      } else if (operation.op === "copy_range") {
        addRange(operation.startLine, operation.endLine);
        boundaries.add(operation.afterLine);
      } else if (operation.op === "move_range") {
        addRange(operation.startLine, operation.endLine);
        const corridor = moveCorridor(operation);
        addRange(corridor.startLine, corridor.endLine);
        boundaries.add(operation.afterLine);
      }
    }
    const orderedRanges = [...ranges.values()].sort(
      (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
    );
    for (const range of orderedRanges) {
      store.assertRangeIssued(snapshot, range.startLine, range.endLine);
    }
    for (const boundary of [...boundaries].sort((left, right) => left - right)) {
      store.assertBoundaryIssued(snapshot, boundary);
    }
    return;
  }

  const legacyOperations = operations as readonly Extract<
    EditOperation,
    { op: "replace" | "insert" | "replace_file" }
  >[];
  for (const operation of legacyOperations) {
    if (operation.op === "replace") {
      store.assertRangeIssued(snapshot, operation.startLine, operation.endLine);
    } else if (operation.op === "insert") {
      store.assertBoundaryIssued(snapshot, operation.afterLine);
    } else {
      if (rebase !== "none") {
        fail("INVALID_ARGUMENT", "replace_file does not support unique rebase.");
      }
      store.assertComplete(snapshot);
    }
  }
}

function withoutPendingMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  const { hashlinePending: _pending, ...rest } = metadata as Record<string, unknown>;
  return rest;
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

function unavailableEditReadback(output: string): string {
  const firstLine = output.split("\n", 1)[0] ?? "";
  const success = /^Applied \d+ operations?\.$/u.test(firstLine)
    ? firstLine
    : "The edit was applied.";
  return editResultOutput(success, "unavailable");
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
      fail("CONFIG_INVALID", initializationError);
    }
  }

  function assertAliasAvailable(): {
    identity: NativeAliasProtocolIdentity;
    fingerprint: string;
  } {
    if (aliasAvailabilityError || !aliasIdentity || !aliasFingerprint) {
      fail(
        "TOOL_SURFACE_UNAVAILABLE",
        aliasAvailabilityError ?? "Native alias protocol identity is unavailable.",
      );
    }
    return { identity: aliasIdentity, fingerprint: aliasFingerprint };
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
          "OpenCode worktree and directory use different filesystem roots. Start a new session before editing.",
        );
      }
      canonicalWorktree =
        parse(candidate).root === candidate ? candidate : await realpath(candidate);
    } catch {
      fail(
        "SESSION_PROTOCOL_MISMATCH",
        "OpenCode worktree identity could not be inspected. Start a new session before editing.",
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

  async function assertAliasSession(
    sessionId: string,
    directory: string,
    worktree: string,
    currentCall?: { id: string; tool: "edit" | "apply_patch"; input?: unknown },
  ): Promise<{
    canonicalWorktree: string;
    identity: NativeAliasProtocolIdentity;
    fingerprint: string;
  }> {
    const binding = await resolveAliasSessionBinding(directory, worktree);
    const { identity, fingerprint } = binding;
    if (sessions.isBound(sessionId, fingerprint)) return binding;

    const historyOptions =
      currentCall === undefined ? { sessionId, directory } : { currentCall, sessionId, directory };
    const settleDelaysMs = [0, 5, 15, 30, 50] as const;
    let settleDeadline: number | undefined;
    for (let attempt = 0; ; attempt += 1) {
      let messages: unknown;
      try {
        const remainingMs =
          settleDeadline === undefined
            ? undefined
            : Math.max(1, Math.floor(settleDeadline - performance.now()));
        messages = await readOpenCodeSessionHistory(
          input.client,
          sessionId,
          directory,
          SESSION_HISTORY_FETCH_LIMIT,
          remainingMs,
        );
      } catch {
        fail(
          "SESSION_PROTOCOL_MISMATCH",
          "OpenCode session history could not be inspected. Start a new session before editing.",
        );
      }
      try {
        assertNativeAliasHistory(messages, identity, historyOptions);
        break;
      } catch (error) {
        if (!(error instanceof NativeAliasCurrentCallPendingError)) throw error;
        settleDeadline ??= performance.now() + 160;
        const delay = settleDelaysMs[attempt];
        if (delay === undefined || performance.now() + delay >= settleDeadline) {
          fail(
            "SESSION_PROTOCOL_MISMATCH",
            "OpenCode current alias input did not stabilize within the bounded inspection window. Start a new session before editing.",
          );
        }
        await Bun.sleep(delay);
      }
    }
    sessions.bind(sessionId, fingerprint);
    return binding;
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
        ? "Read a UTF-8 text file and issue an exact snapshot for Better Hashline's edit or apply_patch alias. Output lines use N|content; prefixes are not file content. Use native read instead for directories, media, PDFs, or inspection that will not be edited."
        : "Read a UTF-8 text file and issue an exact snapshot for hashline_edit. Output lines use N|content; prefixes are not file content. Use native read instead for directories, media, PDFs, or inspection that will not be edited.",
    args: readArgumentShape,
    async execute(rawArgs, context) {
      assertConfigured();
      throwIfAborted(context.abort);
      const parsed = readArguments.safeParse(rawArgs);
      if (!parsed.success) invalidArguments("hashline_read");
      const args = parsed.data;
      const resolved = await resolveExistingFile(args.filePath, context.directory);
      await authorizeExternal(context, resolved);
      await authorizeRead(context, resolved);
      const stable = await readStableFile(resolved, options.maxFileBytes, false, context.abort);
      const document = decodeTextDocument(stable.bytes, options.maxLines);
      const snapshot = snapshots.remember(scopeFor(context), resolved.canonicalPath, document);
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
        page: rendered.page,
        outputDigest: sha256(new TextEncoder().encode(rendered.output)),
        createdAt: Date.now(),
      });
      const shownPath = displayPath(context.worktree, resolved.canonicalPath);
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
    if (!parsed.success) invalidArguments(toolName);
    const args = parsed.data;
    const aliasBinding =
      toolName === "hashline_edit"
        ? undefined
        : await assertAliasSession(context.sessionID, context.directory, context.worktree);
    const operations = parseOperations(args.operations, options.maxFileBytes, options.maxLines);
    const rebase = args.rebase ?? "none";
    if (rebase !== "none" && rebase !== "unique") {
      fail("INVALID_ARGUMENT", "rebase must be none or unique.");
    }
    const displayPrefix = args.allowHashlinePrefixes
      ? undefined
      : findHashlineDisplayPrefix(operations);
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
    const resolved = await resolveExistingFile(args.filePath, context.directory);
    const shownPath = displayPath(
      aliasBinding?.canonicalWorktree ?? context.worktree,
      resolved.canonicalPath,
    );
    const aliasPath = shownPath.replaceAll("\\", "/");
    if (
      toolName !== "hashline_edit" &&
      (isAbsolute(shownPath) || aliasPath === ".." || aliasPath.startsWith("../"))
    ) {
      fail("UNSUPPORTED_FILE", "Native aliases cannot edit files outside the current worktree.");
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

      return await withPathLock(resolved.canonicalPath, async () => {
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

        const diffPath = toolName === "hashline_edit" ? shownPath : shownPath.replaceAll("\\", "/");
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
          consume: () => snapshots.invalidatePath(scope, resolved.canonicalPath),
        });
        const successOutput = `Applied ${plan.operationCount} operation${plan.operationCount === 1 ? "" : "s"}.`;
        let output = editResultOutput(successOutput, "none");
        let resultMetadata = metadata;
        if (args.readback) {
          const fallbackOutput = editResultOutput(successOutput, "unavailable");
          try {
            const document = decodeTextDocument(verified.bytes, options.maxLines);
            const successor = snapshots.remember(scope, resolved.canonicalPath, document);
            const prefix = `${editResultOutput(successOutput, "attached")}\n`;
            const rendered = renderSnapshotPage({
              snapshot: successor,
              offset: firstNewFileHunkLine(diff),
              limit: 1000,
              maxOutputBytes: options.maxOutputBytes - Buffer.byteLength(prefix, "utf8"),
            });
            output = `${prefix}${rendered.output}`;
            const pendingId = randomUUID();
            rememberPending(pendingId, {
              kind: "edit",
              snapshotId: successor.id,
              scope: successor.scope,
              page: rendered.page,
              outputDigest: sha256(new TextEncoder().encode(output)),
              createdAt: Date.now(),
              fallbackOutput,
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
      });
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
        ? "CREATE ONLY: create a new UTF-8 file. Never call hashline_write after hashline_read, for an existing path, or to overwrite/edit content. This tool fails if any file, directory, or symlink already exists at the target. Use hashline_read followed by edit or apply_patch for every existing file."
        : "Create a new UTF-8 file. This tool is create-only and fails if any file, directory, or symlink already exists at the target. Use hashline_edit for existing files.",
    args: writeArgumentShape,
    async execute(rawArgs, context) {
      assertConfigured();
      if (options.toolSurface === "native-aliases") assertAliasAvailable();
      throwIfAborted(context.abort);
      const parsed = writeArguments.safeParse(rawArgs);
      if (!parsed.success) invalidArguments("hashline_write");
      const args = parsed.data;
      if (Buffer.byteLength(args.content, "utf8") > options.maxFileBytes) {
        fail("UNSUPPORTED_FILE", "The new file exceeds maxFileBytes.");
      }
      const bytes = encodeNewText(args.content);
      decodeTextDocument(bytes, options.maxLines);
      const resolved = await resolveNewFile(args.filePath, context.directory);
      await authorizeExternal(context, resolved);
      const shownPath = displayPath(context.worktree, resolved.canonicalPath);
      const diff = unifiedDiff(shownPath, "", args.content);

      return await withPathLock(resolved.canonicalPath, async () => {
        await assertTargetAbsent(resolved);
        await authorizeEdit(context, resolved, diff);
        await publishNewFile({ resolved, bytes, signal: context.abort });
        context.metadata({ title: shownPath, metadata: { diff } });
        return {
          title: shownPath,
          output: "Created the file. Use hashline_read before editing it.",
          metadata: { diff, created: true },
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
          `Use hashline_edit for existing files or hashline_write for new files instead of ${hookInput.tool}.`,
        );
      }
      if (!options.enforce) return;
      if (hookInput.tool === "write" || hookInput.tool === "hashline_edit") {
        assertConfigured();
        fail(
          "NATIVE_TOOL_DISABLED",
          hookInput.tool === "write"
            ? "Use hashline_write to create a new file; native write is disabled."
            : "hashline_edit is unavailable on the native-aliases surface. Start a new session after changing surfaces.",
        );
      }
      if (hookInput.tool !== "edit" && hookInput.tool !== "apply_patch") return;
      assertConfigured();
      if (!hashlineEditArgumentsSchema.safeParse(output.args).success) {
        invalidArguments(hookInput.tool);
      }
      await assertAliasSession(hookInput.sessionID, input.directory, input.worktree, {
        id: hookInput.callID,
        tool: hookInput.tool,
        input: output.args,
      });
    },
    async "tool.execute.after"(input, output) {
      if (
        (input.tool === "edit" || input.tool === "apply_patch") &&
        output.output.startsWith("DISPLAY_PREFIX_REJECTED:") &&
        typeof output.metadata?.betterHashlineRejection === "object" &&
        output.metadata.betterHashlineRejection !== null
      ) {
        return;
      }
      const isRead = input.tool === "hashline_read";
      const isEditReadback =
        (input.tool === "hashline_edit" || input.tool === "edit" || input.tool === "apply_patch") &&
        typeof input.args === "object" &&
        input.args !== null &&
        (input.args as Record<string, unknown>).readback === true;
      if (!isRead && !isEditReadback) return;
      const expectedKind = isRead ? "read" : "edit";
      const pendingId = output.metadata?.hashlinePending;
      if (typeof pendingId !== "string") {
        output.metadata = withoutPendingMetadata(output.metadata);
        if (isRead) {
          delete output.metadata.snapshotId;
          output.output =
            "SNAPSHOT_REQUIRED: OpenCode did not preserve the snapshot marker. Rerun hashline_read.";
        } else {
          output.output = unavailableEditReadback(output.output);
        }
        return;
      }
      const pending = pendingSnapshots.get(pendingId);
      pendingSnapshots.delete(pendingId);
      output.metadata = withoutPendingMetadata(output.metadata);
      if (!pending || pending.kind !== expectedKind) {
        if (isRead) {
          delete output.metadata.snapshotId;
          output.output = "SNAPSHOT_REQUIRED: Rerun hashline_read before editing.";
        } else {
          output.output = pending?.fallbackOutput ?? unavailableEditReadback(output.output);
        }
        return;
      }
      if (output.metadata.truncated === true) {
        if (isRead) {
          output.output =
            "SNAPSHOT_REQUIRED: OpenCode truncated this result, so no editable lines were issued. Use a smaller limit.";
          delete output.metadata.snapshotId;
        } else {
          output.output = pending.fallbackOutput ?? unavailableEditReadback(output.output);
        }
        return;
      }
      if (sha256(new TextEncoder().encode(output.output)) !== pending.outputDigest) {
        if (isRead) {
          output.output =
            "SNAPSHOT_REQUIRED: Another hook changed this result, so no editable lines were issued. Rerun hashline_read.";
          delete output.metadata.snapshotId;
        } else {
          output.output = pending.fallbackOutput ?? unavailableEditReadback(output.output);
        }
        return;
      }
      try {
        const snapshot = snapshots.peek(pending.scope, pending.snapshotId);
        snapshots.issue(snapshot, pending.page);
      } catch (error) {
        if (isRead) {
          output.output =
            error instanceof HashlineError
              ? error.message
              : "SNAPSHOT_REQUIRED: Rerun hashline_read before editing.";
          delete output.metadata.snapshotId;
        } else {
          output.output = pending.fallbackOutput ?? unavailableEditReadback(output.output);
        }
      }
    },
    async "experimental.chat.system.transform"(hookInput, output) {
      let guidance: string;
      if (initializationError) {
        guidance = `Better Hashline configuration is invalid and file mutation is disabled: ${initializationError}`;
      } else if (options.toolSurface === "native-aliases" && aliasAvailabilityError) {
        guidance = `Better Hashline native aliases are unavailable and file mutation is disabled: ${aliasAvailabilityError}`;
      } else if (options.toolSurface === "native-aliases") {
        const state = await aliasSessionStatus(hookInput.sessionID);
        const concurrency =
          state === "bound"
            ? "native-alias-session=bound. Different paths may run concurrently; serialize the same path. Calls remain independently approved and non-transactional."
            : state === "mismatch"
              ? "native-alias-session=mismatch. Start a new session before editing."
              : "native-alias-session=unbound. Never issue edit or apply_patch calls concurrently or in the same assistant message; wait for each result until one exact before-hook binds the session.";
        guidance = `Better Hashline native aliases are active. ${concurrency} Use native read for inspection and hashline_read before edit or apply_patch. Pass top-level snapshotId and operations JSON. hashline_write is create-only; native write and hashline_edit are disabled. Do not edit via shell. Hashline line/control prefixes are annotations; set allowHashlinePrefixes:true in the initial call only for literal source text. Restart into a new session after configuration changes; Better Hashline must be the last plugin defining these aliases.`;
      } else if (options.enforce) {
        guidance =
          "Better Hashline is active. Use native read for inspection, directories, images, and PDFs. Before changing an existing text file, use hashline_read and then hashline_edit. Use hashline_write only to create a new file. Native edit, write, and apply_patch are disabled. Do not use shell commands to modify files. N| and N!| prefixes from hashline_read are annotations, not file content.";
      } else {
        guidance =
          "Better Hashline is available. Prefer hashline_read followed by hashline_edit for existing UTF-8 text files, and hashline_write for new files. Native editing tools remain enabled by configuration.";
      }
      output.system.push(guidance);
    },
    async "tool.definition"(input, output) {
      if (input.toolID === "read") {
        output.description +=
          options.toolSurface === "native-aliases"
            ? "\nFor any text file that may be edited with Better Hashline's edit or apply_patch alias, use hashline_read instead so the edit has an exact snapshot."
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
