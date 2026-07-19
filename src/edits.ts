import { fail } from "./errors.js";
import { createUniqueMapper } from "./rebase.js";
import {
  assertLogicalLines,
  bytesEqual,
  decodeTextDocument,
  encodeTextDocument,
  parseTextLines,
  type TextDocument,
} from "./text.js";

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

export type CopyRangeOperation = {
  op: "copy_range";
  startLine: number;
  endLine: number;
  afterLine: number;
};

export type MoveRangeOperation = {
  op: "move_range";
  startLine: number;
  endLine: number;
  afterLine: number;
};

export type TransferOperation = CopyRangeOperation | MoveRangeOperation;
export type EditOperation =
  | ReplaceOperation
  | InsertOperation
  | ReplaceFileOperation
  | TransferOperation;
export type RebaseMode = "none" | "unique";

export type EditPlan = {
  text: string;
  bytes: Uint8Array;
  operationCount: number;
  rebased: boolean;
};

type LineSpan = {
  /** Zero-based, inclusive. */
  start: number;
  /** Zero-based, exclusive. */
  end: number;
};

type ChangeLocation = {
  start: number;
  end: number;
  basePosition: number;
};

type MappedChange = ChangeLocation & {
  replacement: string;
};

type TextStats = {
  textLength: number;
  utf8Bytes: number;
  delimiters: number;
  endsWithEol: boolean;
  startsWithLf: boolean;
  endsWithCr: boolean;
};

type MoveValidation = {
  basePosition: number;
  isLayoutValid(): boolean;
  isNoChange(): boolean;
};

type PlannedChange = ChangeLocation & {
  stats: TextStats;
  render: () => string;
  move?: MoveValidation;
};

type Effect = {
  read?: LineSpan;
  destructive?: LineSpan;
  insertion?: number;
};

type RangeAnchor = {
  kind: "range";
  span: LineSpan;
  key: string;
};

type BoundaryAnchor = {
  kind: "boundary";
  position: number;
  key: string;
};

type Anchor = RangeAnchor | BoundaryAnchor;

type MappedReplace = {
  op: "replace";
  operation: ReplaceOperation;
  target: LineSpan;
};

type MappedInsert = {
  op: "insert";
  operation: InsertOperation;
  destination: number;
};

type MappedCopy = {
  op: "copy_range";
  operation: CopyRangeOperation;
  source: LineSpan;
  destination: number;
};

type MappedMove = {
  op: "move_range";
  operation: MoveRangeOperation;
  source: LineSpan;
  corridor: LineSpan;
  destination: number;
};

type MappedOperation = MappedReplace | MappedInsert | MappedCopy | MappedMove;

const EMPTY_STATS: TextStats = {
  textLength: 0,
  utf8Bytes: 0,
  delimiters: 0,
  endsWithEol: false,
  startsWithLf: false,
  endsWithCr: false,
};

function assertLineNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) fail("INVALID_ARGUMENT", `${label} must be an integer.`);
}

function rangeFor(startLine: number, endLine: number): LineSpan {
  return { start: startLine - 1, end: endLine };
}

export function moveCorridor(operation: MoveRangeOperation): {
  startLine: number;
  endLine: number;
} {
  if (
    operation.afterLine === operation.startLine - 1 ||
    operation.afterLine === operation.endLine
  ) {
    return { startLine: operation.startLine, endLine: operation.endLine };
  }
  if (operation.afterLine < operation.startLine - 1) {
    return { startLine: operation.afterLine + 1, endLine: operation.endLine };
  }
  if (operation.afterLine > operation.endLine) {
    return { startLine: operation.startLine, endLine: operation.afterLine };
  }
  fail("INVALID_ARGUMENT", "The move destination must be outside the source range.");
}

function moveCorridorSpan(operation: MoveRangeOperation): LineSpan {
  const corridor = moveCorridor(operation);
  return rangeFor(corridor.startLine, corridor.endLine);
}

