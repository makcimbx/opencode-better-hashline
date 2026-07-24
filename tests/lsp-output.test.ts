import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { NormalizedLspDiagnostic } from "../src/lsp-diagnostics.js";
import {
  buildLspOutput,
  type LspAppendixReport,
  lspLegacyLimits,
  outputLineCount,
} from "../src/lsp-output.js";

const legacyReadback = [
  "Applied 1 operation.",
  "@hashline-edit previous=consumed successor=attached",
  "@hashline snapshot=s_AAAAAAAAAAAAAAAAAAAAAA sha256=0123456789ab lines=2 coverage=complete",
  "1|const alpha = 1;",
  "2|const beta = 2;",
  "@eof",
].join("\n");

function diagnostic(message = "Deterministic type error."): NormalizedLspDiagnostic {
  return {
    relativePath: "src/example.ts",
    startLine: 1,
    startCharacter: 2,
    severity: 1,
    serverId: "fixture-lsp",
    code: "E_FIXTURE",
    message,
  };
}

function composition(report: LspAppendixReport, overrides: Record<string, unknown> = {}) {
  return {
    report,
    drift: false,
    host: { maxBytes: 4096, maxLines: 100 },
    maxDiagnostics: 20,
    maxDiagnosticsBytes: 1024,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

describe("managed LSP production output composition", () => {
  test("keeps clean legacy output byte-identical", () => {
    const input = composition({ diagnostics: [], warnings: [] });

    expect(lspLegacyLimits(input)).toEqual({
      maxBytes: 1024,
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(buildLspOutput({ ...input, legacyOutput: legacyReadback })).toBe(legacyReadback);
  });

  test("appends an error without changing legacy readback", () => {
    const input = composition({ diagnostics: [diagnostic()], warnings: [] });
    const appendix = [
      "@better-hashline-lsp advisory=true errors=1 truncated=false",
      "LSP| src/example.ts:2:3 [fixture-lsp/E_FIXTURE] Deterministic type error.",
    ].join("\n");

    expect(buildLspOutput({ ...input, legacyOutput: legacyReadback })).toBe(
      `${legacyReadback}\n${appendix}`,
    );
  });

  test("uses exact byte headroom and truncates diagnostics before legacy output", () => {
    const input = composition(
      {
        diagnostics: [
          diagnostic(`First cafe\u0301 ${"a".repeat(120)}`),
          diagnostic(`Second ${"b".repeat(120)}`),
        ],
        warnings: [],
      },
      { host: { maxBytes: 1400, maxLines: 100 } },
    );
    const legacyOutput = "x".repeat(1024);
    const output = buildLspOutput({ ...input, legacyOutput });

    expect(output.startsWith(`${legacyOutput}\n`)).toBeTrue();
    expect(output).toContain("truncated=true");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(1272);
    expect(lspLegacyLimits(input).maxBytes).toBe(1024);
  });

  test("uses exact line headroom and keeps legacy readback ahead of diagnostics", () => {
    const input = composition(
      { diagnostics: [diagnostic()], warnings: [] },
      { host: { maxBytes: 4096, maxLines: 8 } },
    );
    const sevenLineReadback = `${legacyReadback}\n@note retained readback`;

    expect(outputLineCount(sevenLineReadback)).toBe(7);
    expect(lspLegacyLimits(input)).toEqual({ maxBytes: 1024, maxLines: 7 });
    expect(buildLspOutput({ ...input, legacyOutput: sevenLineReadback })).toBe(sevenLineReadback);
  });

  test("reserves mandatory warning headroom by reducing legacy output", () => {
    const input = composition(
      {
        diagnostics: [],
        warnings: [{ code: "DIAGNOSTICS_TIMEOUT", serverId: "fixture-lsp" }],
      },
      { host: { maxBytes: 900, maxLines: 100 } },
    );
    const output = buildLspOutput({ ...input, legacyOutput: "x".repeat(1024) });

    expect(output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE:");
    expect(output).toContain("The mutation succeeded");
    expect(output).toContain("Do not retry the mutation");
    expect(output.startsWith("x")).toBeTrue();
    expect(output.startsWith(`${"x".repeat(1024)}\n`)).toBeFalse();
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(772);
    expect(outputLineCount(output)).toBeLessThanOrEqual(99);
  });

  test("does not add a separator line when only a mandatory warning fits", () => {
    const report: LspAppendixReport = {
      diagnostics: [],
      warnings: [{ code: "CLIENT_UNAVAILABLE", serverId: "fixture-lsp" }],
    };
    const warningOnly = buildLspOutput({
      ...composition(report, { host: { maxBytes: 4096, maxLines: 2 } }),
      legacyOutput: "",
    });
    const warningBytes = Buffer.byteLength(warningOnly, "utf8");
    const input = composition(report, {
      host: { maxBytes: warningBytes + 128, maxLines: 2 },
    });
    const output = buildLspOutput({ ...input, legacyOutput: legacyReadback });

    expect(output).toBe(warningOnly);
    expect(output.startsWith("\n")).toBeFalse();
    expect(Buffer.byteLength(output, "utf8")).toBe(input.host.maxBytes - 128);
    expect(outputLineCount(output)).toBe(input.host.maxLines - 1);
  });

  test("renders drift recovery instead of stale diagnostics", () => {
    const input = composition(
      { diagnostics: [diagnostic("Stale after drift.")], warnings: [] },
      { drift: true },
    );
    const output = buildLspOutput({ ...input, legacyOutput: legacyReadback });

    expect(output).toContain("LSP_DIAGNOSTICS_UNAVAILABLE:");
    expect(output).toContain("target changed again after publication");
    expect(output).not.toContain("@better-hashline-lsp advisory=true");
    expect(output).not.toContain("Stale after drift.");
  });

  test("returns no output when the host envelope cannot fit mandatory recovery", () => {
    const input = composition(
      {
        diagnostics: [],
        warnings: [{ code: "CLIENT_UNAVAILABLE", serverId: "fixture-lsp" }],
      },
      { host: { maxBytes: 128, maxLines: 1 } },
    );

    expect(lspLegacyLimits(input)).toEqual({ maxBytes: 0, maxLines: 0 });
    expect(buildLspOutput({ ...input, legacyOutput: legacyReadback })).toBe("");
  });
});
