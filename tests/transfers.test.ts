import { describe, expect, test } from "bun:test";
import { type EditOperation, planEdits } from "../src/edits.js";
import { HashlineError } from "../src/errors.js";
import { decodeTextDocument, type TextDocument } from "../src/text.js";

const encoder = new TextEncoder();
const CONFLICT_RECOVERY =
  "No mutation occurred and the snapshot remains retained. Correct the conflicting operation coordinates, then retry with that snapshot.";

function document(text: string, bom = false): TextDocument {
  const body = encoder.encode(text);
  return decodeTextDocument(bom ? Uint8Array.of(0xef, 0xbb, 0xbf, ...body) : body);
}

function plan(
  baseText: string,
  currentText: string,
  operations: EditOperation[],
  rebase: "none" | "unique" = "none",
  limits: { maxFileBytes?: number; maxLines?: number; maxContextLines?: number } = {},
) {
  return planEdits({
    base: document(baseText),
    current: document(currentText),
    operations,
    rebase,
    maxContextLines: limits.maxContextLines ?? 2,
    ...(limits.maxFileBytes === undefined ? {} : { maxFileBytes: limits.maxFileBytes }),
    ...(limits.maxLines === undefined ? {} : { maxLines: limits.maxLines }),
  });
}

function renderLines(texts: readonly string[], eols: readonly string[]): string {
  return texts.map((text, index) => `${text}${eols[index] ?? ""}`).join("");
}

function movedTexts(
  texts: readonly string[],
  startLine: number,
  endLine: number,
  afterLine: number,
): string[] {
  const sourceStart = startLine - 1;
  const sourceEnd = endLine;
  const source = texts.slice(sourceStart, sourceEnd);
  return afterLine < sourceStart
    ? [
        ...texts.slice(0, afterLine),
        ...source,
        ...texts.slice(afterLine, sourceStart),
        ...texts.slice(sourceEnd),
      ]
    : [
        ...texts.slice(0, sourceStart),
        ...texts.slice(sourceEnd, afterLine),
        ...source,
        ...texts.slice(afterLine),
      ];
}

function moveOracle(text: string, startLine: number, endLine: number, afterLine: number): string {
  const parsed = document(text);
  const texts = parsed.lines.map((line) => line.text);
  const eols = parsed.lines.map((line) => line.eol);
  const moved = movedTexts(texts, startLine, endLine, afterLine);
  return renderLines(moved, eols);
}

type MoveOperation = Extract<EditOperation, { op: "move_range" }>;
type ReplaceOperation = Extract<EditOperation, { op: "replace" }>;

function replacementOracle(text: string, replacementOperations: readonly ReplaceOperation[]) {
  const parsed = document(text);
  const replacements = replacementOperations
    .map((operation) => {
      const start = operation.startLine - 1;
      const end = operation.endLine;
      const first = parsed.lines[start];
      const last = parsed.lines[end - 1];
      if (!first || !last) throw new Error("Expected a valid replacement range.");
      const eol = last.eol || first.eol || parsed.preferredEol;
      return {
        start,
        end,
        lines: operation.lines.map((line, index) => ({
          text: line,
          eol: index === operation.lines.length - 1 ? last.eol : eol,
        })),
      };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const mapBoundary = (position: number): number =>
    position +
    replacements.reduce(
      (delta, replacement) =>
        position >= replacement.end
          ? delta + replacement.lines.length - (replacement.end - replacement.start)
          : delta,
      0,
    );
  const lines: Array<{ text: string; eol: string }> = [];
  let cursor = 0;
  for (const replacement of replacements) {
    lines.push(...parsed.lines.slice(cursor, replacement.start), ...replacement.lines);
    cursor = replacement.end;
  }
  lines.push(...parsed.lines.slice(cursor));
  return { lines, mapBoundary };
}

function composedMoveOracle(
  text: string,
  move: MoveOperation,
  replacementOperations: readonly ReplaceOperation[],
): string {
  const { lines, mapBoundary } = replacementOracle(text, replacementOperations);
  const texts = lines.map((line) => line.text);
  const eols = lines.map((line) => line.eol);
  const sourceStart = mapBoundary(move.startLine - 1);
  const sourceEnd = mapBoundary(move.endLine);
  const destination = mapBoundary(move.afterLine);
  if (destination >= sourceStart && destination <= sourceEnd) return renderLines(texts, eols);
  const moved = movedTexts(texts, sourceStart + 1, sourceEnd, destination);
  return renderLines(moved, eols);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  }
  return result;
}

function failureMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof HashlineError) return error.message;
    throw error;
  }
  throw new Error("Expected a HashlineError.");
}