function insertionLayout(
  document: TextDocument,
  position: number,
): {
  start: number;
  eol: string;
  prefix: string;
  suffix: string;
} {
  const before = document.lines[position - 1];
  const after = document.lines[position];
  const eol = before?.eol || after?.eol || document.preferredEol;

  if (position === document.lines.length) {
    const start = before?.end ?? 0;
    if (!before) return { start, eol, prefix: "", suffix: "" };
    return before.eol
      ? { start, eol, prefix: "", suffix: before.eol }
      : { start, eol, prefix: eol, suffix: "" };
  }

  return { start: after?.start ?? 0, eol, prefix: "", suffix: eol };
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
  const layout = insertionLayout(document, position);
  return {
    start: layout.start,
    end: layout.start,
    replacement: `${layout.prefix}${lines.join(layout.eol)}${layout.suffix}`,
    basePosition: 0,
  };
}

function changesOverlap(left: ChangeLocation, right: ChangeLocation): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function assertCompatibleChanges(changes: readonly ChangeLocation[]): void {
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

function spansIntersect(left: LineSpan, right: LineSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function assertEffectsCompatible(effects: readonly Effect[], relocated: boolean): void {
  let readWriteConflict = false;
  let destructiveConflict = false;
  let insertionDestructiveConflict = false;
  let insertionConflict = false;
  for (let left = 0; left < effects.length; left += 1) {
    for (let right = left + 1; right < effects.length; right += 1) {
      const first = effects[left];
      const second = effects[right];
      if (!first || !second) continue;
      if (
        (first.read && second.destructive && spansIntersect(first.read, second.destructive)) ||
        (second.read && first.destructive && spansIntersect(second.read, first.destructive))
      ) {
        readWriteConflict = true;
      }
      if (
        first.destructive &&
        second.destructive &&
        spansIntersect(first.destructive, second.destructive)
      ) {
        destructiveConflict = true;
      }
      for (const [insertion, destructive] of [
        [first.insertion, second.destructive],
        [second.insertion, first.destructive],
      ] as const) {
        if (
          insertion !== undefined &&
          destructive &&
          insertion >= destructive.start &&
          insertion <= destructive.end
        ) {
          insertionDestructiveConflict = true;
        }
      }
      if (
        first.insertion !== undefined &&
        second.insertion !== undefined &&
        first.insertion === second.insertion
      ) {
        insertionConflict = true;
      }
    }
  }

  if (readWriteConflict) {
    fail(
      "OPERATIONS_OVERLAP",
      relocated
        ? "A relocated transfer source intersects another operation's write range."
        : "A transfer source intersects another operation's write range.",
    );
  }
  if (destructiveConflict) {
    fail(
      "OPERATIONS_OVERLAP",
      relocated ? "Relocated destructive ranges overlap." : "Destructive ranges overlap.",
    );
  }
  if (insertionDestructiveConflict) {
    fail(
      "OPERATIONS_OVERLAP",
      relocated
        ? "A relocated insertion touches a destructive range boundary."
        : "An insertion touches a destructive range boundary.",
    );
  }
  if (insertionConflict) {
    fail(
      "OPERATIONS_OVERLAP",
      relocated
        ? "Relocated insertions use the same boundary."
        : "Multiple insertions use the same snapshot boundary.",
    );
  }
}

function assertLegacyBaseOperationsCompatible(
  operations: readonly (ReplaceOperation | InsertOperation)[],
): void {
  for (let left = 0; left < operations.length; left += 1) {
    for (let right = left + 1; right < operations.length; right += 1) {
      const first = operations[left];
      const second = operations[right];
      if (!first || !second) continue;
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

function baseEffect(operation: Exclude<EditOperation, ReplaceFileOperation>): Effect {
  if (operation.op === "replace") {
    return { destructive: rangeFor(operation.startLine, operation.endLine) };
  }
  if (operation.op === "insert") return { insertion: operation.afterLine };
  if (operation.op === "copy_range") {
    return {
      read: rangeFor(operation.startLine, operation.endLine),
      insertion: operation.afterLine,
    };
  }
  const corridor = moveCorridorSpan(operation);
  return { read: corridor, destructive: corridor };
}

function mappedEffect(operation: MappedOperation): Effect {
  if (operation.op === "replace") return { destructive: operation.target };
  if (operation.op === "insert") return { insertion: operation.destination };
  if (operation.op === "copy_range") {
    return { read: operation.source, insertion: operation.destination };
  }
  return { read: operation.corridor, destructive: operation.corridor };
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
    if (operation.op === "replace" || operation.op === "insert") {
      assertLogicalLines(operation.lines);
    }
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
      continue;
    }
    if (operation.op === "insert") {
      assertLineNumber(operation.afterLine, "afterLine");
      if (operation.afterLine < 0 || operation.afterLine > base.lines.length) {
        fail("INVALID_ARGUMENT", "The insertion boundary is outside the snapshot.");
      }
      continue;
    }
    if (operation.op === "replace_file") continue;

    assertLineNumber(operation.startLine, "startLine");
    assertLineNumber(operation.endLine, "endLine");
    assertLineNumber(operation.afterLine, "afterLine");
    if (
      operation.startLine < 1 ||
      operation.endLine < operation.startLine ||
      operation.endLine > base.lines.length
    ) {
      fail("INVALID_ARGUMENT", "The transfer source range is outside the snapshot.");
    }
    if (operation.afterLine < 0 || operation.afterLine > base.lines.length) {
      fail("INVALID_ARGUMENT", "The transfer destination boundary is outside the snapshot.");
    }
  }

  for (const operation of operations) {
    if (
      operation.op === "move_range" &&
      operation.afterLine >= operation.startLine &&
      operation.afterLine < operation.endLine
    ) {
      fail("INVALID_ARGUMENT", "The move destination is strictly inside the source range.");
    }
  }

  const hasTransfer = operations.some(
    (operation) => operation.op === "copy_range" || operation.op === "move_range",
  );
  if (hasTransfer) {
    assertEffectsCompatible(
      operations.map((operation) =>
        baseEffect(operation as Exclude<EditOperation, ReplaceFileOperation>),
      ),
      false,
    );
  } else {
    assertLegacyBaseOperationsCompatible(
      operations as readonly (ReplaceOperation | InsertOperation)[],
    );
  }

  for (const operation of operations) {
    if (
      operation.op === "move_range" &&
      (operation.afterLine === operation.startLine - 1 || operation.afterLine === operation.endLine)
    ) {
      fail("NO_CHANGE", "The move source is already at the destination boundary.");
    }
  }
}

function planLegacyOperations(input: {
  base: TextDocument;
  current: TextDocument;
  operations: readonly (ReplaceOperation | InsertOperation)[];
  unchanged: boolean;
  maxContextLines: number;
}): EditPlan {
  const { base, current, operations, unchanged, maxContextLines } = input;
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

function rangeAnchor(span: LineSpan): RangeAnchor {
  return { kind: "range", span, key: `range:${span.start}:${span.end}` };
}

function boundaryAnchor(position: number): BoundaryAnchor {
  return { kind: "boundary", position, key: `boundary:${position}` };
}

function collectAnchors(operations: readonly EditOperation[]): Anchor[] {
  const anchors = new Map<string, Anchor>();
  const add = (anchor: Anchor) => anchors.set(anchor.key, anchor);
  for (const operation of operations) {
    if (operation.op === "replace") {
      add(rangeAnchor(rangeFor(operation.startLine, operation.endLine)));
    } else if (operation.op === "insert") {
      add(boundaryAnchor(operation.afterLine));
    } else if (operation.op === "copy_range") {
      add(rangeAnchor(rangeFor(operation.startLine, operation.endLine)));
      add(boundaryAnchor(operation.afterLine));
    } else if (operation.op === "move_range") {
      add(rangeAnchor(rangeFor(operation.startLine, operation.endLine)));
      add(rangeAnchor(moveCorridorSpan(operation)));
      add(boundaryAnchor(operation.afterLine));
    }
  }
  return [...anchors.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "range" ? -1 : 1;
    if (left.kind === "range" && right.kind === "range") {
      return left.span.start - right.span.start || left.span.end - right.span.end;
    }
    if (left.kind === "boundary" && right.kind === "boundary") {
      return left.position - right.position;
    }
    return 0;
  });
}

function mapAnchors(input: {
  anchors: readonly Anchor[];
  base: TextDocument;
  current: TextDocument;
  unchanged: boolean;
  maxContextLines: number;
}): Map<string, Anchor> {
  const { anchors, base, current, unchanged, maxContextLines } = input;
  const mapped = new Map<string, Anchor>();
  const mapper = unchanged ? undefined : createUniqueMapper(base.lines, current.lines);
  for (const anchor of anchors) {
    if (anchor.kind === "range") {
      if (unchanged) {
        mapped.set(anchor.key, anchor);
      } else {
        const result = mapper?.mapRange(anchor.span.start + 1, anchor.span.end, maxContextLines);
        if (!result) fail("TARGET_CHANGED", "The transfer range cannot be relocated.");
        mapped.set(anchor.key, rangeAnchor({ start: result.start, end: result.end + 1 }));
      }
    } else if (unchanged) {
      mapped.set(anchor.key, anchor);
    } else {
      const position = mapper?.mapBoundary(anchor.position, maxContextLines);
      if (position === undefined) fail("BOUNDARY_CHANGED", "The boundary cannot be relocated.");
      mapped.set(anchor.key, boundaryAnchor(position));
    }
  }
  return mapped;
}

function rangeRelation(left: LineSpan, right: LineSpan): string {
  if (left.start === right.start && left.end === right.end) return "equal";
  if (left.end <= right.start) return "before";
  if (right.end <= left.start) return "after";
  return `overlap:${right.start - left.start}:${right.end - left.end}`;
}

function boundaryRangeRelation(position: number, range: LineSpan): string {
  if (position < range.start) return "before";
  if (position === range.start) return "left-edge";
  if (position > range.end) return "after";
  if (position === range.end) return "right-edge";
  return `internal:${position - range.start}`;
}

function anchorRelation(left: Anchor, right: Anchor): string {
  if (left.kind === "range" && right.kind === "range") {
    return rangeRelation(left.span, right.span);
  }
  if (left.kind === "boundary" && right.kind === "boundary") {
    return left.position === right.position
      ? "equal"
      : left.position < right.position
        ? "before"
        : "after";
  }
  if (left.kind === "boundary" && right.kind === "range") {
    return `boundary-range:${boundaryRangeRelation(left.position, right.span)}`;
  }
  if (left.kind === "range" && right.kind === "boundary") {
    return `range-boundary:${boundaryRangeRelation(right.position, left.span)}`;
  }
  fail("AMBIGUOUS_RELOCATION", "Unsupported relocation anchor relationship.");
}

function assertAnchorTopology(
  anchors: readonly Anchor[],
  mapped: ReadonlyMap<string, Anchor>,
): void {
  for (let left = 0; left < anchors.length; left += 1) {
    for (let right = left + 1; right < anchors.length; right += 1) {
      const baseLeft = anchors[left];
      const baseRight = anchors[right];
      if (!baseLeft || !baseRight) continue;
      const currentLeft = mapped.get(baseLeft.key);
      const currentRight = mapped.get(baseRight.key);
      if (
        !currentLeft ||
        !currentRight ||
        currentLeft.kind !== baseLeft.kind ||
        currentRight.kind !== baseRight.kind ||
        anchorRelation(baseLeft, baseRight) !== anchorRelation(currentLeft, currentRight)
      ) {
        fail("AMBIGUOUS_RELOCATION", "Relocated transfer anchors changed their topology.");
      }
    }
  }
}

function getMappedRange(mapped: ReadonlyMap<string, Anchor>, span: LineSpan): LineSpan {
  const anchor = mapped.get(rangeAnchor(span).key);
  if (anchor?.kind !== "range") {
    fail("AMBIGUOUS_RELOCATION", "A transfer range was not mapped consistently.");
  }
  return anchor.span;
}

function getMappedBoundary(mapped: ReadonlyMap<string, Anchor>, position: number): number {
  const anchor = mapped.get(boundaryAnchor(position).key);
  if (anchor?.kind !== "boundary") {
    fail("AMBIGUOUS_RELOCATION", "A transfer boundary was not mapped consistently.");
  }
  return anchor.position;
}

function mapTransferOperations(
  operations: readonly EditOperation[],
  mapped: ReadonlyMap<string, Anchor>,
): MappedOperation[] {
  return operations.map((operation) => {
    if (operation.op === "replace") {
      return {
        op: "replace",
        operation,
        target: getMappedRange(mapped, rangeFor(operation.startLine, operation.endLine)),
      };
    }
    if (operation.op === "insert") {
      return {
        op: "insert",
        operation,
        destination: getMappedBoundary(mapped, operation.afterLine),
      };
    }
    if (operation.op === "copy_range") {
      return {
        op: "copy_range",
        operation,
        source: getMappedRange(mapped, rangeFor(operation.startLine, operation.endLine)),
        destination: getMappedBoundary(mapped, operation.afterLine),
      };
    }
    if (operation.op === "replace_file") {
      fail("OPERATIONS_OVERLAP", "replace_file must be the only operation.");
    }

    const source = getMappedRange(mapped, rangeFor(operation.startLine, operation.endLine));
    const corridor = getMappedRange(mapped, moveCorridorSpan(operation));
    const destination = getMappedBoundary(mapped, operation.afterLine);
    const upward = operation.afterLine < operation.startLine - 1;
    const coherent = upward
      ? corridor.start === destination && corridor.end === source.end
      : corridor.start === source.start && corridor.end === destination;
    if (!coherent) {
      fail("AMBIGUOUS_RELOCATION", "The relocated move anchors no longer form one exact corridor.");
    }
    return { op: "move_range", operation, source, corridor, destination };
  });
}

function utf8Length(text: string, start = 0, end = text.length): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function statsForText(text: string, start = 0, end = text.length): TextStats {
  let delimiters = 0;
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\r") {
      delimiters += 1;
      if (text[index + 1] === "\n" && index + 1 < end) index += 1;
    } else if (text[index] === "\n") {
      delimiters += 1;
    }
  }
  return {
    textLength: end - start,
    utf8Bytes: utf8Length(text, start, end),
    delimiters,
    endsWithEol: end > start && (text[end - 1] === "\n" || text[end - 1] === "\r"),
    startsWithLf: end > start && text[start] === "\n",
    endsWithCr: end > start && text[end - 1] === "\r",
  };
}

function combineStats(parts: readonly TextStats[]): TextStats {
  const combined = { ...EMPTY_STATS };
  for (const part of parts) {
    if (combined.textLength > 0 && combined.endsWithCr && part.startsWithLf) {
      combined.delimiters -= 1;
    }
    if (combined.textLength === 0 && part.textLength > 0) {
      combined.startsWithLf = part.startsWithLf;
    }
    combined.textLength += part.textLength;
    combined.utf8Bytes += part.utf8Bytes;
    combined.delimiters += part.delimiters;
    if (part.textLength > 0) {
      combined.endsWithEol = part.endsWithEol;
      combined.endsWithCr = part.endsWithCr;
    }
  }
  return combined;
}

type CopyCaches = {
  textLengths: readonly number[];
  utf8Bytes: readonly number[];
  stats: Map<string, TextStats>;
  rendered: Map<string, string>;
};

function createCopyCaches(document: TextDocument): CopyCaches {
  const textLengths = [0];
  const utf8Bytes = [0];
  for (const line of document.lines) {
    const text = line.text;
    textLengths.push((textLengths.at(-1) ?? 0) + text.length);
    utf8Bytes.push((utf8Bytes.at(-1) ?? 0) + utf8Length(text));
  }
  return { textLengths, utf8Bytes, stats: new Map(), rendered: new Map() };
}

function copyCacheKey(source: LineSpan, eol: string): string {
  return `${source.start}:${source.end}:${JSON.stringify(eol)}`;
}

function joinedSourceStats(
  document: TextDocument,
  source: LineSpan,
  eol: string,
  caches: CopyCaches,
): TextStats {
  const key = copyCacheKey(source, eol);
  const cached = caches.stats.get(key);
  if (cached) return cached;

  const firstLength = caches.textLengths[source.start];
  const lastLength = caches.textLengths[source.end];
  const firstBytes = caches.utf8Bytes[source.start];
  const lastBytes = caches.utf8Bytes[source.end];
  if (
    firstLength === undefined ||
    lastLength === undefined ||
    firstBytes === undefined ||
    lastBytes === undefined
  ) {
    fail("TARGET_CHANGED", "The copy source no longer exists.");
  }
  const lineCount = source.end - source.start;
  const delimiterCount = Math.max(0, lineCount - 1);
  const last = document.lines[source.end - 1];
  const endsWithEol = delimiterCount > 0 && last?.text === "";
  const stats = {
    textLength: lastLength - firstLength + delimiterCount * eol.length,
    utf8Bytes: lastBytes - firstBytes + delimiterCount * utf8Length(eol),
    delimiters: delimiterCount,
    endsWithEol,
    startsWithLf: delimiterCount > 0 && document.lines[source.start]?.text === "" && eol === "\n",
    endsWithCr: endsWithEol && eol.endsWith("\r"),
  };
  caches.stats.set(key, stats);
  return stats;
}

function eagerChange(change: MappedChange): PlannedChange {
  return {
    start: change.start,
    end: change.end,
    basePosition: change.basePosition,
    stats: statsForText(change.replacement),
    render: () => change.replacement,
  };
}

function copyChange(
  document: TextDocument,
  operation: MappedCopy,
  caches: CopyCaches,
): PlannedChange {
  const layout = insertionLayout(document, operation.destination);
  const sourceStats = joinedSourceStats(document, operation.source, layout.eol, caches);
  const stats = combineStats([
    statsForText(layout.prefix),
    sourceStats,
    statsForText(layout.suffix),
  ]);
  return {
    start: layout.start,
    end: layout.start,
    basePosition: operation.operation.afterLine * 2 + 1,
    stats,
    render: () => {
      const key = copyCacheKey(operation.source, layout.eol);
      let source = caches.rendered.get(key);
      if (source === undefined) {
        source = document.lines
          .slice(operation.source.start, operation.source.end)
          .map((line) => line.text)
          .join(layout.eol);
        caches.rendered.set(key, source);
      }
      return `${layout.prefix}${source}${layout.suffix}`;
    },
  };
}

function moveChange(document: TextDocument, operation: MappedMove): PlannedChange {
  const corridor = document.lines.slice(operation.corridor.start, operation.corridor.end);
  const source = document.lines
    .slice(operation.source.start, operation.source.end)
    .map((line) => line.text);
  const upward = operation.operation.afterLine < operation.operation.startLine - 1;
  const intervening = upward
    ? document.lines
        .slice(operation.corridor.start, operation.source.start)
        .map((line) => line.text)
    : document.lines.slice(operation.source.end, operation.corridor.end).map((line) => line.text);
  const output = upward ? [...source, ...intervening] : [...intervening, ...source];
  const first = corridor[0];
  const last = corridor.at(-1);
  if (!first || !last || output.length !== corridor.length) {
    fail("AMBIGUOUS_RELOCATION", "The relocated move corridor is inconsistent.");
  }
  const original = document.text.slice(first.start, last.end);
  const stats = statsForText(document.text, first.start, last.end);
  stats.startsWithLf = output[0] === "" && first.eol === "\n";
  stats.endsWithEol = last.eol !== "";
  stats.endsWithCr = last.eol === "\r";
  let replacement: string | undefined;
  const render = (): string => {
    replacement ??= output.map((text, index) => `${text}${corridor[index]?.eol ?? ""}`).join("");
    return replacement;
  };
  const basePosition = moveCorridorSpan(operation.operation).start * 2;
  return {
    start: first.start,
    end: last.end,
    basePosition,
    stats,
    render,
    move: {
      basePosition,
      isLayoutValid: () => {
        const reparsed = parseTextLines(render());
        return !(
          reparsed.length !== corridor.length ||
          reparsed.some(
            (line, index) => line.text !== output[index] || line.eol !== corridor[index]?.eol,
          )
        );
      },
      isNoChange: () => render() === original,
    },
  };
}

type ProjectedShape = {
  bytes: number;
  lines: number;
  boundaryLayoutMoves: ReadonlySet<number>;
};

function projectChanges(
  document: TextDocument,
  changes: readonly PlannedChange[],
  maxFileBytes: number,
  maxLines: number,
): ProjectedShape {
  const ascending = [...changes].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = 0;
  let total = { ...EMPTY_STATS };
  let previousMove: MoveValidation | undefined;
  const boundaryLayoutMoves = new Set<number>();
  const append = (stats: TextStats, move?: MoveValidation): void => {
    if (total.textLength > 0 && total.endsWithCr && stats.startsWithLf) {
      if (previousMove) boundaryLayoutMoves.add(previousMove.basePosition);
      if (move) boundaryLayoutMoves.add(move.basePosition);
    }
    total = combineStats([total, stats]);
    if (stats.textLength > 0) previousMove = move;
  };
  for (const change of ascending) {
    append(statsForText(document.text, cursor, change.start));
    append(change.stats, change.move);
    cursor = change.end;
  }
  append(statsForText(document.text, cursor));

  const projectedBytes = total.utf8Bytes + (document.bom ? 3 : 0);
  if (projectedBytes > maxFileBytes) {
    fail("UNSUPPORTED_FILE", "The edited file exceeds maxFileBytes.");
  }
  const projectedLines = total.delimiters + (total.textLength > 0 && !total.endsWithEol ? 1 : 0);
  if (projectedLines > maxLines) {
    fail("UNSUPPORTED_FILE", `The file exceeds the ${maxLines}-line safety limit.`);
  }
  return { bytes: projectedBytes, lines: projectedLines, boundaryLayoutMoves };
}

function renderPlannedChanges(document: TextDocument, changes: readonly PlannedChange[]): string {
  const ascending = [...changes].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  for (const change of ascending) {
    parts.push(document.text.slice(cursor, change.start), change.render());
    cursor = change.end;
  }
  parts.push(document.text.slice(cursor));
  return parts.join("");
}

function createTransferChanges(
  document: TextDocument,
  operations: readonly MappedOperation[],
): PlannedChange[] {
  let copyCaches: CopyCaches | undefined;
  return operations.map((operation) => {
    if (operation.op === "replace") {
      const change = replaceText(
        document,
        operation.target.start,
        operation.target.end,
        operation.operation.lines,
      );
      change.basePosition = (operation.operation.startLine - 1) * 2;
      return eagerChange(change);
    }
    if (operation.op === "insert") {
      const change = insertText(document, operation.destination, operation.operation.lines);
      change.basePosition = operation.operation.afterLine * 2 + 1;
      return eagerChange(change);
    }
    if (operation.op === "copy_range") {
      copyCaches ??= createCopyCaches(document);
      return copyChange(document, operation, copyCaches);
    }
    return moveChange(document, operation);
  });
}

function sortedMoveChanges(
  changes: readonly PlannedChange[],
): (PlannedChange & { move: MoveValidation })[] {
  return changes
    .filter(
      (change): change is PlannedChange & { move: MoveValidation } => change.move !== undefined,
    )
    .sort((left, right) => left.basePosition - right.basePosition);
}

function invalidMoveLayouts(
  moves: readonly (PlannedChange & { move: MoveValidation })[],
  projected: ProjectedShape,
): Set<number> {
  const invalid = new Set(projected.boundaryLayoutMoves);
  for (const change of moves) {
    if (!change.move.isLayoutValid()) invalid.add(change.basePosition);
  }
  return invalid;
}

function planTransferOperations(input: {
  base: TextDocument;
  current: TextDocument;
  operations: readonly EditOperation[];
  unchanged: boolean;
  maxContextLines: number;
  maxFileBytes: number;
  maxLines: number;
}): EditPlan {
  const { base, current, operations, unchanged, maxContextLines, maxFileBytes, maxLines } = input;
  const anchors = collectAnchors(operations);
  const mappedAnchors = mapAnchors({ anchors, base, current, unchanged, maxContextLines });
  assertAnchorTopology(anchors, mappedAnchors);
  const mappedOperations = mapTransferOperations(operations, mappedAnchors);
  assertEffectsCompatible(mappedOperations.map(mappedEffect), true);
  const changes = createTransferChanges(current, mappedOperations);

  assertCompatibleChanges(changes);
  const projected = projectChanges(current, changes, maxFileBytes, maxLines);
  const moves = sortedMoveChanges(changes);
  const currentInvalidMoves = invalidMoveLayouts(moves, projected);
  let baseInvalidMoves = currentInvalidMoves;
  if (!unchanged) {
    const baseMappedAnchors = mapAnchors({
      anchors,
      base,
      current: base,
      unchanged: true,
      maxContextLines,
    });
    const baseChanges = createTransferChanges(
      base,
      mapTransferOperations(operations, baseMappedAnchors),
    );
    assertCompatibleChanges(baseChanges);
    const baseProjected = projectChanges(
      base,
      baseChanges,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    baseInvalidMoves = invalidMoveLayouts(sortedMoveChanges(baseChanges), baseProjected);
  }
  for (const change of moves) {
    if (baseInvalidMoves.has(change.basePosition)) {
      fail(
        "INVALID_ARGUMENT",
        "The move cannot preserve its logical lines and positional EOL slots.",
      );
    }
  }
  for (const change of moves) {
    if (currentInvalidMoves.has(change.basePosition)) {
      fail(
        "AMBIGUOUS_RELOCATION",
        "The relocated move cannot preserve its logical lines and positional EOL slots.",
      );
    }
  }
  if (moves.some((change) => change.move.isNoChange())) {
    fail("NO_CHANGE", "A move changes no bytes.");
  }
  const text = renderPlannedChanges(current, changes);
  const bytes = encodeTextDocument(text, current.bom);
  const reparsed = decodeTextDocument(bytes);
  if (bytes.byteLength !== projected.bytes || reparsed.lines.length !== projected.lines) {
    fail("UNSUPPORTED_FILE", "The edited file shape could not be projected safely.");
  }
  if (bytesEqual(bytes, current.bytes)) fail("NO_CHANGE", "The edit changes no bytes.");
  return {
    text,
    bytes,
    operationCount: operations.length,
    rebased: !unchanged,
  };
}

export function planEdits(input: {
  base: TextDocument;
  current: TextDocument;
  operations: readonly EditOperation[];
  rebase: RebaseMode;
  maxContextLines: number;
  maxFileBytes?: number;
  maxLines?: number;
}): EditPlan {
  const {
    base,
    current,
    operations,
    rebase,
    maxContextLines,
    maxFileBytes = Number.POSITIVE_INFINITY,
    maxLines = Number.POSITIVE_INFINITY,
  } = input;
  validateEditOperations(base, operations);
  const wholeFile = operations.find((operation) => operation.op === "replace_file");
  if (wholeFile && rebase !== "none") {
    fail("INVALID_ARGUMENT", "replace_file does not support unique rebase.");
  }
  const unchanged = bytesEqual(base.bytes, current.bytes);
  if (!unchanged && rebase === "none") {
    fail("TARGET_CHANGED", "The file changed since hashline_read. Reread before editing.");
  }
  if (!unchanged && base.bom !== current.bom) {
    fail("TARGET_CHANGED", "The file byte-order mark changed since hashline_read.");
  }

  if (wholeFile) {
    if (!unchanged) {
      fail("TARGET_CHANGED", "replace_file requires an exact, current snapshot.");
    }
    const result = renderWholeFile(base, wholeFile);
    if (bytesEqual(result.bytes, current.bytes)) fail("NO_CHANGE", "The edit changes no bytes.");
    return { ...result, operationCount: 1, rebased: false };
  }

  const hasTransfer = operations.some(
    (operation) => operation.op === "copy_range" || operation.op === "move_range",
  );
  if (!hasTransfer) {
    return planLegacyOperations({
      base,
      current,
      operations: operations as readonly (ReplaceOperation | InsertOperation)[],
      unchanged,
      maxContextLines,
    });
  }

  return planTransferOperations({
    base,
    current,
    operations,
    unchanged,
    maxContextLines,
    maxFileBytes,
    maxLines,
  });
}
