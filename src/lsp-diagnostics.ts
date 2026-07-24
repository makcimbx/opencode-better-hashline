import { Buffer } from "node:buffer";

export const LSP_DIAGNOSTIC_SEVERITY_ERROR = 1;

export interface NormalizedLspDiagnostic {
  relativePath: string;
  startLine: number;
  startCharacter: number;
  severity: number;
  serverId: string;
  code?: string | number;
  message: string;
}

export interface RenderedLspDiagnostics {
  output: string;
  errors: number;
  totalErrors: number;
  truncated: boolean;
  utf8Bytes: number;
}

export type LspUnavailableWarning = {
  code: string;
  serverId?: string;
};

export type LspUnavailableReason = "manager" | "post-publication-drift";

type RenderableDiagnostic = {
  relativePath: string;
  startLine: number;
  startCharacter: number;
  serverId: string;
  code: string;
  message: string;
};

const FORMAT_CHARACTER = /\p{Cf}/u;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function skipControlString(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function skipCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function skipAnsi(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code === 0x9b) return skipCsi(value, index + 1);
  if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return skipControlString(value, index + 1);
  }
  if (code !== 0x1b) return index + 1;

  const next = value.charCodeAt(index + 1);
  if (next === 0x5b) return skipCsi(value, index + 2);
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipControlString(value, index + 2);
  }
  return next >= 0x30 && next <= 0x7e ? index + 2 : index + 1;
}

function sanitizeField(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || (code >= 0x90 && code <= 0x9f)) {
      index = skipAnsi(value, index);
      continue;
    }
    if (code === 0x0d) {
      output += "\\r";
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      output += "\\n";
      index += 1;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    const codePoint = value.codePointAt(index) ?? code;
    const character = String.fromCodePoint(codePoint);
    if (codePoint === 0x2028) output += "\\u2028";
    else if (codePoint === 0x2029) output += "\\u2029";
    else if (codePoint >= 0xd800 && codePoint <= 0xdfff) output += "\ufffd";
    else if (!FORMAT_CHARACTER.test(character)) output += character;
    index += character.length;
  }
  return output;
}

function normalizePosition(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeDiagnostic(diagnostic: NormalizedLspDiagnostic): RenderableDiagnostic {
  return {
    relativePath: sanitizeField(diagnostic.relativePath),
    startLine: normalizePosition(diagnostic.startLine),
    startCharacter: normalizePosition(diagnostic.startCharacter),
    serverId: sanitizeField(diagnostic.serverId),
    code: diagnostic.code === undefined ? "" : sanitizeField(String(diagnostic.code)),
    message: sanitizeField(diagnostic.message),
  };
}

function compareDiagnostic(left: RenderableDiagnostic, right: RenderableDiagnostic): number {
  return (
    compareText(left.relativePath, right.relativePath) ||
    left.startLine - right.startLine ||
    left.startCharacter - right.startCharacter ||
    compareText(left.serverId, right.serverId) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function sameDiagnostic(left: RenderableDiagnostic, right: RenderableDiagnostic): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.startLine === right.startLine &&
    left.startCharacter === right.startCharacter &&
    left.serverId === right.serverId &&
    left.code === right.code &&
    left.message === right.message
  );
}

function diagnosticLine(diagnostic: RenderableDiagnostic): string {
  const source = diagnostic.code
    ? `[${diagnostic.serverId}/${diagnostic.code}]`
    : `[${diagnostic.serverId}]`;
  return `LSP| ${diagnostic.relativePath}:${diagnostic.startLine + 1}:${diagnostic.startCharacter + 1} ${source} ${diagnostic.message}`;
}

export function renderLspDiagnostics(input: {
  diagnostics: readonly NormalizedLspDiagnostic[];
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
}): RenderedLspDiagnostics {
  if (!Number.isSafeInteger(input.maxDiagnostics) || input.maxDiagnostics < 1) {
    throw new RangeError("maxDiagnostics must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.maxDiagnosticsBytes) || input.maxDiagnosticsBytes < 1) {
    throw new RangeError("maxDiagnosticsBytes must be a positive integer.");
  }

  const sorted = input.diagnostics
    .filter((diagnostic) => diagnostic.severity === LSP_DIAGNOSTIC_SEVERITY_ERROR)
    .map(normalizeDiagnostic)
    .sort(compareDiagnostic);
  const diagnostics: RenderableDiagnostic[] = [];
  for (const diagnostic of sorted) {
    const previous = diagnostics.at(-1);
    if (!previous || !sameDiagnostic(previous, diagnostic)) {
      diagnostics.push(diagnostic);
    }
  }

  if (diagnostics.length === 0) {
    return { output: "", errors: 0, totalErrors: 0, truncated: false, utf8Bytes: 0 };
  }

  const candidateLines = diagnostics.slice(0, input.maxDiagnostics).map(diagnosticLine);
  for (let count = candidateLines.length; count >= 0; count -= 1) {
    const truncated = count < diagnostics.length;
    const header = `@better-hashline-lsp advisory=true errors=${count} truncated=${truncated}`;
    const output = [header, ...candidateLines.slice(0, count)].join("\n");
    const utf8Bytes = byteLength(output);
    if (utf8Bytes <= input.maxDiagnosticsBytes) {
      return {
        output,
        errors: count,
        totalErrors: diagnostics.length,
        truncated,
        utf8Bytes,
      };
    }
  }

  return {
    output: "",
    errors: 0,
    totalErrors: diagnostics.length,
    truncated: true,
    utf8Bytes: 0,
  };
}

function renderWarningLabel(warning: LspUnavailableWarning): string {
  const code = sanitizeField(warning.code) || "UNKNOWN";
  const serverId = warning.serverId ? sanitizeField(warning.serverId) : "";
  return serverId ? `${code}[${serverId}]` : code;
}

export function renderLspUnavailableWarning(input: {
  warnings: readonly LspUnavailableWarning[];
  reason: LspUnavailableReason;
  maxOutputBytes: number;
}): string {
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive integer.");
  }
  if (input.reason === "manager" && input.warnings.length === 0) return "";

  const labels = [
    ...new Set(input.warnings.map(renderWarningLabel).filter((label) => label.length > 0)),
  ].sort(compareText);
  const detail =
    input.reason === "post-publication-drift"
      ? "diagnostics were suppressed because the target changed again after publication"
      : `diagnostics were incomplete or unavailable${
          labels.length > 0 ? ` (${labels.join(", ")})` : ""
        }`;
  const output = `LSP_DIAGNOSTICS_UNAVAILABLE: The mutation succeeded; ${detail}. Do not retry the mutation. Inspect the file and use hashline_read before further editing.`;
  if (byteLength(output) <= input.maxOutputBytes) return output;

  const boundedDetail =
    input.reason === "post-publication-drift"
      ? "diagnostics were suppressed because the target changed again after publication"
      : "diagnostics were incomplete or unavailable (additional details omitted)";
  const bounded = `LSP_DIAGNOSTICS_UNAVAILABLE: The mutation succeeded; ${boundedDetail}. Do not retry the mutation. Inspect the file and use hashline_read before further editing.`;
  return byteLength(bounded) <= input.maxOutputBytes ? bounded : "";
}
