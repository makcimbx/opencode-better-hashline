import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { createTwoFilesPatch } from "diff";
import type { EditOperation, RebaseMode } from "./edits.js";
import { planEdits } from "./edits.js";
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
import { type ResolvedOptions, resolveOptions } from "./options.js";
import { renderSnapshotPage } from "./render.js";
import {
  type IssuedPage,
  type Snapshot,
  type SnapshotScope,
  SnapshotStore,
  sha256,
} from "./snapshots.js";
import { assertLineLimit, decodeTextDocument, encodeNewText } from "./text.js";

const NATIVE_MUTATORS = new Set(["edit", "write", "apply_patch"]);

const editOperation = tool.schema.object({
  op: tool.schema.enum(["replace", "insert", "replace_file"]),
  startLine: tool.schema.number().int().min(1).optional(),
  endLine: tool.schema.number().int().min(1).optional(),
  afterLine: tool.schema.number().int().min(0).optional(),
  lines: tool.schema.array(tool.schema.string().max(16 * 1024 * 1024)).max(100_000),
  finalNewline: tool.schema.boolean().optional(),
});

type PendingRead = {
  snapshotId: string;
  scope: SnapshotScope;
  canonicalPath: string;
  page: IssuedPage;
  outputDigest: string;
  createdAt: number;
};

type RawEditOperation = {
  op: "replace" | "insert" | "replace_file";
  startLine?: number | undefined;
  endLine?: number | undefined;
  afterLine?: number | undefined;
  lines: string[];
  finalNewline?: boolean | undefined;
};

function scopeFor(context: { sessionID: string; worktree: string }): SnapshotScope {
  return { sessionId: context.sessionID, worktree: context.worktree };
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function displayPath(worktree: string, canonicalPath: string): string {
  return relative(worktree, canonicalPath) || canonicalPath;
}

function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, "before", "after", { context: 3 });
}

function assertNoDisplayPrefixes(operations: readonly EditOperation[]): void {
  for (const operation of operations) {
    for (const line of operation.lines) {
      if (/^(?:\d+[!]?\||@(?:hashline|more|eof|note)(?:\s|$))/u.test(line)) {
        fail(
          "DISPLAY_PREFIX_REJECTED",
          "A replacement line looks copied from hashline_read. Remove the annotation, or set allowHashlinePrefixes only when that prefix is intentional file content.",
        );
      }
    }
  }
}

