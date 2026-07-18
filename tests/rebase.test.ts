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

  test("rejects changed target bytes including line endings", () => {
    expect(() => mapRangeUniquely(lines("a\nb\n"), lines("a\nchanged\n"), 2, 2, 2)).toThrow(
      "TARGET_CHANGED:",
    );
    expect(() => mapRangeUniquely(lines("a\r\nb\r\n"), lines("a\r\nb\n"), 2, 2, 2)).toThrow(
      "TARGET_CHANGED:",
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
    expect(mapBoundaryUniquely([], [], 0, 2)).toBe(0);
    expect(() => mapBoundaryUniquely([], lines("new"), 0, 2)).toThrow("BOUNDARY_CHANGED:");
    expect(() => mapBoundaryUniquely(base, base, -1, 2)).toThrow("INVALID_ARGUMENT:");
  });

  test("bounds cumulative unique-relocation search work", () => {
    const mapper = createUniqueMapper(lines("a\nb\nc\n"), lines("new\na\nb\nc\n"), 1);
    expect(() => mapper.mapRange(2, 2, 2)).toThrow("UNSUPPORTED_FILE:");
  });
});
