import { Buffer } from "node:buffer";
import type { IssuedPage, IssuedRange, Snapshot } from "./snapshots.js";

export interface RenderedSnapshotPage {
  output: string;
  page: IssuedPage;
  nextOffset?: number;
  displayedLines: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeSliceEnd(content: string, end: number): number {
  if (
    end > 0 &&
    end < content.length &&
    content.charCodeAt(end - 1) >= 0xd800 &&
    content.charCodeAt(end - 1) <= 0xdbff &&
    content.charCodeAt(end) >= 0xdc00 &&
    content.charCodeAt(end) <= 0xdfff
  ) {
    return end - 1;
  }
  return end;
}

function addIssuedLine(ranges: IssuedRange[], line: number): void {
  const previous = ranges.at(-1);
  if (previous?.end === line - 1) previous.end = line;
  else ranges.push({ start: line, end: line });
}

function fitPreview(prefix: string, content: string, suffix: string, budget: number): string {
  let low = 0;
  let high = Math.min(content.length, 2000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const safeMiddle = safeSliceEnd(content, middle);
    if (byteLength(`${prefix}${content.slice(0, safeMiddle)}${suffix}`) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${prefix}${content.slice(0, safeSliceEnd(content, low))}${suffix}`;
}

export function renderSnapshotPage(input: {
  snapshot: Snapshot;
  offset: number;
  limit: number;
  maxOutputBytes: number;
}): RenderedSnapshotPage {
  const { snapshot, offset, limit, maxOutputBytes } = input;
  const total = snapshot.document.lines.length;
  const header = `@hashline snapshot=${snapshot.id} sha256=${snapshot.digest.slice(0, 12)} lines=${total}`;
  const rendered = [header];
  const ranges: IssuedRange[] = [];
  let cursor = Math.min(offset - 1, total);
  let displayedLines = 0;
  let hasPreviewOnlyLine = false;

  while (cursor < total && displayedLines < limit) {
    const line = snapshot.document.lines[cursor];
    if (!line) break;
    const full = `${line.number}|${line.text}`;
    const suffix = "... [preview only; line not issued]";
    const nextCursor = cursor + 1;
    const footer = nextCursor >= total ? "@eof" : `@more offset=${nextCursor + 1}`;
    const proposed = [...rendered, full, footer].join("\n");

    if (byteLength(proposed) > maxOutputBytes) {
      if (displayedLines > 0) break;
      const surrounding = `${rendered.join("\n")}\n\n${footer}\n@note lines marked ! cannot be edited by line reference`;
      rendered.push(
        fitPreview(`${line.number}!|`, line.text, suffix, maxOutputBytes - byteLength(surrounding)),
      );
      hasPreviewOnlyLine = true;
      cursor = nextCursor;
      displayedLines += 1;
      break;
    }

    rendered.push(full);
    addIssuedLine(ranges, line.number);
    cursor = nextCursor;
    displayedLines += 1;
  }

  const eof = cursor >= total;
  rendered.push(eof ? "@eof" : `@more offset=${cursor + 1}`);
  if (hasPreviewOnlyLine) {
    rendered.push("@note lines marked ! cannot be edited by line reference");
  }

  const result: RenderedSnapshotPage = {
    output: rendered.join("\n"),
    page: { ranges, bof: offset === 1, eof },
    displayedLines,
  };
  if (!eof) result.nextOffset = cursor + 1;
  return result;
}
