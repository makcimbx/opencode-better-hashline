import { describe, expect, test } from "bun:test";
import {
  assertLogicalLines,
  bytesEqual,
  decodeTextDocument,
  encodeNewText,
  encodeTextDocument,
} from "../src/text.js";

const encoder = new TextEncoder();

describe("text documents", () => {
  test("preserves BOM, Unicode, mixed endings, and offsets", () => {
    const body = encoder.encode("alpha\r\nbeta\nlast\r");
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...body);
    const document = decodeTextDocument(bytes);

    expect(document.bom).toBe(true);
    expect(document.text).toBe("alpha\r\nbeta\nlast\r");
    expect(document.lines.map(({ number, text, eol }) => ({ number, text, eol }))).toEqual([
      { number: 1, text: "alpha", eol: "\r\n" },
      { number: 2, text: "beta", eol: "\n" },
      { number: 3, text: "last", eol: "\r" },
    ]);
    expect(document.lines[1]).toMatchObject({ start: 7, contentEnd: 11, end: 12 });
    expect(document.preferredEol).toBe("\r\n");
    expect(document.finalNewline).toBe(true);
    expect(encodeTextDocument(document.text, document.bom)).toEqual(bytes);
  });

  test("handles empty files and does not invent a line after a final newline", () => {
    expect(decodeTextDocument(new Uint8Array()).lines).toEqual([]);
    const newline = decodeTextDocument(encoder.encode("\n"));
    expect(newline.lines).toHaveLength(1);
    expect(newline.lines[0]).toMatchObject({ text: "", eol: "\n" });
  });

  test("selects the most frequent line ending", () => {
    const document = decodeTextDocument(encoder.encode("a\nb\r\nc\r\nd"));
    expect(document.preferredEol).toBe("\r\n");
    expect(document.finalNewline).toBe(false);
  });

  test("rejects invalid UTF-8 and binary-like content", () => {
    expect(() => decodeTextDocument(Uint8Array.of(0xff))).toThrow("UNSUPPORTED_FILE:");
    expect(() => decodeTextDocument(Uint8Array.of(0))).toThrow("UNSUPPORTED_FILE:");
    expect(() => decodeTextDocument(Uint8Array.of(1, 2, 3, 65))).toThrow("UNSUPPORTED_FILE:");
    expect(() => decodeTextDocument(encoder.encode("\n".repeat(5)), 4)).toThrow(
      "UNSUPPORTED_FILE:",
    );
  });

  test("validates model-provided Unicode and logical lines", () => {
    expect(() => assertLogicalLines(["safe", ""])).not.toThrow();
    expect(() => assertLogicalLines(["bad\nline"])).toThrow("INVALID_ARGUMENT:");
    expect(() => assertLogicalLines(["bad\rline"])).toThrow("INVALID_ARGUMENT:");
    expect(() => assertLogicalLines(["bad\0line"])).toThrow("INVALID_ARGUMENT:");
    expect(() => assertLogicalLines(["\ud800"])).toThrow("INVALID_ARGUMENT:");
    expect(() => encodeNewText("\udc00")).toThrow("INVALID_ARGUMENT:");
    expect(encodeNewText("valid 😀")).toEqual(encoder.encode("valid 😀"));
  });

  test("compares byte arrays exactly", () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
  });
});
