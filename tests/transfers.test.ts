import { describe, expect, test } from "bun:test";
import { type EditOperation, planEdits } from "../src/edits.js";
import { HashlineError } from "../src/errors.js";
import { decodeTextDocument, type TextDocument } from "../src/text.js";

const encoder = new TextEncoder();

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
    const conflict: EditOperation[] = [
      { op: "move_range", startLine: 2, endLine: 2, afterLine: 1 },
      { op: "replace", startLine: 2, endLine: 2, lines: ["B"] },
    ];
    for (const ordered of permutations(conflict)) {
      expect(() => plan("a\nb", "a\nb", ordered)).toThrow("OPERATIONS_OVERLAP:");
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

  test("uses one conflict-class diagnostic for every operation permutation", () => {
    const text = "a\nb\nc\nd\ne\nf\n";
    const operations: EditOperation[] = [
      { op: "insert", afterLine: 5, lines: ["X"] },
      { op: "insert", afterLine: 5, lines: ["Y"] },
      { op: "copy_range", startLine: 2, endLine: 3, afterLine: 0 },
      { op: "replace", startLine: 3, endLine: 3, lines: ["C"] },
    ];
    const messages = permutations(operations).map((ordered) =>
      failureMessage(() => plan(text, text, ordered)),
    );
    expect(new Set(messages)).toEqual(
      new Set([
        "INSERTION_BOUNDARY_CONFLICT: Multiple insertions use the same snapshot boundary. Combine them into one insertion in the desired order.",
      ]),
    );
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

    for (const operations of [
      [
        { op: "copy_range", startLine: 1, endLine: 1, afterLine: 6 },
        { op: "copy_range", startLine: 2, endLine: 2, afterLine: 6 },
      ],
    ] satisfies EditOperation[][]) {
      expect(() => plan(text, text, operations)).toThrow("INSERTION_BOUNDARY_CONFLICT:");
      expect(() => plan(text, text, [...operations].reverse())).toThrow(
        "INSERTION_BOUNDARY_CONFLICT:",
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
