import { Buffer } from "node:buffer";
import {
  type LspUnavailableWarning,
  type NormalizedLspDiagnostic,
  renderLspDiagnostics,
  renderLspUnavailableWarning,
} from "./lsp-diagnostics.js";

export type LspAppendixReport = {
  diagnostics: NormalizedLspDiagnostic[];
  warnings: LspUnavailableWarning[];
};

export type HostOutputLimits = {
  maxBytes: number;
  maxLines: number;
};

const HOST_OUTPUT_BYTE_RESERVE = 128;
const HOST_OUTPUT_LINE_RESERVE = 1;

export function outputLineCount(output: string): number {
  return output.length === 0 ? 0 : output.split("\n").length;
}

function renderBoundedLspAppendix(input: {
  report: LspAppendixReport;
  drift: boolean;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
  maxOutputBytes: number;
  maxOutputLines: number;
}): string {
  let remainingBytes = Math.min(input.maxDiagnosticsBytes, input.maxOutputBytes);
  let remainingLines = input.maxOutputLines;
  if (remainingBytes < 1 || remainingLines < 1) return "";
  const segments: string[] = [];
  const append = (render: (budget: number, lines: number) => string): void => {
    const separatorBytes = segments.length === 0 ? 0 : 1;
    const budget = remainingBytes - separatorBytes;
    if (budget < 1 || remainingLines < 1) return;
    let segment: string;
    try {
      segment = render(budget, remainingLines);
    } catch {
      return;
    }
    if (!segment) return;
    const bytes = Buffer.byteLength(segment, "utf8");
    const lines = outputLineCount(segment);
    if (bytes > budget || lines > remainingLines) return;
    segments.push(segment);
    remainingBytes -= separatorBytes + bytes;
    remainingLines -= lines;
  };

  if (input.drift) {
    append((budget) =>
      renderLspUnavailableWarning({
        warnings: [],
        reason: "post-publication-drift",
        maxOutputBytes: budget,
      }),
    );
  }
  if (input.report.warnings.length > 0) {
    append((budget) =>
      renderLspUnavailableWarning({
        warnings: input.report.warnings,
        reason: "manager",
        maxOutputBytes: budget,
      }),
    );
  }
  if (!input.drift) {
    append(
      (budget, lines) =>
        renderLspDiagnostics({
          diagnostics: input.report.diagnostics,
          maxDiagnostics: Math.min(input.maxDiagnostics, Math.max(0, lines - 1)),
          maxDiagnosticsBytes: budget,
        }).output,
    );
  }
  return segments.join("\n");
}

function safeHostOutputLimits(
  host: HostOutputLimits,
  maxOutputBytes: number,
  maxDiagnosticsBytes: number,
): HostOutputLimits {
  return {
    maxBytes: Math.max(
      0,
      Math.min(host.maxBytes - HOST_OUTPUT_BYTE_RESERVE, maxOutputBytes + maxDiagnosticsBytes),
    ),
    maxLines: Math.max(0, host.maxLines - HOST_OUTPUT_LINE_RESERVE),
  };
}

function hasMandatoryLspWarning(report: LspAppendixReport, drift: boolean): boolean {
  return drift || report.warnings.length > 0;
}

function mandatoryLspWarning(input: {
  report: LspAppendixReport;
  drift: boolean;
  maxDiagnosticsBytes: number;
  safeLimits: HostOutputLimits;
}): string {
  return renderBoundedLspAppendix({
    report: { diagnostics: [], warnings: input.report.warnings },
    drift: input.drift,
    maxDiagnostics: 1,
    maxDiagnosticsBytes: input.maxDiagnosticsBytes,
    maxOutputBytes: input.safeLimits.maxBytes,
    maxOutputLines: input.safeLimits.maxLines,
  });
}

function fitUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 3) return ".".repeat(Math.max(0, maxBytes));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 3) low = middle;
    else high = middle - 1;
  }
  while (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? "")) low -= 1;
  return `${value.slice(0, low)}...`;
}