function rawStrings(alphabet: readonly string[], maxLength: number): string[] {
  const result: string[] = [];
  let level = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    level = level.flatMap((prefix) => alphabet.map((value) => `${prefix}${value}`));
    result.push(...level);
  }
  return result;
}

describe("range transfers", () => {
  test("copies logical source lines using the destination insertion layout", () => {
    const text = "source-1\r\nsource-2\ntarget\nend\n";
    const operation: EditOperation = {
      op: "copy_range",
      startLine: 1,
      endLine: 2,
      afterLine: 3,
    };
    expect(plan(text, text, [operation]).text).toBe(
      "source-1\r\nsource-2\ntarget\nsource-1\nsource-2\nend\n",
    );

    const sourceLines = document(text)
      .lines.slice(0, 2)
      .map((line) => line.text);
    expect(plan(text, text, [operation]).text).toBe(
      plan(text, text, [{ op: "insert", afterLine: 3, lines: sourceLines }]).text,
    );
  });

  test("allows copy destinations before, inside, and after their source", () => {
    const text = "a\nb\nc\nd\n";
    for (const afterLine of [0, 1, 2, 3, 4]) {
      const copy = plan(text, text, [
        { op: "copy_range", startLine: 2, endLine: 3, afterLine },
      ]).text;
      const insert = plan(text, text, [{ op: "insert", afterLine, lines: ["b", "c"] }]).text;
      expect(copy).toBe(insert);
    }
  });

  test("does not invent a phantom line when copying a blank source to unterminated EOF", () => {
    const result = plan("\nlast", "\nlast", [
      { op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 },
    ]);
    expect(result.text).toBe("\nlast\n");
    expect(document(result.text).lines).toHaveLength(2);
  });

  test("moves upward and downward by permuting texts over fixed EOL slots", () => {
    const text = "A\r\nB\nC\rD";
    const upward = plan(text, text, [{ op: "move_range", startLine: 4, endLine: 4, afterLine: 1 }]);
    expect(upward.text).toBe("A\r\nD\nB\rC");
    expect(upward.bytes.byteLength).toBe(document(text).bytes.byteLength);

    const downward = plan(text, text, [
      { op: "move_range", startLine: 1, endLine: 2, afterLine: 4 },
    ]);
    expect(downward.text).toBe("C\r\nD\nA\rB");
    expect(downward.bytes.byteLength).toBe(document(text).bytes.byteLength);
  });

  test("exhaustively composes contained replacements across move geometry, cardinality, and order", () => {
    const texts = ["L1", "L2", "L3", "L4", "L5"];
    const eolLayouts = [
      ["\r\n", "\n", "\r", "\r\n", ""],
      ["\n", "\r", "\r\n", "\n", "\r\n"],
    ];
    for (const eols of eolLayouts) {
      const text = renderLines(texts, eols);
      for (let startLine = 1; startLine <= texts.length; startLine += 1) {
        for (let endLine = startLine; endLine <= texts.length; endLine += 1) {
          for (let afterLine = 0; afterLine <= texts.length; afterLine += 1) {
            if (afterLine >= startLine - 1 && afterLine <= endLine) continue;
            const move: MoveOperation = {
              op: "move_range",
              startLine,
              endLine,
              afterLine,
            };
            const interveningStart = afterLine < startLine - 1 ? afterLine + 1 : endLine + 1;
            const interveningEnd = afterLine < startLine - 1 ? startLine - 1 : afterLine;
            for (
              let replacementStart = interveningStart;
              replacementStart <= interveningEnd;
              replacementStart += 1
            ) {
              for (
                let replacementEnd = replacementStart;
                replacementEnd <= interveningEnd;
                replacementEnd += 1
              ) {
                const targetLength = replacementEnd - replacementStart + 1;
                const cardinalities = [0, targetLength, targetLength + 1];
                for (const cardinality of cardinalities) {
                  const replacement: ReplaceOperation = {
                    op: "replace",
                    startLine: replacementStart,
                    endLine: replacementEnd,
                    lines: Array.from(
                      { length: cardinality },
                      (_, index) => `R${replacementStart}-${replacementEnd}-${index}`,
                    ),
                  };
                  const expected = composedMoveOracle(text, move, [replacement]);
                  const replacementOnly = replacementOracle(text, [replacement]).lines;
                  const replacementOnlyText = renderLines(
                    replacementOnly.map((line) => line.text),
                    replacementOnly.map((line) => line.eol),
                  );
                  for (const operations of permutations<EditOperation>([move, replacement])) {
                    if (expected === replacementOnlyText) {
                      expect(failureMessage(() => plan(text, text, operations))).toBe(
                        "NO_CHANGE: A move changes no bytes.",
                      );
                    } else {
                      expect(plan(text, text, operations).text).toBe(expected);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  test("composes multiple disjoint replacements from immutable line identities", () => {
    const text = renderLines(
      ["A", "B", "C", "D", "E", "F"],
      ["\r\n", "\n", "\r", "\r\n", "\n", ""],
    );
    const replacements: ReplaceOperation[] = [
      { op: "replace", startLine: 2, endLine: 2, lines: [] },
      { op: "replace", startLine: 3, endLine: 3, lines: ["equal"] },
      {
        op: "replace",
        startLine: 4,
        endLine: 5,
        lines: ["expand-1", "expand-2", "expand-3"],
      },
    ];
    const moves: MoveOperation[] = [
      { op: "move_range", startLine: 6, endLine: 6, afterLine: 1 },
      { op: "move_range", startLine: 1, endLine: 1, afterLine: 6 },
    ];
    for (const move of moves) {
      const expected = composedMoveOracle(text, move, replacements);
      for (const operations of permutations<EditOperation>([move, ...replacements])) {
        expect(plan(text, text, operations).text).toBe(expected);
      }
    }
  });

  test("keeps copy reads immutable while composing a move and replacement", () => {
    const text = "A\nB\nC\nD\nE\n";
    const operations: EditOperation[] = [
      { op: "move_range", startLine: 5, endLine: 5, afterLine: 1 },
      { op: "replace", startLine: 3, endLine: 3, lines: ["X"] },
      { op: "copy_range", startLine: 3, endLine: 3, afterLine: 0 },
    ];
    for (const ordered of permutations(operations)) {
      expect(plan(text, text, ordered).text).toBe("C\nA\nE\nB\nX\nD\n");
    }
  });

  test("preserves BOM, line count, delimiter layout, and final-newline state for moves", () => {
    const base = document("short\r\n\u00e9\nlonger\remoji-\ud83d\ude00\n", true);
    const result = planEdits({
      base,
      current: base,
      operations: [{ op: "move_range", startLine: 4, endLine: 4, afterLine: 1 }],
      rebase: "none",
      maxContextLines: 2,
    });
    const parsed = decodeTextDocument(result.bytes);
    expect(parsed.bom).toBe(true);
    expect(parsed.lines).toHaveLength(base.lines.length);
    expect(parsed.lines.map((line) => line.eol)).toEqual(base.lines.map((line) => line.eol));
    expect(parsed.finalNewline).toBe(base.finalNewline);
    expect(result.bytes.byteLength).toBe(base.bytes.byteLength);
  });

  test("rejects moves whose blank-line layout cannot preserve positional EOL slots", () => {
    expect(() =>
      plan("\ra\n\n", "\ra\n\n", [{ op: "move_range", startLine: 3, endLine: 3, afterLine: 1 }]),
    ).toThrow("INVALID_ARGUMENT:");
    expect(() =>
      plan("\na", "\na", [{ op: "move_range", startLine: 1, endLine: 1, afterLine: 2 }]),
    ).toThrow("INVALID_ARGUMENT:");
    expect(() =>
      plan(
        "\ra\n\n",
        "prefix\n\ra\n\n",
        [{ op: "move_range", startLine: 3, endLine: 3, afterLine: 1 }],
        "unique",
      ),
    ).toThrow("INVALID_ARGUMENT:");
    expect(() =>
      plan(
        "\ra\n\nz\n",
        "\ra\n\nZ\n",
        [{ op: "move_range", startLine: 3, endLine: 3, afterLine: 1 }],
        "unique",
      ),
    ).toThrow("INVALID_ARGUMENT:");
  });

  test("validates move layout without applying whole-file control density to its corridor", () => {
    const text = "a\n\u0001\n\n";
    expect(
      plan(text, text, [{ op: "move_range", startLine: 3, endLine: 3, afterLine: 1 }]).text,
    ).toBe("a\n\n\u0001\n");

    expect(() =>
      plan(text, text, [
        { op: "move_range", startLine: 3, endLine: 3, afterLine: 1 },
        { op: "insert", afterLine: 0, lines: ["\u0001\u0001\u0001\u0001"] },
      ]),
    ).toThrow("UNSUPPORTED_FILE:");
  });

  test("prioritizes intrinsic move layout failures over relocation-induced failures", () => {
    const base = "p\nA\n\r\n\rB\n\n";
    const current = "p\rA\n\r\n\rB\n\n";
    const relocated = { op: "move_range" as const, startLine: 2, endLine: 2, afterLine: 3 };
    const intrinsic = { op: "move_range" as const, startLine: 6, endLine: 6, afterLine: 4 };

    expect(() => plan(base, current, [relocated], "unique")).toThrow("AMBIGUOUS_RELOCATION:");
    expect(() => plan(base, current, [intrinsic], "unique")).toThrow("INVALID_ARGUMENT:");
    for (const operations of [
      [relocated, intrinsic],
      [intrinsic, relocated],
    ]) {
      expect(() => plan(base, current, operations, "unique")).toThrow("INVALID_ARGUMENT:");
    }
  });

  test("is closed over every representable small CR, LF, blank-line, EOF, and BOM move", () => {
    for (const text of rawStrings(["a", "\n", "\r"], 4)) {
      const parsed = document(text);
      const texts = parsed.lines.map((line) => line.text);
      const eols = parsed.lines.map((line) => line.eol);
      for (let startLine = 1; startLine <= parsed.lines.length; startLine += 1) {
        for (let endLine = startLine; endLine <= parsed.lines.length; endLine += 1) {
          for (let afterLine = 0; afterLine <= parsed.lines.length; afterLine += 1) {
            if (afterLine >= startLine - 1 && afterLine <= endLine) continue;
            const expectedTexts = movedTexts(texts, startLine, endLine, afterLine);
            const expected = renderLines(expectedTexts, eols);
            const expectedParsed = document(expected);
            const representable =
              expectedParsed.lines.length === expectedTexts.length &&
              expectedParsed.lines.every(
                (line, index) => line.text === expectedTexts[index] && line.eol === eols[index],
              );
            const operation: EditOperation = {
              op: "move_range",
              startLine,
              endLine,
              afterLine,
            };

            for (const bom of [false, true]) {
              const base = document(text, bom);
              const execute = () =>
                planEdits({
                  base,
                  current: base,
                  operations: [operation],
                  rebase: "none",
                  maxContextLines: 2,
                });
              if (!representable) {
                expect(execute).toThrow("INVALID_ARGUMENT:");
              } else if (expected === text) {
                expect(execute).toThrow("NO_CHANGE:");
              } else {
                const result = execute();
                const resultDocument = decodeTextDocument(result.bytes);
                expect(result.text).toBe(expected);
                expect(resultDocument.bom).toBe(bom);
                expect(resultDocument.lines.map((line) => line.eol)).toEqual(eols);
                expect(resultDocument.finalNewline).toBe(parsed.finalNewline);
                expect(result.bytes.byteLength).toBe(base.bytes.byteLength);
              }
            }
          }
        }
      }
    }
  });

  test("rejects internal and byte-identical moves with stable errors", () => {
    const text = "a\nb\nc\nd\n";
    expect(() =>
      plan(text, text, [{ op: "move_range", startLine: 2, endLine: 3, afterLine: 2 }]),
    ).toThrow("INVALID_ARGUMENT:");
    for (const afterLine of [1, 3]) {
      expect(() =>
        plan(text, text, [{ op: "move_range", startLine: 2, endLine: 3, afterLine }]),
      ).toThrow("NO_CHANGE:");
    }
    expect(() =>
      plan("same\nsame\nx\ny\n", "same\nsame\nx\ny\n", [
        { op: "move_range", startLine: 1, endLine: 1, afterLine: 2 },
        { op: "copy_range", startLine: 4, endLine: 4, afterLine: 3 },
      ]),
    ).toThrow("NO_CHANGE:");
  });

  test("rejects invalid transfer coordinates before planning effects", () => {
    const text = "a\nb\nc\n";
    for (const operation of [
      { op: "copy_range", startLine: 0, endLine: 1, afterLine: 2 },
      { op: "copy_range", startLine: 2, endLine: 1, afterLine: 2 },
      { op: "copy_range", startLine: 1, endLine: 4, afterLine: 2 },
      { op: "move_range", startLine: 1, endLine: 1, afterLine: 4 },
      { op: "move_range", startLine: 1.5, endLine: 2, afterLine: 3 },
    ] satisfies EditOperation[]) {
      expect(() => plan(text, text, [operation])).toThrow("INVALID_ARGUMENT:");
    }
  });

  test("uses deterministic failure precedence for conflicting and independently failing moves", () => {
    const conflicts: Array<{ operations: EditOperation[]; expected: string }> = [
      {
        operations: [
          { op: "move_range", startLine: 2, endLine: 2, afterLine: 1 },
          { op: "replace", startLine: 2, endLine: 2, lines: ["B"] },
        ],
        expected: `OPERATIONS_OVERLAP: Destructive write ranges overlap. Merge them into one replacement, or split the edits. Conflict: operations[0] (move_range) and operations[1] (replace). ${CONFLICT_RECOVERY}`,
      },
      {
        operations: [
          { op: "replace", startLine: 2, endLine: 2, lines: ["B"] },
          { op: "move_range", startLine: 2, endLine: 2, afterLine: 1 },
        ],
        expected: `OPERATIONS_OVERLAP: Destructive write ranges overlap. Merge them into one replacement, or split the edits. Conflict: operations[0] (replace) and operations[1] (move_range). ${CONFLICT_RECOVERY}`,
      },
    ];
    for (const { operations, expected } of conflicts) {
      expect(failureMessage(() => plan("a\nb", "a\nb", operations))).toBe(expected);
    }

    const independentFailures: EditOperation[] = [
      { op: "move_range", startLine: 1, endLine: 1, afterLine: 2 },
      { op: "move_range", startLine: 3, endLine: 3, afterLine: 4 },
    ];
    for (const ordered of permutations(independentFailures)) {
      expect(() => plan("x\nx\n\rb\n", "x\nx\n\rb\n", ordered)).toThrow("INVALID_ARGUMENT:");
    }

    const noChangeAndAmplification: EditOperation[] = [
      { op: "move_range", startLine: 1, endLine: 1, afterLine: 2 },
      { op: "copy_range", startLine: 3, endLine: 3, afterLine: 3 },
    ];
    for (const ordered of permutations(noChangeAndAmplification)) {
      expect(() => plan("x\nx\nz", "x\nx\nz", ordered, "none", { maxFileBytes: 5 })).toThrow(
        "UNSUPPORTED_FILE:",
      );
    }
  });

  test("keeps source, destination, replacement, and move-move conflicts conservative", () => {
    const text = "a\nb\nc\nd\ne\nf\n";
    const scenarios: EditOperation[][] = [
      [
        { op: "move_range", startLine: 4, endLine: 4, afterLine: 1 },
        { op: "replace", startLine: 4, endLine: 4, lines: ["source"] },
      ],
      [
        { op: "move_range", startLine: 4, endLine: 4, afterLine: 1 },
        { op: "replace", startLine: 1, endLine: 2, lines: ["destination"] },
      ],
      [
        { op: "move_range", startLine: 4, endLine: 4, afterLine: 1 },
        { op: "move_range", startLine: 3, endLine: 3, afterLine: 0 },
      ],
    ];
    for (const scenario of scenarios) {
      for (const operations of permutations(scenario)) {
        const left = operations[0];
        const right = operations[1];
        if (!left || !right) throw new Error("Expected two conflicting operations.");
        expect(failureMessage(() => plan(text, text, operations))).toBe(
          `OPERATIONS_OVERLAP: Destructive write ranges overlap. Merge them into one replacement, or split the edits. Conflict: operations[0] (${left.op}) and operations[1] (${right.op}). ${CONFLICT_RECOVERY}`,
        );
      }
    }

    const overlapping: EditOperation[] = [
      { op: "move_range", startLine: 6, endLine: 6, afterLine: 1 },
      { op: "replace", startLine: 2, endLine: 4, lines: ["left"] },
      { op: "replace", startLine: 3, endLine: 5, lines: ["right"] },
    ];
    for (const operations of permutations(overlapping)) {
      const replacementIndexes = operations.flatMap((operation, index) =>
        operation.op === "replace" ? [index] : [],
      );
      const leftIndex = replacementIndexes[0];
      const rightIndex = replacementIndexes[1];
      if (leftIndex === undefined || rightIndex === undefined) {
        throw new Error("Expected two conflicting replacements.");
      }
      expect(failureMessage(() => plan(text, text, operations))).toBe(
        `OPERATIONS_OVERLAP: Destructive write ranges overlap. Merge them into one replacement, or split the edits. Conflict: operations[${leftIndex}] (replace) and operations[${rightIndex}] (replace). ${CONFLICT_RECOVERY}`,
      );
    }
  });

  test("selects the conflict class and pair deterministically for every operation permutation", () => {
    const text = "a\nb\nc\nd\ne\nf\n";
    const operations: EditOperation[] = [
      { op: "insert", afterLine: 5, lines: ["X"] },
      { op: "copy_range", startLine: 6, endLine: 6, afterLine: 5 },
      { op: "move_range", startLine: 3, endLine: 3, afterLine: 0 },
      { op: "replace", startLine: 2, endLine: 2, lines: ["B"] },
      { op: "replace", startLine: 3, endLine: 3, lines: ["C"] },
    ];
    for (const ordered of permutations(operations)) {
      const moveIndex = ordered.findIndex((operation) => operation.op === "move_range");
      const conflict = ordered
        .flatMap((operation, index) =>
          operation.op === "replace" && operation.startLine === 3
            ? [[Math.min(moveIndex, index), Math.max(moveIndex, index)] as const]
            : [],
        )
        .sort((left, right) => left[0] - right[0] || left[1] - right[1])[0];
      const left = conflict ? ordered[conflict[0]] : undefined;
      const right = conflict ? ordered[conflict[1]] : undefined;
      if (!conflict || !left || !right) throw new Error("Expected a move/replace conflict.");
      expect(failureMessage(() => plan(text, text, ordered))).toBe(
        `OPERATIONS_OVERLAP: Destructive write ranges overlap. Merge them into one replacement, or split the edits. Conflict: operations[${conflict[0]}] (${left.op}) and operations[${conflict[1]}] (${right.op}). ${CONFLICT_RECOVERY}`,
      );
    }
  });

  test("accepts independent mixed batches and is permutation invariant", () => {
    const text = "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n";
    const operations: EditOperation[] = [
      { op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 },
      { op: "move_range", startLine: 5, endLine: 5, afterLine: 3 },
      { op: "replace", startLine: 7, endLine: 7, lines: ["SEVEN"] },
      { op: "insert", afterLine: 9, lines: ["NINE-AND-A-HALF"] },
    ];
    const expected = plan(text, text, operations).text;
    for (const ordered of permutations(operations)) {
      expect(plan(text, text, ordered).text).toBe(expected);
    }
  });

  test("supports multiple independent copies and moves in one permutation-invariant batch", () => {
    const text = Array.from({ length: 20 }, (_, index) => `L${index + 1}\n`).join("");
    const operations: EditOperation[] = [
      { op: "move_range", startLine: 3, endLine: 3, afterLine: 1 },
      { op: "move_range", startLine: 8, endLine: 8, afterLine: 6 },
      { op: "copy_range", startLine: 11, endLine: 11, afterLine: 13 },
      { op: "copy_range", startLine: 12, endLine: 12, afterLine: 15 },
    ];
    const expected = [
      "L1",
      "L3",
      "L2",
      "L4",
      "L5",
      "L6",
      "L8",
      "L7",
      "L9",
      "L10",
      "L11",
      "L12",
      "L13",
      "L11",
      "L14",
      "L15",
      "L12",
      "L16",
      "L17",
      "L18",
      "L19",
      "L20",
      "",
    ].join("\n");
    for (const ordered of permutations(operations)) {
      expect(plan(text, text, ordered).text).toBe(expected);
      expect(plan(text, `PREFIX\n${text}`, ordered, "unique").text).toBe(`PREFIX\n${expected}`);
    }
  });

  test("allows immutable transfer reads and boundary insertions while rejecting write conflicts", () => {
    const text = "a\nb\nc\nd\ne\nf\ng\n";
    expect(
      plan(text, text, [
        { op: "move_range", startLine: 5, endLine: 5, afterLine: 3 },
        { op: "replace", startLine: 6, endLine: 6, lines: ["F"] },
      ]).text,
    ).toBe("a\nb\nc\ne\nd\nF\ng\n");

    const adjacentMoves: EditOperation[] = [
      { op: "move_range", startLine: 2, endLine: 2, afterLine: 0 },
      { op: "move_range", startLine: 4, endLine: 4, afterLine: 2 },
    ];
    for (const operations of permutations(adjacentMoves)) {
      expect(plan("A\nB\nC\nD\nE\nF\n", "A\nB\nC\nD\nE\nF\n", operations).text).toBe(
        "B\nA\nD\nC\nE\nF\n",
      );
    }

    const formerlyDependent: Array<{ operations: EditOperation[]; expected: string }> = [
      {
        operations: [
          { op: "copy_range", startLine: 2, endLine: 4, afterLine: 7 },
          { op: "replace", startLine: 3, endLine: 3, lines: ["X"] },
        ],
        expected: "a\nb\nX\nd\ne\nf\ng\nb\nc\nd\n",
      },
      {
        operations: [
          { op: "copy_range", startLine: 4, endLine: 4, afterLine: 7 },
          { op: "move_range", startLine: 5, endLine: 5, afterLine: 2 },
        ],
        expected: "a\nb\ne\nc\nd\nf\ng\nd\n",
      },
      {
        operations: [
          { op: "move_range", startLine: 5, endLine: 5, afterLine: 3 },
          { op: "insert", afterLine: 3, lines: ["X"] },
        ],
        expected: "a\nb\nc\nX\ne\nd\nf\ng\n",
      },
    ];
    for (const { operations, expected } of formerlyDependent) {
      expect(plan(text, text, operations).text).toBe(expected);
      expect(plan(text, text, [...operations].reverse()).text).toBe(expected);
    }

    const sharedDestination: EditOperation[] = [
      { op: "copy_range", startLine: 1, endLine: 1, afterLine: 6 },
      { op: "copy_range", startLine: 2, endLine: 2, afterLine: 6 },
      { op: "insert", afterLine: 6, lines: ["X"] },
    ];
    for (const operations of permutations(sharedDestination)) {
      expect(failureMessage(() => plan(text, text, operations))).toBe(
        `INSERTION_BOUNDARY_CONFLICT: Multiple insertions use the same snapshot boundary. Combine them into one insertion in the desired order. Conflict: operations[0] (${operations[0]?.op}) and operations[1] (${operations[1]?.op}). ${CONFLICT_RECOVERY}`,
      );
    }
  });

  test("preflights composite bounds and preserves move no-op validation", () => {
    const text = "A\nB\nC\nD\n";
    const move: MoveOperation = {
      op: "move_range",
      startLine: 4,
      endLine: 4,
      afterLine: 0,
    };
    const replacement: ReplaceOperation = {
      op: "replace",
      startLine: 2,
      endLine: 2,
      lines: ["long-1", "é", "emoji-😀", "long-4"],
    };
    const expected = composedMoveOracle(text, move, [replacement]);
    const expectedDocument = document(expected);
    for (const operations of permutations<EditOperation>([move, replacement])) {
      expect(
        plan(text, text, operations, "none", {
          maxFileBytes: expectedDocument.bytes.byteLength,
          maxLines: expectedDocument.lines.length,
        }).text,
      ).toBe(expected);
      expect(() =>
        plan(text, text, operations, "none", {
          maxFileBytes: expectedDocument.bytes.byteLength - 1,
        }),
      ).toThrow("UNSUPPORTED_FILE:");
      expect(() =>
        plan(text, text, operations, "none", {
          maxLines: expectedDocument.lines.length - 1,
        }),
      ).toThrow("UNSUPPORTED_FILE:");
    }

    const noChange: EditOperation[] = [
      { op: "move_range", startLine: 3, endLine: 3, afterLine: 0 },
      { op: "replace", startLine: 1, endLine: 1, lines: ["A"] },
    ];
    for (const operations of permutations(noChange)) {
      expect(failureMessage(() => plan("B\nA\nA\n", "B\nA\nA\n", operations))).toBe(
        "NO_CHANGE: A move changes no bytes.",
      );
    }
  });

  test("preflights projected bytes and logical lines before copy materialization", () => {
    const text = "a\nb\n";
    const operation: EditOperation = {
      op: "copy_range",
      startLine: 1,
      endLine: 1,
      afterLine: 2,
    };
    expect(() => plan(text, text, [operation], "none", { maxFileBytes: 5 })).toThrow(
      "UNSUPPORTED_FILE:",
    );
    expect(() => plan(text, text, [operation], "none", { maxLines: 2 })).toThrow(
      "UNSUPPORTED_FILE:",
    );
    expect(
      plan(
        "\nlast",
        "\nlast",
        [{ op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 }],
        "none",
        { maxLines: 2 },
      ).text,
    ).toBe("\nlast\n");

    const amplified = `${"x".repeat(100)}\n${Array.from({ length: 100 }, () => "y\n").join("")}`;
    const copies: EditOperation[] = Array.from({ length: 100 }, (_, index) => ({
      op: "copy_range",
      startLine: 1,
      endLine: 1,
      afterLine: index + 1,
    }));
    expect(() =>
      plan(amplified, amplified, copies, "none", {
        maxFileBytes: document(amplified).bytes.byteLength + 100,
      }),
    ).toThrow("UNSUPPORTED_FILE:");

    const mergeText = "a\rx\r\n\nz";
    const mergeOperations: EditOperation[] = [
      { op: "replace", startLine: 2, endLine: 2, lines: [] },
      { op: "copy_range", startLine: 4, endLine: 4, afterLine: 3 },
      { op: "copy_range", startLine: 4, endLine: 4, afterLine: 4 },
    ];
    const merged = plan(mergeText, mergeText, mergeOperations, "none", { maxLines: 4 });
    expect(merged.text).toBe("a\r\nz\nz\rz");
    expect(document(merged.text).lines).toHaveLength(4);

    const observedBase = document(amplified);
    let textReads = 0;
    const observed: TextDocument = {
      ...observedBase,
      lines: observedBase.lines.map((line) => {
        const text = line.text;
        return {
          ...line,
          get text() {
            textReads += 1;
            return text;
          },
        };
      }),
    };
    expect(() =>
      planEdits({
        base: observed,
        current: observed,
        operations: copies,
        rebase: "none",
        maxContextLines: 2,
        maxFileBytes: observed.bytes.byteLength + 100,
      }),
    ).toThrow("UNSUPPORTED_FILE:");
    expect(textReads).toBeLessThanOrEqual(observed.lines.length + 2);
  });

  test("relocates copy source and destination independently with one exact snapshot model", () => {
    const base = "a\nsource-1\nsource-2\nmiddle\ndestination\ntail\n";
    const current = "top\na\nsource-1\nsource-2\nmiddle\nextra\ndestination\ntail\n";
    const result = plan(
      base,
      current,
      [{ op: "copy_range", startLine: 2, endLine: 3, afterLine: 5 }],
      "unique",
    );
    expect(result.text).toBe(
      "top\na\nsource-1\nsource-2\nmiddle\nextra\ndestination\nsource-1\nsource-2\ntail\n",
    );
    expect(result.rebased).toBe(true);
  });

  test("rejects transfer anchors whose global order reverses during unique relocation", () => {
    const base = "A\nsource\nB\ndestination\nC\n";
    const current = "destination\nC\nA\nsource\nB\n";
    expect(() =>
      plan(base, current, [{ op: "copy_range", startLine: 2, endLine: 2, afterLine: 4 }], "unique"),
    ).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("relocates an intact move corridor and rejects changes inside it", () => {
    const operation: EditOperation = {
      op: "move_range",
      startLine: 5,
      endLine: 5,
      afterLine: 2,
    };
    expect(plan("a\nb\nc\nd\ne\nf\n", "top\na\nb\nc\nd\ne\nf\n", [operation], "unique").text).toBe(
      "top\na\nb\ne\nc\nd\nf\n",
    );
    expect(() =>
      plan("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nnew\nd\ne\nf\n", [operation], "unique"),
    ).toThrow(/TARGET_CHANGED:|AMBIGUOUS_RELOCATION:/);
  });

  test("relocates an intact composite corridor and rejects external changes inside it", () => {
    const base = "head\nA\nB\nC\nD\ntail\n";
    const move: MoveOperation = {
      op: "move_range",
      startLine: 5,
      endLine: 5,
      afterLine: 2,
    };
    const replacement: ReplaceOperation = {
      op: "replace",
      startLine: 3,
      endLine: 4,
      lines: ["X", "Y", "Z"],
    };
    const expected = composedMoveOracle(base, move, [replacement]);
    for (const operations of permutations<EditOperation>([move, replacement])) {
      const relocated = plan(base, `prefix\n${base}`, operations, "unique");
      expect(relocated.text).toBe(`prefix\n${expected}`);
      expect(relocated.rebased).toBe(true);
      expect(() => plan(base, "head\nA\nB\nchanged\nC\nD\ntail\n", operations, "unique")).toThrow(
        /TARGET_CHANGED:|AMBIGUOUS_RELOCATION:/,
      );
    }
  });

  test("rejects ambiguous transfer anchors under exact unique relocation", () => {
    expect(() =>
      plan(
        "a\nsource\nb\n",
        "a\nsource\nb\nsource\nb\n",
        [{ op: "copy_range", startLine: 2, endLine: 2, afterLine: 3 }],
        "unique",
        { maxContextLines: 0 },
      ),
    ).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("matches insert and fixed-slot move oracles across small line geometries", () => {
    const eolPatterns = [
      ["\n", "\n", "\n", "\n", "\n"],
      ["\r\n", "\n", "\r", "\r\n", ""],
    ];
    for (const eols of eolPatterns) {
      const text = renderLines(["L1", "L2", "L3", "L4", "L5"], eols);
      for (let startLine = 1; startLine <= 5; startLine += 1) {
        for (let endLine = startLine; endLine <= 5; endLine += 1) {
          const source = document(text)
            .lines.slice(startLine - 1, endLine)
            .map((line) => line.text);
          for (let afterLine = 0; afterLine <= 5; afterLine += 1) {
            expect(
              plan(text, text, [{ op: "copy_range", startLine, endLine, afterLine }]).text,
            ).toBe(plan(text, text, [{ op: "insert", afterLine, lines: source }]).text);

            if (afterLine >= startLine - 1 && afterLine <= endLine) continue;
            expect(
              plan(text, text, [{ op: "move_range", startLine, endLine, afterLine }]).text,
            ).toBe(moveOracle(text, startLine, endLine, afterLine));
          }
        }
      }
    }
  });
});
