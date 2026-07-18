import { fail } from "./errors.js";
import { createUniqueMapper } from "./rebase.js";
import { assertLogicalLines, bytesEqual, encodeTextDocument, type TextDocument } from "./text.js";

export type ReplaceOperation = {
  op: "replace";
  startLine: number;
  endLine: number;
  lines: string[];
};

export type InsertOperation = {
  op: "insert";
  afterLine: number;
  lines: string[];
};

export type ReplaceFileOperation = {
  op: "replace_file";
  lines: string[];
  finalNewline?: boolean;
};

export type EditOperation = ReplaceOperation | InsertOperation | ReplaceFileOperation;
export type RebaseMode = "none" | "unique";

export type EditPlan = {
  text: string;
  bytes: Uint8Array;
  operationCount: number;
  rebased: boolean;
};

type MappedChange = {
  start: number;
  end: number;
  replacement: string;
  basePosition: number;
};

function assertLineNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) fail("INVALID_ARGUMENT", `${label} must be an integer.`);
}

function replaceText(
  document: TextDocument,
  startIndex: number,
  endIndex: number,
  lines: readonly string[],
): MappedChange {
  const first = document.lines[startIndex];
  const last = document.lines[endIndex - 1];
  if (!first || !last) fail("TARGET_CHANGED", "The replacement range no longer exists.");
  const eol = last.eol || first.eol || document.preferredEol;
  const replacement = lines.length === 0 ? "" : `${lines.join(eol)}${last.eol ? last.eol : ""}`;
  return {
    start: first.start,
    end: last.end,
    replacement,
    basePosition: 0,
  };
}

function insertText(
  document: TextDocument,
  position: number,
  lines: readonly string[],
): MappedChange {
  if (lines.length === 0) fail("INVALID_ARGUMENT", "insert requires at least one line.");
  const before = document.lines[position - 1];
  const after = document.lines[position];
  const eol = before?.eol || after?.eol || document.preferredEol;

  if (position === document.lines.length) {
    const start = before?.end ?? 0;
    const replacement = before
      ? before.eol
        ? `${lines.join(eol)}${before.eol}`
        : `${eol}${lines.join(eol)}`
      : lines.join(eol);
    return { start, end: start, replacement, basePosition: 0 };
  }

  const start = after?.start ?? 0;
  return {
    start,
    end: start,
    replacement: `${lines.join(eol)}${eol}`,
    basePosition: 0,
  };
}

function changesOverlap(left: MappedChange, right: MappedChange): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function assertCompatibleChanges(changes: readonly MappedChange[]): void {
  for (let left = 0; left < changes.length; left += 1) {
    for (let right = left + 1; right < changes.length; right += 1) {
      const first = changes[left];
      const second = changes[right];
      if (first && second && changesOverlap(first, second)) {
        fail("OPERATIONS_OVERLAP", "Edit operations overlap after relocation.");
      }
    }
  }

  const byBase = [...changes].sort((left, right) => left.basePosition - right.basePosition);
  for (let index = 1; index < byBase.length; index += 1) {
    const previous = byBase[index - 1];
    const current = byBase[index];
    if (previous && current && previous.start > current.start) {
      fail("AMBIGUOUS_RELOCATION", "Relocated operations changed their original order.");
    }
  }
}

function assertBaseOperationsCompatible(operations: readonly EditOperation[]): void {
  for (let left = 0; left < operations.length; left += 1) {
    for (let right = left + 1; right < operations.length; right += 1) {
      const first = operations[left];
      const second = operations[right];
      if (!first || !second || first.op === "replace_file" || second.op === "replace_file")
        continue;
      if (first.op === "insert" && second.op === "insert") {
        if (first.afterLine === second.afterLine) {
          fail("OPERATIONS_OVERLAP", "Multiple insertions use the same snapshot boundary.");
        }
        continue;
      }
      const insertion = first.op === "insert" ? first : second.op === "insert" ? second : undefined;
      const replacement =
        first.op === "replace" ? first : second.op === "replace" ? second : undefined;
      if (insertion && replacement) {
        const start = replacement.startLine - 1;
        const end = replacement.endLine;
        if (insertion.afterLine >= start && insertion.afterLine <= end) {
          fail("OPERATIONS_OVERLAP", "An insertion touches a replacement range boundary.");
        }
        continue;
      }
      if (
        first.op === "replace" &&
        second.op === "replace" &&
        first.startLine - 1 < second.endLine &&
        second.startLine - 1 < first.endLine
      ) {
        fail("OPERATIONS_OVERLAP", "Replacement ranges overlap in the snapshot.");
      }
    }
  }
}

