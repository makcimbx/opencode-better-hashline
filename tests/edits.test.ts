import { describe, expect, test } from "bun:test";
import { type EditOperation, planEdits } from "../src/edits.js";
import { HashlineError } from "../src/errors.js";
import { decodeTextDocument } from "../src/text.js";

const encoder = new TextEncoder();
const document = (text: string, bom = false) => {
  const body = encoder.encode(text);
  return decodeTextDocument(bom ? Uint8Array.of(0xef, 0xbb, 0xbf, ...body) : body);
};

function plan(
  baseText: string,
  currentText: string,
  operations: EditOperation[],
  rebase: "none" | "unique" = "none",
) {
  return planEdits({
    base: document(baseText),
    current: document(currentText),
    operations,
    rebase,
    maxContextLines: 2,
  });
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

describe("line edit planning", () => {
  test("composes non-overlapping replacements and insertions", () => {
    const result = plan("one\r\ntwo\r\nthree", "one\r\ntwo\r\nthree", [
      { op: "replace", startLine: 2, endLine: 2, lines: ["TWO", "2b"] },
      { op: "insert", afterLine: 3, lines: ["four"] },
    ]);
    expect(result.text).toBe("one\r\nTWO\r\n2b\r\nthree\r\nfour");
    expect(result.operationCount).toBe(2);
    expect(result.rebased).toBe(false);

    expect(
      plan("one\ntwo\n", "one\ntwo\n", [
        { op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] },
        { op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] },
      ]).text,
    ).toBe("ONE\nTWO\n");
  });

  test("treats replacement lines as complete content for the selected range", () => {
    const base = "block {\n  old();\n}\nafter();\n";
    expect(
      plan(base, base, [{ op: "replace", startLine: 2, endLine: 2, lines: ["  new();", "}"] }])
        .text,
    ).toBe("block {\n  new();\n}\n}\nafter();\n");
    expect(
      plan(base, base, [{ op: "replace", startLine: 2, endLine: 3, lines: ["  new();"] }]).text,
    ).toBe("block {\n  new();\nafter();\n");
  });

  test("uses original immutable coordinates for every operation in a batch", () => {
    const base = "one\ntwo\nthree\nfour\n";
    expect(
      plan(base, base, [
        { op: "replace", startLine: 1, endLine: 1, lines: ["ONE", "inserted"] },
        { op: "replace", startLine: 3, endLine: 3, lines: ["THREE"] },
      ]).text,
    ).toBe("ONE\ninserted\ntwo\nTHREE\nfour\n");
    expect(
      plan(base, base, [
        { op: "replace", startLine: 1, endLine: 1, lines: ["ONE", "inserted"] },
        { op: "replace", startLine: 4, endLine: 4, lines: ["intended-for-three"] },
      ]).text,
    ).toBe("ONE\ninserted\ntwo\nthree\nintended-for-three\n");
  });

  test("accepts intentional adjacent delimiters at a replacement endpoint", () => {
    const base = "block {\nold\nnext\n";
    const operations: EditOperation[] = [
      { op: "replace", startLine: 2, endLine: 2, lines: ["}"] },
      { op: "insert", afterLine: 2, lines: ["}"] },
    ];
    expect(plan(base, base, operations).text).toBe("block {\n}\n}\nnext\n");
    expect(plan(base, base, [...operations].reverse()).text).toBe("block {\n}\n}\nnext\n");
  });

  test("copies from the immutable pre-edit source", () => {
    const base = "source\ntarget\nend\n";
    expect(
      plan(base, base, [
        { op: "replace", startLine: 1, endLine: 1, lines: ["changed"] },
        { op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 },
      ]).text,
    ).toBe("changed\ntarget\nsource\nend\n");
  });

  test("distinguishes deletion from a blank line", () => {
    expect(
      plan("one\ntwo\nthree\n", "one\ntwo\nthree\n", [
        { op: "replace", startLine: 2, endLine: 2, lines: [] },
      ]).text,
    ).toBe("one\nthree\n");
    expect(
      plan("one\ntwo\nthree\n", "one\ntwo\nthree\n", [
        { op: "replace", startLine: 2, endLine: 2, lines: [""] },
      ]).text,
    ).toBe("one\n\nthree\n");
  });

  test("inserts at BOF, EOF, and into an empty file", () => {
    expect(plan("a\nb\n", "a\nb\n", [{ op: "insert", afterLine: 0, lines: ["before"] }]).text).toBe(
      "before\na\nb\n",
    );
    expect(plan("a\nb", "a\nb", [{ op: "insert", afterLine: 2, lines: ["after"] }]).text).toBe(
      "a\nb\nafter",
    );
    expect(plan("", "", [{ op: "insert", afterLine: 0, lines: ["first"] }]).text).toBe("first");
  });

  test("replaces a complete file while preserving BOM and preferred EOL", () => {
    const base = document("a\r\nb\r\n", true);
    const result = planEdits({
      base,
      current: base,
      operations: [{ op: "replace_file", lines: ["x", "y"] }],
      rebase: "none",
      maxContextLines: 2,
    });
    expect(result.text).toBe("x\r\ny\r\n");
    expect(result.bytes.slice(0, 3)).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf));
    expect(
      plan("a\n", "a\n", [{ op: "replace_file", lines: ["x"], finalNewline: false }]).text,
    ).toBe("x");
    expect(plan("a", "a", [{ op: "replace_file", lines: ["x"] }]).text).toBe("x");
  });

  test("strict mode rejects stale bytes and unique mode preserves unrelated insertion", () => {
    const operation: EditOperation = { op: "replace", startLine: 2, endLine: 2, lines: ["B"] };
    expect(() => plan("a\nb\nc\n", "new\na\nb\nc\n", [operation])).toThrow("TARGET_CHANGED:");
    const result = plan("a\nb\nc\n", "new\na\nb\nc\n", [operation], "unique");
    expect(result.text).toBe("new\na\nB\nc\n");
    expect(result.rebased).toBe(true);
  });

  test("unique mode rejects target, EOL, and BOM changes", () => {
    const operation: EditOperation = { op: "replace", startLine: 2, endLine: 2, lines: ["B"] };
    expect(() => plan("a\nb\n", "a\nchanged\n", [operation], "unique")).toThrow("TARGET_CHANGED:");
    expect(() => plan("a\r\nb\r\n", "a\r\nb\n", [operation], "unique")).toThrow("TARGET_CHANGED:");
    expect(() =>
      planEdits({
        base: document("a\nb\n", true),
        current: document("a\nb\n"),
        operations: [operation],
        rebase: "unique",
        maxContextLines: 2,
      }),
    ).toThrow("TARGET_CHANGED:");
  });

  test("reports original operations for conflicts after unique relocation", () => {
    const operations: EditOperation[] = [
      { op: "replace", startLine: 1, endLine: 2, lines: ["first"] },
      { op: "replace", startLine: 4, endLine: 5, lines: ["second"] },
    ];
    expect(
      failureMessage(() => plan("A\nB\nmiddle\nB\nC\n", "A\nB\nC\n", operations, "unique")),
    ).toBe(
      "OPERATIONS_OVERLAP: Edit operations overlap after relocation. Conflict: operations[0] (replace) and operations[1] (replace).",
    );
  });

  test("rejects malformed, overlapping, and ineffective batches", () => {
    expect(() => plan("a\n", "a\n", [])).toThrow("INVALID_ARGUMENT:");
    expect(() =>
      plan("a\nb\n", "a\nb\n", [{ op: "replace", startLine: 0, endLine: 1, lines: ["x"] }]),
    ).toThrow("INVALID_ARGUMENT:");
    expect(
      failureMessage(() =>
        plan("a\nb\n", "a\nb\n", [
          { op: "replace", startLine: 1, endLine: 2, lines: ["x"] },
          { op: "replace", startLine: 2, endLine: 2, lines: ["y"] },
        ]),
      ),
    ).toBe(
      "OPERATIONS_OVERLAP: Replacement ranges overlap in the snapshot. Merge them into one replacement, or split the edits. Conflict: operations[0] (replace) and operations[1] (replace).",
    );
    expect(
      failureMessage(() =>
        plan("a\nb\n", "a\nb\n", [
          { op: "insert", afterLine: 1, lines: ["x"] },
          { op: "insert", afterLine: 1, lines: ["y"] },
        ]),
      ),
    ).toBe(
      "INSERTION_BOUNDARY_CONFLICT: Multiple insertions use the same snapshot boundary. Combine them into one insertion in the desired order. Conflict: operations[0] (insert) and operations[1] (insert).",
    );
    expect(
      failureMessage(() =>
        plan("a\nb\n", "a\nb\n", [
          { op: "replace", startLine: 1, endLine: 2, lines: ["x"] },
          { op: "insert", afterLine: 1, lines: ["y"] },
        ]),
      ),
    ).toBe(
      "OPERATIONS_OVERLAP: An insertion is inside a replacement range. Fold it into the replacement, or split the edits. Conflict: operations[0] (replace) and operations[1] (insert).",
    );
    expect(
      failureMessage(() =>
        plan("a\nb\n", "a\nb\n", [
          { op: "insert", afterLine: 1, lines: ["y"] },
          { op: "replace", startLine: 1, endLine: 2, lines: ["x"] },
        ]),
      ),
    ).toBe(
      "OPERATIONS_OVERLAP: An insertion is inside a replacement range. Fold it into the replacement, or split the edits. Conflict: operations[0] (insert) and operations[1] (replace).",
    );
    expect(() => plan("a\n", "a\n", [{ op: "insert", afterLine: 1, lines: [] }])).toThrow(
      "INVALID_ARGUMENT:",
    );
    expect(() =>
      plan("a\n", "a\n", [{ op: "replace", startLine: 1, endLine: 1, lines: ["a"] }]),
    ).toThrow("NO_CHANGE:");
    expect(() =>
      plan("a\n", "a\n", [{ op: "replace", startLine: 1, endLine: 1, lines: ["x\ny"] }]),
    ).toThrow("INVALID_ARGUMENT:");
  });

  test("explains immutable coordinates for out-of-range operations", () => {
    const base = "a\nb\n";
    const cases: Array<{ operation: EditOperation; message: string }> = [
      {
        operation: { op: "replace", startLine: 3, endLine: 3, lines: ["x"] },
        message: "The replacement range is outside the snapshot.",
      },
      {
        operation: { op: "insert", afterLine: 3, lines: ["x"] },
        message: "The insertion boundary is outside the snapshot.",
      },
      {
        operation: { op: "copy_range", startLine: 3, endLine: 3, afterLine: 0 },
        message: "The transfer source range is outside the snapshot.",
      },
      {
        operation: { op: "copy_range", startLine: 1, endLine: 1, afterLine: 3 },
        message: "The transfer destination boundary is outside the snapshot.",
      },
    ];
    for (const { operation, message } of cases) {
      expect(failureMessage(() => plan(base, base, [operation]))).toBe(
        `INVALID_ARGUMENT: ${message} Every operation uses original immutable pre-batch coordinates.`,
      );
    }
  });

  test("allows insertions at destructive range boundaries independent of array order", () => {
    const cases: Array<{ operations: EditOperation[]; expected: string }> = [
      {
        operations: [
          { op: "replace", startLine: 1, endLine: 1, lines: ["A"] },
          { op: "insert", afterLine: 1, lines: ["between"] },
        ],
        expected: "A\nbetween\nb\n",
      },
      {
        operations: [
          { op: "replace", startLine: 2, endLine: 2, lines: ["B"] },
          { op: "insert", afterLine: 1, lines: ["between"] },
        ],
        expected: "a\nbetween\nB\n",
      },
    ];

    for (const { operations, expected } of cases) {
      expect(plan("a\nb\n", "a\nb\n", operations).text).toBe(expected);
      expect(plan("a\nb\n", "a\nb\n", [...operations].reverse()).text).toBe(expected);
    }
  });

  test("keeps replace_file exclusive and infers an empty file without a newline", () => {
    expect(() =>
      plan("a\n", "a\n", [
        { op: "replace_file", lines: ["x"] },
        { op: "insert", afterLine: 1, lines: ["y"] },
      ]),
    ).toThrow("INVALID_ARGUMENT: replace_file must be the only operation.");
    expect(() => plan("a\n", "a\n", [{ op: "replace_file", lines: ["x"] }], "unique")).toThrow(
      "INVALID_ARGUMENT: replace_file does not support unique rebase.",
    );
    expect(plan("a\n", "a\n", [{ op: "replace_file", lines: [] }]).text).toBe("");
    expect(() =>
      plan("a\n", "a\n", [{ op: "replace_file", lines: [], finalNewline: true }]),
    ).toThrow("INVALID_ARGUMENT:");
    expect(plan("a\n", "a\n", [{ op: "replace_file", lines: [], finalNewline: false }]).text).toBe(
      "",
    );
    expect(plan("a", "a", [{ op: "replace_file", lines: [] }]).text).toBe("");
  });
});
