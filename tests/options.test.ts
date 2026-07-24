import { describe, expect, test } from "bun:test";
import { resolveOptions } from "../src/options.js";

function lspServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: ["ts", ".tsx"],
    ...overrides,
  };
}

describe("plugin options", () => {
  test("enables diagnostics by default and accepts explicit boolean modes", () => {
    const defaults = {
      servers: [],
      startupTimeoutMs: 15_000,
      diagnosticsTimeoutMs: 5_000,
      maxDiagnostics: 20,
      maxDiagnosticsBytes: 8 * 1024,
    };
    expect(resolveOptions(undefined)).toEqual({
      enforce: true,
      toolSurface: "hashline",
      maxFileBytes: 8 * 1024 * 1024,
      maxLines: 100_000,
      maxCacheBytes: 64 * 1024 * 1024,
      maxSnapshots: 64,
      maxSnapshotsPerPath: 4,
      maxSnapshotsPerSession: 32,
      snapshotTtlMs: 30 * 60 * 1000,
      maxOutputBytes: 40 * 1024,
      maxContextLines: 4,
      lspDiagnostics: defaults,
    });
    expect(resolveOptions({ lspDiagnostics: true }).lspDiagnostics).toEqual(defaults);
    expect(resolveOptions({ lspDiagnostics: {} }).lspDiagnostics).toEqual(defaults);
    expect(resolveOptions({ lspDiagnostics: { servers: [] } }).lspDiagnostics).toEqual(defaults);
    expect(resolveOptions({ lspDiagnostics: false }).lspDiagnostics).toBe(false);
  });

  test("accepts bounded overrides", () => {
    expect(
      resolveOptions({
        enforce: false,
        toolSurface: "hashline",
        maxFileBytes: 1024,
        maxLines: 10,
        maxCacheBytes: 3072,
        maxSnapshots: 2,
        maxSnapshotsPerPath: 1,
        maxSnapshotsPerSession: 2,
        snapshotTtlMs: 1000,
        maxOutputBytes: 1024,
        maxContextLines: 0,
      }),
    ).toMatchObject({ enforce: false, maxFileBytes: 1024, maxContextLines: 0 });
  });

  test("normalizes explicit LSP servers and fills bounded defaults", () => {
    const result = resolveOptions({
      lspDiagnostics: {
        servers: [
          lspServer({
            id: "zeta",
            extensions: ["TS", ".tsx", "TS"],
            rootMarkers: ["packages\\app\\tsconfig.json", "package.json"],
            env: { ZED: "last", ALPHA: "first" },
            initialization: { zed: true, alpha: { enabled: true } },
          }),
          lspServer({ id: "alpha", command: ["server"], extensions: ["js"] }),
        ],
      },
    });

    expect(result.lspDiagnostics).toEqual({
      servers: [
        {
          id: "alpha",
          command: ["server"],
          extensions: [".js"],
          rootMarkers: [],
          env: {},
          initialization: {},
        },
        {
          id: "zeta",
          command: ["typescript-language-server", "--stdio"],
          extensions: process.platform === "win32" ? [".ts", ".tsx"] : [".TS", ".tsx"],
          rootMarkers: ["package.json", "packages/app/tsconfig.json"],
          env: { ALPHA: "first", ZED: "last" },
          initialization: { alpha: { enabled: true }, zed: true },
        },
      ],
      startupTimeoutMs: 15_000,
      diagnosticsTimeoutMs: 5_000,
      maxDiagnostics: 20,
      maxDiagnosticsBytes: 8 * 1024,
    });
  });

  test("accepts exact LSP scalar bounds", () => {
    const minimum = resolveOptions({
      lspDiagnostics: {
        servers: [lspServer()],
        startupTimeoutMs: 1_000,
        diagnosticsTimeoutMs: 250,
        maxDiagnostics: 1,
        maxDiagnosticsBytes: 1024,
      },
    });
    expect(minimum.lspDiagnostics).toMatchObject({
      startupTimeoutMs: 1_000,
      diagnosticsTimeoutMs: 250,
      maxDiagnostics: 1,
      maxDiagnosticsBytes: 1024,
    });

    const maximum = resolveOptions({
      lspDiagnostics: {
        servers: [lspServer()],
        startupTimeoutMs: 60_000,
        diagnosticsTimeoutMs: 30_000,
        maxDiagnostics: 100,
        maxDiagnosticsBytes: 16 * 1024,
      },
    });
    expect(maximum.lspDiagnostics).toMatchObject({
      startupTimeoutMs: 60_000,
      diagnosticsTimeoutMs: 30_000,
      maxDiagnostics: 100,
      maxDiagnosticsBytes: 16 * 1024,
    });
  });

  test("rejects unknown and malformed LSP fields", () => {
    expect(() => resolveOptions({ lspDiagnostics: "yes" })).toThrow(
      "lspDiagnostics must be an object",
    );
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer()], extra: true } }),
    ).toThrow("Unknown lspDiagnostics field");
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer({ extra: true })] } }),
    ).toThrow("Unknown lspDiagnostics.servers[0] field");
    expect(() =>
      resolveOptions({
        lspDiagnostics: {
          servers: [lspServer(), lspServer({ command: ["other"] })],
        },
      }),
    ).toThrow("duplicate server ID");
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer({ id: "not valid" })] } }),
    ).toThrow("ASCII identifier");
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer({ command: [] })] } }),
    ).toThrow("command must contain");
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer({ extensions: ["../ts"] })] } }),
    ).toThrow("valid file extension");
    expect(() =>
      resolveOptions({
        lspDiagnostics: { servers: [lspServer({ extensions: ["x".repeat(64)] })] },
      }),
    ).toThrow("valid file extension");
    expect(() =>
      resolveOptions({
        lspDiagnostics: { servers: [lspServer({ rootMarkers: ["../package.json"] })] },
      }),
    ).toThrow("traversal-free");
    expect(() =>
      resolveOptions({ lspDiagnostics: { servers: [lspServer({ env: { PORT: 123 } })] } }),
    ).toThrow("env.PORT must be a string");
    expect(() =>
      resolveOptions({
        lspDiagnostics: {
          servers: [lspServer({ initialization: { invalid: undefined } })],
        },
      }),
    ).toThrow("only JSON values");
  });

  test("rejects accessor, non-enumerable, symbol, sparse, and custom-array properties", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "servers", { enumerable: true, get: () => [] });
    expect(() => resolveOptions({ lspDiagnostics: accessor })).toThrow(
      "own enumerable data properties",
    );

    const hidden = { lspDiagnostics: true };
    Object.defineProperty(hidden, "surprise", { enumerable: false, value: true });
    expect(() => resolveOptions(hidden)).toThrow("own enumerable data properties");

    const symbol = Symbol("surprise");
    const initialization = { valid: true, [symbol]: true };
    expect(() =>
      resolveOptions({
        lspDiagnostics: { servers: [lspServer({ initialization })] },
      }),
    ).toThrow("symbol properties");

    const sparse = Array<ReturnType<typeof lspServer>>(3);
    sparse[0] = lspServer();
    sparse[2] = lspServer({ id: "other" });
    expect(() => resolveOptions({ lspDiagnostics: { servers: sparse } })).toThrow("sparse arrays");

    const command = ["server"] as string[] & { custom?: string };
    command.custom = "surprise";
    expect(() => resolveOptions({ lspDiagnostics: { servers: [lspServer({ command })] } })).toThrow(
      "custom or symbol properties",
    );
  });

  test("rejects case-folded environment duplicates on Windows", () => {
    const resolveDuplicate = () =>
      resolveOptions({
        lspDiagnostics: { servers: [lspServer({ env: { Path: "first", PATH: "second" } })] },
      });
    if (process.platform === "win32") expect(resolveDuplicate).toThrow("duplicate environment");
    else expect(resolveDuplicate().lspDiagnostics).not.toBe(false);
  });

  test("rejects values outside LSP scalar and deep byte bounds", () => {
    for (const override of [
      { startupTimeoutMs: 999 },
      { startupTimeoutMs: 60_001 },
      { diagnosticsTimeoutMs: 249 },
      { diagnosticsTimeoutMs: 30_001 },
      { maxDiagnostics: 0 },
      { maxDiagnostics: 101 },
      { maxDiagnosticsBytes: 1023 },
      { maxDiagnosticsBytes: 16 * 1024 + 1 },
    ]) {
      expect(() =>
        resolveOptions({ lspDiagnostics: { servers: [lspServer()], ...override } }),
      ).toThrow("must be between");
    }

    expect(() =>
      resolveOptions({
        lspDiagnostics: {
          servers: [lspServer({ initialization: { payload: "x".repeat(256 * 1024) } })],
        },
      }),
    ).toThrow("initialization must serialize");
    expect(() =>
      resolveOptions({
        lspDiagnostics: {
          servers: [lspServer({ env: { VALUE: "x".repeat(64 * 1024) } })],
        },
      }),
    ).toThrow("env must serialize");
  });

  test("rejects misspelled, mistyped, and inconsistent options", () => {
    expect(() => resolveOptions({ unknown: true })).toThrow("Unknown Better Hashline option");
    expect(() => resolveOptions({ enforce: "yes" })).toThrow("enforce must be a boolean");
    expect(() => resolveOptions({ toolSurface: "native" })).toThrow(
      "toolSurface must be hashline or native-aliases",
    );
    expect(() => resolveOptions({ enforce: false, toolSurface: "native-aliases" })).toThrow(
      "requires enforce=true",
    );
    expect(() => resolveOptions({ maxFileBytes: 1.5 })).toThrow("must be an integer");
    expect(() => resolveOptions({ maxFileBytes: 1 })).toThrow("must be between");
    expect(() => resolveOptions({ maxFileBytes: 2048, maxCacheBytes: 4096 })).toThrow(
      "at least three times",
    );
    expect(() =>
      resolveOptions({ maxSnapshots: 1, maxSnapshotsPerPath: 2, maxSnapshotsPerSession: 1 }),
    ).toThrow("cannot exceed maxSnapshots");
  });
});