function renderWholeFile(
  base: TextDocument,
  operation: ReplaceFileOperation,
): { text: string; bytes: Uint8Array } {
  assertLogicalLines(operation.lines);
  const finalNewline = operation.finalNewline ?? base.finalNewline;
  if (operation.lines.length === 0 && finalNewline) {
    fail("INVALID_ARGUMENT", 'Use lines: [""] to represent a file containing one newline.');
  }
  const text = `${operation.lines.join(base.preferredEol)}${finalNewline ? base.preferredEol : ""}`;
  return { text, bytes: encodeTextDocument(text, base.bom) };
}

export function validateEditOperations(
  base: TextDocument,
  operations: readonly EditOperation[],
): void {
  if (operations.length === 0) fail("INVALID_ARGUMENT", "At least one operation is required.");
  const wholeFile = operations.find((operation) => operation.op === "replace_file");
  if (wholeFile) {
    if (operations.length !== 1) {
      fail("OPERATIONS_OVERLAP", "replace_file must be the only operation.");
    }
    renderWholeFile(base, wholeFile);
    return;
  }

  for (const operation of operations) {
    assertLogicalLines(operation.lines);
    if (operation.op === "replace") {
      assertLineNumber(operation.startLine, "startLine");
      assertLineNumber(operation.endLine, "endLine");
      if (
        operation.startLine < 1 ||
        operation.endLine < operation.startLine ||
        operation.endLine > base.lines.length
      ) {
        fail("INVALID_ARGUMENT", "The replacement range is outside the snapshot.");
      }
    } else if (operation.op === "insert") {
      assertLineNumber(operation.afterLine, "afterLine");
      if (operation.afterLine < 0 || operation.afterLine > base.lines.length) {
        fail("INVALID_ARGUMENT", "The insertion boundary is outside the snapshot.");
      }
    }
  }
  assertBaseOperationsCompatible(operations);
}

export function planEdits(input: {
  base: TextDocument;
  current: TextDocument;
  operations: readonly EditOperation[];
  rebase: RebaseMode;
  maxContextLines: number;
}): EditPlan {
  const { base, current, operations, rebase, maxContextLines } = input;
  validateEditOperations(base, operations);
  const unchanged = bytesEqual(base.bytes, current.bytes);
  if (!unchanged && rebase === "none") {
    fail("TARGET_CHANGED", "The file changed since hashline_read. Reread before editing.");
  }
  if (!unchanged && base.bom !== current.bom) {
    fail("TARGET_CHANGED", "The file byte-order mark changed since hashline_read.");
  }

  const wholeFile = operations.find((operation) => operation.op === "replace_file");
  if (wholeFile) {
    if (rebase !== "none" || !unchanged) {
      fail("TARGET_CHANGED", "replace_file requires an exact, current snapshot.");
    }
    const result = renderWholeFile(base, wholeFile);
    if (bytesEqual(result.bytes, current.bytes)) fail("NO_CHANGE", "The edit changes no bytes.");
    return { ...result, operationCount: 1, rebased: false };
  }

  const changes: MappedChange[] = [];
  const mapper = unchanged ? undefined : createUniqueMapper(base.lines, current.lines);
  for (const operation of operations) {
    if (operation.op === "replace") {
      const baseStart = operation.startLine - 1;
      const length = operation.endLine - operation.startLine + 1;
      const currentStart = unchanged
        ? baseStart
        : mapper?.mapRange(operation.startLine, operation.endLine, maxContextLines).start;
      if (currentStart === undefined) fail("TARGET_CHANGED", "The target cannot be relocated.");
      const change = replaceText(current, currentStart, currentStart + length, operation.lines);
      change.basePosition = baseStart * 2;
      changes.push(change);
      continue;
    }

    if (operation.op === "replace_file") {
      fail("OPERATIONS_OVERLAP", "replace_file must be the only operation.");
    }
    const currentPosition = unchanged
      ? operation.afterLine
      : mapper?.mapBoundary(operation.afterLine, maxContextLines);
    if (currentPosition === undefined)
      fail("BOUNDARY_CHANGED", "The boundary cannot be relocated.");
    const change = insertText(current, currentPosition, operation.lines);
    change.basePosition = operation.afterLine * 2 + 1;
    changes.push(change);
  }

  assertCompatibleChanges(changes);
  let text = current.text;
  const descending = [...changes].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (const change of descending) {
    text = `${text.slice(0, change.start)}${change.replacement}${text.slice(change.end)}`;
  }
  const bytes = encodeTextDocument(text, current.bom);
  if (bytesEqual(bytes, current.bytes)) fail("NO_CHANGE", "The edit changes no bytes.");
  return {
    text,
    bytes,
    operationCount: operations.length,
    rebased: !unchanged,
  };
}
