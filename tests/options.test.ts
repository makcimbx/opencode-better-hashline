import { describe, expect, test } from "bun:test";
import { resolveOptions } from "../src/options.js";

describe("plugin options", () => {
  test("uses conservative defaults", () => {
    expect(resolveOptions(undefined)).toEqual({
      enforce: true,
      maxFileBytes: 8 * 1024 * 1024,
      maxLines: 100_000,
      maxCacheBytes: 64 * 1024 * 1024,
      maxSnapshots: 64,
      maxSnapshotsPerPath: 4,
      maxSnapshotsPerSession: 32,
      snapshotTtlMs: 30 * 60 * 1000,
      maxOutputBytes: 40 * 1024,
      maxContextLines: 4,
    });
  });

  test("accepts bounded overrides", () => {
    expect(
      resolveOptions({
        enforce: false,
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

  test("rejects misspelled, mistyped, and inconsistent options", () => {
    expect(() => resolveOptions({ unknown: true })).toThrow("Unknown Better Hashline option");
    expect(() => resolveOptions({ enforce: "yes" })).toThrow("enforce must be a boolean");
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
