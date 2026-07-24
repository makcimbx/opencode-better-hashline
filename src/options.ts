import { fail } from "./errors.js";

export const ABSOLUTE_MAX_LOGICAL_LINES = 100_000;

export interface BetterHashlineOptions {
  /** Hide and reject OpenCode's built-in file-writing tools. Defaults to true. */
  enforce?: boolean;
  /** Tool IDs used for editing. Experimental native aliases require enforce: true. */
  toolSurface?: "hashline" | "native-aliases";
  /** Maximum retained bytes for one editable text file. */
  maxFileBytes?: number;
  /** Maximum logical lines in one editable text file. */
  maxLines?: number;
  /** Approximate process memory budget for retained snapshots. */
  maxCacheBytes?: number;
  /** Maximum number of retained snapshots. */
  maxSnapshots?: number;
  /** Maximum retained revisions for one session and canonical path. */
  maxSnapshotsPerPath?: number;
  /** Maximum retained snapshots for one OpenCode session. */
  maxSnapshotsPerSession?: number;
  /** Snapshot lifetime in milliseconds. */
  snapshotTtlMs?: number;
  /** Model-visible output budget for one hashline_read result. */
  maxOutputBytes?: number;
  /** Maximum exact context on each side during unique rebase. */
  maxContextLines?: number;
}

export interface ResolvedOptions {
  enforce: boolean;
  toolSurface: "hashline" | "native-aliases";
  maxFileBytes: number;
  maxLines: number;
  maxCacheBytes: number;
  maxSnapshots: number;
  maxSnapshotsPerPath: number;
  maxSnapshotsPerSession: number;
  snapshotTtlMs: number;
  maxOutputBytes: number;
  maxContextLines: number;
}

const DEFAULTS: ResolvedOptions = {
  enforce: true,
  toolSurface: "hashline",
  maxFileBytes: 8 * 1024 * 1024,
  maxLines: ABSOLUTE_MAX_LOGICAL_LINES,
  maxCacheBytes: 64 * 1024 * 1024,
  maxSnapshots: 64,
  maxSnapshotsPerPath: 4,
  maxSnapshotsPerSession: 32,
  snapshotTtlMs: 30 * 60 * 1000,
  maxOutputBytes: 40 * 1024,
  maxContextLines: 4,
};

function integerOption(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("INVALID_ARGUMENT", `Option ${name} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    fail("INVALID_ARGUMENT", `Option ${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function resolveOptions(input: Record<string, unknown> | undefined): ResolvedOptions {
  const value = input ?? {};
  const knownOptions = new Set<keyof BetterHashlineOptions>([
    "enforce",
    "toolSurface",
    "maxFileBytes",
    "maxLines",
    "maxCacheBytes",
    "maxSnapshots",
    "maxSnapshotsPerPath",
    "maxSnapshotsPerSession",
    "snapshotTtlMs",
    "maxOutputBytes",
    "maxContextLines",
  ]);
  for (const name of Object.keys(value)) {
    if (!knownOptions.has(name as keyof BetterHashlineOptions)) {
      fail("INVALID_ARGUMENT", `Unknown Better Hashline option: ${name}`);
    }
  }
  if (value.enforce !== undefined && typeof value.enforce !== "boolean") {
    fail("INVALID_ARGUMENT", "Option enforce must be a boolean.");
  }
  if (
    value.toolSurface !== undefined &&
    value.toolSurface !== "hashline" &&
    value.toolSurface !== "native-aliases"
  ) {
    fail("INVALID_ARGUMENT", "Option toolSurface must be hashline or native-aliases.");
  }

  const options: ResolvedOptions = {
    enforce: value.enforce ?? DEFAULTS.enforce,
    toolSurface: value.toolSurface ?? DEFAULTS.toolSurface,
    maxFileBytes:
      integerOption(value.maxFileBytes, "maxFileBytes", 1024, 16 * 1024 * 1024) ??
      DEFAULTS.maxFileBytes,
    maxLines:
      integerOption(value.maxLines, "maxLines", 1, ABSOLUTE_MAX_LOGICAL_LINES) ?? DEFAULTS.maxLines,
    maxCacheBytes:
      integerOption(value.maxCacheBytes, "maxCacheBytes", 1024, 1024 * 1024 * 1024) ??
      DEFAULTS.maxCacheBytes,
    maxSnapshots:
      integerOption(value.maxSnapshots, "maxSnapshots", 1, 4096) ?? DEFAULTS.maxSnapshots,
    maxSnapshotsPerPath:
      integerOption(value.maxSnapshotsPerPath, "maxSnapshotsPerPath", 1, 128) ??
      DEFAULTS.maxSnapshotsPerPath,
    maxSnapshotsPerSession:
      integerOption(value.maxSnapshotsPerSession, "maxSnapshotsPerSession", 1, 4096) ??
      DEFAULTS.maxSnapshotsPerSession,
    snapshotTtlMs:
      integerOption(value.snapshotTtlMs, "snapshotTtlMs", 1000, 24 * 60 * 60 * 1000) ??
      DEFAULTS.snapshotTtlMs,
    maxOutputBytes:
      integerOption(value.maxOutputBytes, "maxOutputBytes", 1024, 45 * 1024) ??
      DEFAULTS.maxOutputBytes,
    maxContextLines:
      integerOption(value.maxContextLines, "maxContextLines", 0, 32) ?? DEFAULTS.maxContextLines,
  };

  if (options.maxCacheBytes < options.maxFileBytes * 3) {
    fail("INVALID_ARGUMENT", "Option maxCacheBytes must be at least three times maxFileBytes.");
  }
  if (options.toolSurface === "native-aliases" && !options.enforce) {
    fail("INVALID_ARGUMENT", "Option toolSurface=native-aliases requires enforce=true.");
  }
  if (
    options.maxSnapshotsPerPath > options.maxSnapshots ||
    options.maxSnapshotsPerSession > options.maxSnapshots
  ) {
    fail(
      "INVALID_ARGUMENT",
      "Per-path and per-session snapshot limits cannot exceed maxSnapshots.",
    );
  }
  return options;
}
