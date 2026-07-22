import { describe, expect, test } from "bun:test";
import { createUniqueMapper, mapBoundaryUniquely, mapRangeUniquely } from "../src/rebase.js";
import { decodeTextDocument } from "../src/text.js";

const encoder = new TextEncoder();
const lines = (text: string) => decodeTextDocument(encoder.encode(text)).lines;

describe("unique relocation", () => {
  test("relocates an unchanged range after unrelated insertion", () => {
    expect(mapRangeUniquely(lines("a\nb\nc\n"), lines("new\na\nb\nc\n"), 2, 2, 2)).toEqual({
      start: 2,
      end: 2,
    });
  });

  test("uses exact context to disambiguate duplicate targets", () => {
    const base = lines("left\ntarget\nright\nother\ntarget\nend\n");
    const current = lines("prefix\nleft\ntarget\nright\nother\ntarget\nend\n");
    expect(mapRangeUniquely(base, current, 2, 2, 1)).toEqual({ start: 2, end: 2 });
    expect(() => mapRangeUniquely(base, current, 2, 2, 0)).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("does not mistake the sole surviving duplicate for the selected target", () => {
    const base = lines("left\ntarget\nright\nother\ntarget\nend\n");
    const current = lines("left\nchanged\nright\nother\ntarget\nend\n");
    expect(() => mapRangeUniquely(base, current, 2, 2, 2)).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("rejects contradictory range evidence across sides and context sizes", () => {
    expect(() => mapRangeUniquely(lines("L\nT\nR\n"), lines("L\nT\nmid\nT\nR\n"), 2, 2, 1)).toThrow(
      "AMBIGUOUS_RELOCATION:",
    );
    expect(() =>
      mapRangeUniquely(
        lines("A\nL\nT\nR\nB\n"),
        lines("A\nL\nT\nX\nQ\nL\nT\nY\nZ\nT\nR\nB\n"),
        3,
        3,
        2,
      ),
    ).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("diagnoses exact LF and CRLF delimiter changes at the selected range", () => {
    const diagnostic =
      "TARGET_CHANGED: Lines 2-2 are no longer unchanged. Exact line delimiters changed; reread the file before retrying.";
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("a\nb\r\n"), 2, 2, 2)).toThrow(diagnostic);
    expect(() => mapRangeUniquely(lines("a\r\nb\r\n"), lines("a\r\nb\n"), 2, 2, 2)).toThrow(
      diagnostic,
    );
  });

  test("diagnoses exact lone-CR and mixed delimiter changes", () => {
    expect(() => mapRangeUniquely(lines("a\rb\r"), lines("a\rb\n"), 2, 2, 2)).toThrow(
      "TARGET_CHANGED: Lines 2-2 are no longer unchanged. Exact line delimiters changed; reread the file before retrying.",
    );
    expect(() =>
      mapRangeUniquely(
        lines("head\r\nleft\nright\rtail\r\n"),
        lines("head\r\nleft\rright\ntail\r\n"),
        2,
        3,
        2,
      ),
    ).toThrow(
      "TARGET_CHANGED: Lines 2-3 are no longer unchanged. Exact line delimiters changed; reread the file before retrying.",
    );
  });

  test("diagnoses a changed final delimiter in either direction", () => {
    const diagnostic =
      "TARGET_CHANGED: Lines 2-2 are no longer unchanged. Exact line delimiters changed; reread the file before retrying.";
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("a\nb"), 2, 2, 2)).toThrow(diagnostic);
    expect(() => mapRangeUniquely(lines("a\nb"), lines("a\nb\n"), 2, 2, 2)).toThrow(diagnostic);
  });

  test("keeps the generic target-change error when content also changes", () => {
    const generic = /^TARGET_CHANGED: Lines 2-2 are no longer unchanged\.$/;
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("a\nchanged\n"), 2, 2, 2)).toThrow(
      generic,
    );
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("a\nchanged\r\n"), 2, 2, 2)).toThrow(
      generic,
    );
    expect(() => mapRangeUniquely(lines("a\n\u00e9\n"), lines("a\ne\u0301\r\n"), 2, 2, 2)).toThrow(
      generic,
    );
  });

  test("does not infer delimiter-only changes across shifted or missing ranges", () => {
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("new\na\nb\r\n"), 2, 2, 2)).toThrow(
      /^TARGET_CHANGED: Lines 2-2 are no longer unchanged\.$/,
    );
    expect(() => mapRangeUniquely(lines("a\nb\nc\n"), lines("a\nbc\n"), 2, 3, 2)).toThrow(
      /^TARGET_CHANGED: Lines 2-3 are no longer unchanged\.$/,
    );
  });

  test("keeps an unaffected final unterminated target exact", () => {
    expect(mapRangeUniquely(lines("a\nb"), lines("a\r\nb"), 2, 2, 2)).toEqual({
      start: 1,
      end: 1,
    });
    expect(mapRangeUniquely(lines("a\nb"), lines("new\na\nb"), 2, 2, 2)).toEqual({
      start: 2,
      end: 2,
    });
  });

  test("keeps boundary failures free of range delimiter diagnostics", () => {
    expect(() => mapBoundaryUniquely(lines("a\nb\n"), lines("a\r\nb\n"), 1, 2)).toThrow(
      /^BOUNDARY_CHANGED: The insertion boundary is no longer adjacent\.$/,
    );
  });

  test("relocates an interior boundary only while both sides stay adjacent", () => {
    const base = lines("a\nb\nc\n");
    expect(mapBoundaryUniquely(base, lines("prefix\na\nb\nc\n"), 2, 2)).toBe(3);
    expect(() => mapBoundaryUniquely(base, lines("a\nb\ninserted\nc\n"), 2, 2)).toThrow(
      "BOUNDARY_CHANGED:",
    );
  });

  test("rejects ambiguous interior boundaries", () => {
    const duplicate = lines("a\nb\na\nb\n");
    expect(() => mapBoundaryUniquely(duplicate, duplicate, 1, 0)).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("does not mistake the sole surviving duplicate pair for the selected boundary", () => {
    const base = lines("A\nL\nR\nB\nL\nR\nC\n");
    const current = lines("A\nL\nchanged\nR\nB\nL\nR\nC\n");
    expect(() => mapBoundaryUniquely(base, current, 2, 2)).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("rejects contradictory boundary evidence across sides and context sizes", () => {
    expect(() =>
      mapBoundaryUniquely(lines("A\nL\nR\nB\n"), lines("A\nL\nR\nmid\nL\nR\nB\n"), 2, 1),
    ).toThrow("AMBIGUOUS_RELOCATION:");
    expect(() =>
      mapBoundaryUniquely(
        lines("C\nA\nL\nR\nB\nD\n"),
        lines("C\nA\nL\nR\nX\nQ\nA\nL\nR\nY\nZ\nL\nR\nB\nD\n"),
        3,
        2,
      ),
    ).toThrow("AMBIGUOUS_RELOCATION:");
  });

  test("accepts only the candidate supported by every successful signature", () => {
    const base = lines("left\ntarget\nright\nother\ntarget\nend\n");
    const current = lines("prefix\nleft\ntarget\nchanged\nother\ntarget\nend\n");
    expect(mapRangeUniquely(base, current, 2, 2, 2)).toEqual({ start: 2, end: 2 });
  });

  test("guards BOF, EOF, empty files, and invalid boundaries", () => {
    const base = lines("a\nb\n");
    expect(mapBoundaryUniquely(base, base, 0, 2)).toBe(0);
    expect(mapBoundaryUniquely(base, base, 2, 2)).toBe(2);
    expect(() => mapBoundaryUniquely(base, lines("new\na\nb\n"), 0, 2)).toThrow(
      "BOUNDARY_CHANGED:",
    );
    expect(() => mapBoundaryUniquely(base, lines("a\nb\nnew\n"), 2, 2)).toThrow(
      "BOUNDARY_CHANGED:",
    );
    expect(mapBoundaryUniquely(base, lines("new\na\nb\n"), 2, 2)).toBe(3);
    expect(mapBoundaryUniquely(base, lines("a\nb\nnew\n"), 0, 2)).toBe(0);
    expect(mapBoundaryUniquely([], [], 0, 2)).toBe(0);
    expect(() => mapBoundaryUniquely([], lines("new"), 0, 2)).toThrow("BOUNDARY_CHANGED:");
    expect(() => mapBoundaryUniquely(base, base, -1, 2)).toThrow("INVALID_ARGUMENT:");
    expect(() => mapBoundaryUniquely(lines("a\nb\n"), lines("a\nb\na\nb\n"), 0, 1)).toThrow(
      "AMBIGUOUS_RELOCATION:",
    );
    expect(() => mapBoundaryUniquely(lines("a\nb\n"), lines("a\nb\na\nb\n"), 2, 1)).toThrow(
      "AMBIGUOUS_RELOCATION:",
    );
    expect(() => mapBoundaryUniquely(lines("a\nb\n"), lines("a\nb\na\nb\na\nb\n"), 2, 1)).toThrow(
      "AMBIGUOUS_RELOCATION:",
    );
  });

  test("bounds cumulative unique-relocation search work", () => {
    const mapper = createUniqueMapper(lines("a\nb\nc\n"), lines("new\na\nb\nc\n"), 1);
    expect(() => mapper.mapRange(2, 2, 2)).toThrow("UNSUPPORTED_FILE:");

    const long = "x".repeat(100);
    const longLineMapper = createUniqueMapper(
      lines(`${long}\nother\n`),
      lines(`${long}\nother\n`),
      50,
    );
    expect(() => longLineMapper.mapRange(1, 1, 1)).toThrow("UNSUPPORTED_FILE:");

    const shiftedLongLine = createUniqueMapper(lines("target\n"), lines(`${long}\ntarget\n`), 50);
    expect(shiftedLongLine.mapRange(1, 1, 1)).toEqual({ start: 1, end: 1 });
  });

  test("omits the optional EOL diagnostic when its work budget is exhausted", () => {
    const long = "x".repeat(2_000_000);
    const mapper = createUniqueMapper(lines(`${long}\n`), lines(`${long}\r\n`), 2_000_010);
    expect(() => mapper.mapRange(1, 1, 0)).toThrow(
      /^TARGET_CHANGED: Lines 1-1 are no longer unchanged\.$/,
    );
  });
});