function fitLegacyOutput(value: string, maxBytes: number, maxLines: number): string {
  if (maxBytes < 1 || maxLines < 1) return "";
  const lines = value.split("\n");
  const limited = lines.slice(0, maxLines);
  if (limited.length < lines.length && limited.length > 0) {
    limited[limited.length - 1] = "...";
  }
  let output = limited.join("\n");
  if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
  if (limited.length > 1) {
    const suffix = `\n${limited[limited.length - 1]}`;
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    if (suffixBytes < maxBytes) {
      return `${fitUtf8Prefix(limited.slice(0, -1).join("\n"), maxBytes - suffixBytes)}${suffix}`;
    }
  }
  output = fitUtf8Prefix(output, maxBytes);
  return output;
}

export function lspLegacyLimits(input: {
  report: LspAppendixReport;
  drift: boolean;
  host: HostOutputLimits;
  maxOutputBytes: number;
  maxDiagnosticsBytes: number;
}): HostOutputLimits {
  const safeLimits = safeHostOutputLimits(
    input.host,
    input.maxOutputBytes,
    input.maxDiagnosticsBytes,
  );
  const mandatory = hasMandatoryLspWarning(input.report, input.drift);
  if (!mandatory && input.report.diagnostics.length === 0) {
    return { maxBytes: input.maxOutputBytes, maxLines: Number.POSITIVE_INFINITY };
  }
  if (!mandatory) {
    return {
      maxBytes: Math.min(input.maxOutputBytes, safeLimits.maxBytes),
      maxLines: safeLimits.maxLines,
    };
  }
  const warning = mandatoryLspWarning({
    report: input.report,
    drift: input.drift,
    maxDiagnosticsBytes: input.maxDiagnosticsBytes,
    safeLimits,
  });
  return {
    maxBytes: Math.max(
      0,
      Math.min(input.maxOutputBytes, safeLimits.maxBytes - Buffer.byteLength(warning, "utf8") - 1),
    ),
    maxLines: Math.max(0, safeLimits.maxLines - outputLineCount(warning)),
  };
}

function lspAppendixForLegacy(input: {
  legacyOutput: string;
  report: LspAppendixReport;
  drift: boolean;
  host: HostOutputLimits;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
  maxOutputBytes: number;
}): string {
  const safeLimits = safeHostOutputLimits(
    input.host,
    input.maxOutputBytes,
    input.maxDiagnosticsBytes,
  );
  const separatorBytes = input.legacyOutput.length === 0 ? 0 : 1;
  const remainingBytes =
    safeLimits.maxBytes - Buffer.byteLength(input.legacyOutput, "utf8") - separatorBytes;
  const remainingLines = safeLimits.maxLines - outputLineCount(input.legacyOutput);
  if (remainingBytes < 1 || remainingLines < 1) return "";
  return renderBoundedLspAppendix({
    report: input.report,
    drift: input.drift,
    maxDiagnostics: input.maxDiagnostics,
    maxDiagnosticsBytes: input.maxDiagnosticsBytes,
    maxOutputBytes: remainingBytes,
    maxOutputLines: remainingLines,
  });
}

export function buildLspOutput(input: {
  legacyOutput: string;
  report: LspAppendixReport;
  drift: boolean;
  host: HostOutputLimits;
  maxDiagnostics: number;
  maxDiagnosticsBytes: number;
  maxOutputBytes: number;
}): string {
  if (!input.drift && input.report.warnings.length === 0 && input.report.diagnostics.length === 0) {
    return input.legacyOutput;
  }
  const limits = lspLegacyLimits(input);
  const legacyOutput = hasMandatoryLspWarning(input.report, input.drift)
    ? fitLegacyOutput(input.legacyOutput, limits.maxBytes, limits.maxLines)
    : input.legacyOutput;
  const appendix = lspAppendixForLegacy({ ...input, legacyOutput });
  if (!appendix) return legacyOutput;
  return legacyOutput.length === 0 ? appendix : `${legacyOutput}\n${appendix}`;
}
