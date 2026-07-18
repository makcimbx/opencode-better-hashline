import { fail } from "./errors.js";

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export type LineEnding = "\n" | "\r\n" | "\r" | "";

export interface TextLine {
  /** One-based model-visible line number. */
  number: number;
  /** UTF-16 offsets into TextDocument.text. */
  start: number;
  contentEnd: number;
  end: number;
  text: string;
  eol: LineEnding;
}

export interface TextDocument {
  bytes: Uint8Array;
  text: string;
  bom: boolean;
  lines: readonly TextLine[];
  preferredEol: Exclude<LineEnding, "">;
  finalNewline: boolean;
}

function startsWithBom(bytes: Uint8Array): boolean {
  return bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

export function assertEditableText(text: string): void {
  let controls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      fail("UNSUPPORTED_FILE", "NUL bytes are not editable text.");
    }
    if (code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  if (text.length > 0 && controls / text.length > 0.3) {
    fail("UNSUPPORTED_FILE", "The file contains too many control characters.");
  }
  assertUnicode(text, "Content");
}

function assertUnicode(text: string, label: string): void {
  for (let offset = 0; offset < text.length; offset += 1) {
    const code = text.charCodeAt(offset);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      !(text.charCodeAt(offset + 1) >= 0xdc00 && text.charCodeAt(offset + 1) <= 0xdfff)
    ) {
      fail("INVALID_ARGUMENT", `${label} has invalid Unicode.`);
    }
    if (
      code >= 0xdc00 &&
      code <= 0xdfff &&
      !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff)
    ) {
      fail("INVALID_ARGUMENT", `${label} has invalid Unicode.`);
    }
  }
}

function parseLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    let contentEnd = start;
    while (contentEnd < text.length && text[contentEnd] !== "\r" && text[contentEnd] !== "\n") {
      contentEnd += 1;
    }

    let end = contentEnd;
    let eol: LineEnding = "";
    if (text[contentEnd] === "\r" && text[contentEnd + 1] === "\n") {
      eol = "\r\n";
      end += 2;
    } else if (text[contentEnd] === "\r") {
      eol = "\r";
      end += 1;
    } else if (text[contentEnd] === "\n") {
      eol = "\n";
      end += 1;
    }

    lines.push({
      number: lines.length + 1,
      start,
      contentEnd,
      end,
      text: text.slice(start, contentEnd),
      eol,
    });
    start = end;
  }
  return lines;
}

function preferredLineEnding(lines: readonly TextLine[]): Exclude<LineEnding, ""> {
  const counts = new Map<Exclude<LineEnding, "">, number>();
  let first: Exclude<LineEnding, ""> | undefined;
  for (const line of lines) {
    if (line.eol === "") continue;
    first ??= line.eol;
    counts.set(line.eol, (counts.get(line.eol) ?? 0) + 1);
  }
  if (!first) return "\n";

  let preferred = first;
  let maximum = counts.get(first) ?? 0;
  for (const [ending, count] of counts) {
    if (count > maximum) {
      maximum = count;
      preferred = ending;
    }
  }
  return preferred;
}

function logicalLineCount(bytes: Uint8Array, offset: number): number {
  if (offset >= bytes.length) return 0;
  let count = 0;
  let endedAtBoundary = false;
  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      count += 1;
      endedAtBoundary = true;
      if (bytes[index + 1] === 0x0a) index += 1;
    } else if (bytes[index] === 0x0a) {
      count += 1;
      endedAtBoundary = true;
    } else {
      endedAtBoundary = false;
    }
  }
  return count + (endedAtBoundary ? 0 : 1);
}

export function assertLineLimit(bytes: Uint8Array, maxLines: number): void {
  const offset = startsWithBom(bytes) ? UTF8_BOM.length : 0;
  if (logicalLineCount(bytes, offset) > maxLines) {
    fail("UNSUPPORTED_FILE", `The file exceeds the ${maxLines}-line safety limit.`);
  }
}

export function decodeTextDocument(
  bytes: Uint8Array,
  maxLines = Number.POSITIVE_INFINITY,
): TextDocument {
  const bom = startsWithBom(bytes);
  const offset = bom ? UTF8_BOM.length : 0;
  assertLineLimit(bytes, maxLines);
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(offset));
  } catch {
    fail("UNSUPPORTED_FILE", "The file is not valid UTF-8.");
  }
  assertEditableText(text);
  const lines = parseLines(text);
  return {
    bytes,
    text,
    bom,
    lines,
    preferredEol: preferredLineEnding(lines),
    finalNewline: lines.at(-1)?.eol !== "" && lines.length > 0,
  };
}

export function encodeTextDocument(text: string, bom: boolean): Uint8Array {
  assertEditableText(text);
  const body = encoder.encode(text);
  if (!bom) return body;
  const result = new Uint8Array(UTF8_BOM.length + body.length);
  result.set(UTF8_BOM);
  result.set(body, UTF8_BOM.length);
  return result;
}

export function encodeNewText(text: string): Uint8Array {
  assertEditableText(text);
  return encoder.encode(text);
}

export function assertLogicalLines(lines: readonly string[]): void {
  for (const [index, line] of lines.entries()) {
    if (line.includes("\n") || line.includes("\r")) {
      fail("INVALID_ARGUMENT", `Logical line ${index + 1} contains a newline character.`);
    }
    if (line.includes("\0")) {
      fail("INVALID_ARGUMENT", `Logical line ${index + 1} contains a NUL character.`);
    }
    assertUnicode(line, `Logical line ${index + 1}`);
  }
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => right[index] === byte);
}