function parseOperations(
  operations: readonly RawEditOperation[],
  maxFileBytes: number,
  maxLines: number,
): EditOperation[] {
  let totalBytes = 0;
  let totalLines = 0;
  for (const operation of operations) {
    totalLines += operation.lines.length;
    for (const line of operation.lines) {
      totalBytes += Buffer.byteLength(line, "utf8") + 2;
      if (totalBytes > maxFileBytes || totalLines > maxLines) {
        fail("UNSUPPORTED_FILE", "Replacement payload exceeds the configured safety limits.");
      }
    }
  }
  return operations.map((operation) => {
    if (operation.op === "replace") {
      if (
        operation.startLine === undefined ||
        operation.endLine === undefined ||
        operation.afterLine !== undefined ||
        operation.finalNewline !== undefined
      ) {
        fail(
          "INVALID_ARGUMENT",
          "replace requires startLine and endLine, and does not accept afterLine or finalNewline.",
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
        operation.afterLine === undefined ||
        operation.startLine !== undefined ||
        operation.endLine !== undefined ||
        operation.finalNewline !== undefined
      ) {
        fail(
          "INVALID_ARGUMENT",
          "insert requires afterLine, and does not accept startLine, endLine, or finalNewline.",
        );
      }
      if (operation.lines.length === 0 || operation.lines.length > 20_000) {
        fail("INVALID_ARGUMENT", "insert requires between 1 and 20,000 lines.");
      }
      return { op: "insert", afterLine: operation.afterLine, lines: operation.lines };
    }

    if (
      operation.startLine !== undefined ||
      operation.endLine !== undefined ||
      operation.afterLine !== undefined
    ) {
      fail("INVALID_ARGUMENT", "replace_file does not accept line coordinates.");
    }
    return {
      op: "replace_file",
      lines: operation.lines,
      ...(operation.finalNewline === undefined ? {} : { finalNewline: operation.finalNewline }),
    };
  });
}

function assertIssued(
  store: SnapshotStore,
  snapshot: Snapshot,
  operations: readonly EditOperation[],
  rebase: RebaseMode,
): void {
  for (const operation of operations) {
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

export const betterHashlinePlugin: Plugin = async (_input, rawOptions) => {
  let initializationError: string | undefined;
  let options: ResolvedOptions;
  try {
    options = resolveOptions(rawOptions);
  } catch (error) {
    initializationError = error instanceof Error ? error.message : "Invalid plugin options.";
    options = resolveOptions({ enforce: true });
  }
  const snapshots = new SnapshotStore(options);
  const pendingReads = new Map<string, PendingRead>();

  function assertConfigured(): void {
    if (initializationError) {
      fail("CONFIG_INVALID", initializationError);
    }
  }

  function rememberPending(pendingId: string, pending: PendingRead): void {
    const expiredBefore = Date.now() - options.snapshotTtlMs;
    for (const [id, value] of pendingReads) {
      if (value.createdAt >= expiredBefore && pendingReads.size < options.maxSnapshots) break;
      pendingReads.delete(id);
      snapshots.invalidatePath(value.scope, value.canonicalPath);
    }
    pendingReads.set(pendingId, pending);
  }

  const hashlineRead = tool({
    description:
      "Read a UTF-8 text file and issue an exact snapshot for hashline_edit. Output lines use N|content; prefixes are not file content. Use native read instead for directories, media, PDFs, or inspection that will not be edited.",
    args: {
      filePath: tool.schema.string().min(1).describe("Path relative to the session directory"),
      offset: tool.schema.number().int().min(1).optional().describe("One-based first line"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum rendered lines; defaults to 1000"),
    },
    async execute(args, context) {
      assertConfigured();
      throwIfAborted(context.abort);
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
        snapshotId: snapshot.id,
        scope: snapshot.scope,
        canonicalPath: snapshot.canonicalPath,
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

  const hashlineEdit = tool({
    description:
      'Apply a validation-atomic line edit to an exact hashline_read snapshot. Deletion is lines: []; a blank line is lines: [""]. rebase defaults to none; unique only relocates unchanged, unambiguous text and never uses fuzzy matching.',
    args: {
      filePath: tool.schema.string().min(1),
      snapshotId: tool.schema.string().regex(/^s_[A-Za-z0-9_-]{22}$/),
      rebase: tool.schema.enum(["none", "unique"]).default("none"),
      allowHashlinePrefixes: tool.schema
        .boolean()
        .optional()
        .describe("Set true only to write an intentional N| or @hashline-style source line"),
      operations: tool.schema.array(editOperation).min(1).max(100),
    },
    async execute(args, context) {
      assertConfigured();
      throwIfAborted(context.abort);
      const resolved = await resolveExistingFile(args.filePath, context.directory);
      const scope = scopeFor(context);
      const snapshot = snapshots.pin(scope, args.snapshotId);
      try {
        if (!sameCanonicalPath(snapshot.canonicalPath, resolved.canonicalPath)) {
          fail("PATH_MISMATCH", "The snapshot belongs to a different canonical path.");
        }
        await authorizeExternal(context, resolved);
        const operations = parseOperations(args.operations, options.maxFileBytes, options.maxLines);
        const rebase = args.rebase ?? "none";
        if (rebase !== "none" && rebase !== "unique") {
          fail("INVALID_ARGUMENT", "rebase must be none or unique.");
        }
        if (!args.allowHashlinePrefixes) assertNoDisplayPrefixes(operations);
        assertIssued(snapshots, snapshot, operations, rebase);

        return await withPathLock(resolved.canonicalPath, async () => {
          const stable = await readStableFile(resolved, options.maxFileBytes, true, context.abort);
          const current = decodeTextDocument(stable.bytes, options.maxLines);
          const plan = planEdits({
            base: snapshot.document,
            current,
            operations,
            rebase,
            maxContextLines: options.maxContextLines,
          });
          if (plan.bytes.byteLength > options.maxFileBytes) {
            fail("UNSUPPORTED_FILE", "The edited file exceeds maxFileBytes.");
          }
          assertLineLimit(plan.bytes, options.maxLines);

          const shownPath = displayPath(context.worktree, resolved.canonicalPath);
          const diff = unifiedDiff(shownPath, current.text, plan.text);
          await authorizeEdit(context, resolved, diff);
          await publishReplacement({
            resolved,
            expected: stable,
            replacement: plan.bytes,
            maxBytes: options.maxFileBytes,
            signal: context.abort,
            consume: () => snapshots.invalidatePath(scope, resolved.canonicalPath),
          });
          context.metadata({ title: shownPath, metadata: { diff } });
          return {
            title: shownPath,
            output: `Applied ${plan.operationCount} operation${plan.operationCount === 1 ? "" : "s"}. Reread before the next edit.`,
            metadata: {
              diff,
              operationCount: plan.operationCount,
              rebased: plan.rebased,
            },
          };
        });
      } finally {
        snapshots.release(snapshot);
      }
    },
  });

  const hashlineWrite = tool({
    description:
      "Create a new UTF-8 file. This tool is create-only and fails if any file, directory, or symlink already exists at the target. Use hashline_edit for existing files.",
    args: {
      filePath: tool.schema.string().min(1),
      content: tool.schema
        .string()
        .max(16 * 1024 * 1024)
        .describe("Complete file content"),
    },
    async execute(args, context) {
      assertConfigured();
      throwIfAborted(context.abort);
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

  return {
    tool: {
      hashline_read: hashlineRead,
      hashline_edit: hashlineEdit,
      hashline_write: hashlineWrite,
    },
    async "chat.message"(_input, output) {
      if (!options.enforce) return;
      output.message.tools ??= {};
      for (const name of NATIVE_MUTATORS) output.message.tools[name] = false;
    },
    async "tool.execute.before"(input) {
      if (options.enforce && NATIVE_MUTATORS.has(input.tool)) {
        if (initializationError) {
          fail("CONFIG_INVALID", initializationError);
        }
        fail(
          "NATIVE_TOOL_DISABLED",
          `Use hashline_edit for existing files or hashline_write for new files instead of ${input.tool}.`,
        );
      }
    },
    async "tool.execute.after"(input, output) {
      if (input.tool !== "hashline_read") return;
      const pendingId = output.metadata?.hashlinePending;
      if (typeof pendingId !== "string") {
        const snapshotId = output.metadata?.snapshotId;
        if (typeof snapshotId === "string") {
          for (const [id, pending] of pendingReads) {
            if (pending.snapshotId !== snapshotId) continue;
            pendingReads.delete(id);
            snapshots.invalidatePath(pending.scope, pending.canonicalPath);
          }
        }
        output.metadata = withoutPendingMetadata(output.metadata);
        delete output.metadata.snapshotId;
        output.output =
          "SNAPSHOT_REQUIRED: OpenCode did not preserve the snapshot marker. Rerun hashline_read.";
        return;
      }
      const pending = pendingReads.get(pendingId);
      pendingReads.delete(pendingId);
      output.metadata = withoutPendingMetadata(output.metadata);
      if (!pending) {
        delete output.metadata.snapshotId;
        output.output = "SNAPSHOT_REQUIRED: Rerun hashline_read before editing.";
        return;
      }
      if (output.metadata.truncated === true) {
        snapshots.invalidatePath(pending.scope, pending.canonicalPath);
        output.output =
          "SNAPSHOT_REQUIRED: OpenCode truncated this result, so no editable lines were issued. Use a smaller limit.";
        delete output.metadata.snapshotId;
        return;
      }
      if (sha256(new TextEncoder().encode(output.output)) !== pending.outputDigest) {
        snapshots.invalidatePath(pending.scope, pending.canonicalPath);
        output.output =
          "SNAPSHOT_REQUIRED: Another hook changed this result, so no editable lines were issued. Rerun hashline_read.";
        delete output.metadata.snapshotId;
        return;
      }
      try {
        const snapshot = snapshots.peek(pending.scope, pending.snapshotId);
        snapshots.issue(snapshot, pending.page);
      } catch (error) {
        output.output =
          error instanceof HashlineError
            ? error.message
            : "SNAPSHOT_REQUIRED: Rerun hashline_read before editing.";
        delete output.metadata.snapshotId;
      }
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(
        initializationError
          ? `Better Hashline configuration is invalid and file mutation is disabled: ${initializationError}`
          : options.enforce
            ? "Better Hashline is active. Use native read for inspection, directories, images, and PDFs. Before changing an existing text file, use hashline_read and then hashline_edit. Use hashline_write only to create a new file. Native edit, write, and apply_patch are disabled. Do not use shell commands to modify files. N| and N!| prefixes from hashline_read are annotations, not file content."
            : "Better Hashline is available. Prefer hashline_read followed by hashline_edit for existing UTF-8 text files, and hashline_write for new files. Native editing tools remain enabled by configuration.",
      );
    },
    async "tool.definition"(input, output) {
      if (input.toolID === "read") {
        output.description +=
          "\nFor any text file that may be edited, use hashline_read instead so the edit has an exact snapshot.";
      }
    },
    async dispose() {
      pendingReads.clear();
      snapshots.clear();
    },
  };
};
