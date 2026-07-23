import { createHash, randomBytes } from "node:crypto";

import { fail } from "./errors.js";
import type { ResolvedOptions } from "./options.js";
import { bytesEqual, type TextDocument } from "./text.js";

export interface SnapshotScope {
  sessionId: string;
  worktree: string;
}

export interface IssuedRange {
  start: number;
  end: number;
}

export type SnapshotAuthority = symbol;

export interface Snapshot {
  readonly id: string;
  readonly scope: SnapshotScope;
  readonly authority: SnapshotAuthority | undefined;
  readonly canonicalPath: string;
  readonly digest: string;
  readonly document: TextDocument;
  readonly createdAt: number;
  lastUsedAt: number;
  readonly weight: number;
  issued: IssuedRange[];
  issuedBof: boolean;
  issuedEof: boolean;
  complete: boolean;
  delivered: boolean;
  pins: number;
  invalid: boolean;
}

export interface IssuedPage {
  ranges: readonly IssuedRange[];
  bof: boolean;
  eof: boolean;
}

export interface IssuedCoverageRequirements {
  ranges: readonly IssuedRange[];
  boundaryRanges?: readonly IssuedRange[];
  bof: boolean;
  eof: boolean;
}

export interface MissingIssuedCoverage {
  ranges: readonly IssuedRange[];
  primaryRanges: readonly IssuedRange[];
  boundaryRanges: readonly IssuedRange[];
  bof: boolean;
  eof: boolean;
}

const HASHLINE_READ_MAX_LINES = 1000;
const MAX_DIAGNOSTIC_ITEMS = 12;

type SuggestedRead = {
  offset: number;
  limit: number;
};

function scopeMatches(left: SnapshotScope, right: SnapshotScope): boolean {
  return left.sessionId === right.sessionId && left.worktree === right.worktree;
}

function mergeRanges(ranges: readonly IssuedRange[]): IssuedRange[] {
  const sorted = ranges
    .filter((range) => range.start <= range.end)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: IssuedRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function subtractRanges(
  required: readonly IssuedRange[],
  issued: readonly IssuedRange[],
): IssuedRange[] {
  const missing: IssuedRange[] = [];
  let issuedIndex = 0;
  for (const requirement of required) {
    while (issued[issuedIndex] && (issued[issuedIndex]?.end ?? 0) < requirement.start) {
      issuedIndex += 1;
    }
    let cursor: number | undefined = requirement.start;
    let index = issuedIndex;
    while (cursor !== undefined) {
      const coverage = issued[index];
      if (!coverage || coverage.start > requirement.end) break;
      if (coverage.end < cursor) {
        index += 1;
        continue;
      }
      if (coverage.start > cursor) {
        missing.push({ start: cursor, end: Math.min(requirement.end, coverage.start - 1) });
      }
      if (coverage.end >= requirement.end) {
        cursor = undefined;
        break;
      }
      cursor = Math.max(cursor, coverage.end + 1);
      index += 1;
    }
    if (cursor !== undefined) missing.push({ start: cursor, end: requirement.end });
    issuedIndex = index;
  }
  return missing;
}

export function collectMissingIssuedCoverage(
  snapshot: Snapshot,
  requirements: IssuedCoverageRequirements,
): MissingIssuedCoverage {
  if (typeof requirements.bof !== "boolean" || typeof requirements.eof !== "boolean") {
    fail("INVALID_ARGUMENT", "BOF and EOF coverage requirements must be boolean values.");
  }
  const lineCount = snapshot.document.lines.length;
  const boundaryRanges = requirements.boundaryRanges ?? [];
  for (const range of [...requirements.ranges, ...boundaryRanges]) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start ||
      range.end > lineCount
    ) {
      fail("INVALID_ARGUMENT", `Lines ${range.start}-${range.end} are outside the snapshot.`);
    }
  }
  const issued = mergeRanges(snapshot.issued);
  const primaryRanges = subtractRanges(mergeRanges(requirements.ranges), issued);
  const missingBoundaryRanges = subtractRanges(mergeRanges(boundaryRanges), issued);
  return {
    ranges: mergeRanges([...primaryRanges, ...missingBoundaryRanges]),
    primaryRanges,
    boundaryRanges: missingBoundaryRanges,
    bof: requirements.bof && !snapshot.issuedBof,
    eof: requirements.eof && !snapshot.issuedEof,
  };
}

function formatRange(range: IssuedRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function formatMissingRanges(ranges: readonly IssuedRange[]): string {
  if (ranges.length <= MAX_DIAGNOSTIC_ITEMS) return ranges.map(formatRange).join(", ");
  const head = ranges.slice(0, MAX_DIAGNOSTIC_ITEMS - 1).map(formatRange);
  const omitted = ranges.length - MAX_DIAGNOSTIC_ITEMS;
  const last = ranges.at(-1);
  if (!last) return "";
  return `${head.join(", ")}, ... (+${omitted} more ${omitted === 1 ? "gap" : "gaps"}), ${formatRange(last)}`;
}

function suggestedReads(
  snapshot: Snapshot,
  missing: MissingIssuedCoverage,
): {
  first: SuggestedRead[];
  last: SuggestedRead | undefined;
  total: number;
  sweepStart: number | undefined;
  sweepEnd: number | undefined;
} {
  const targets = [...missing.ranges];
  if (missing.bof) targets.push({ start: 1, end: 1 });
  if (missing.eof) {
    const eofLine = Math.max(1, snapshot.document.lines.length);
    targets.push({ start: eofLine, end: eofLine });
  }

  const mergedTargets = mergeRanges(targets);
  const first: SuggestedRead[] = [];
  let last: SuggestedRead | undefined;
  let total = 0;
  for (const target of mergedTargets) {
    let offset = target.start;
    while (offset <= target.end) {
      const limit = Math.min(HASHLINE_READ_MAX_LINES, target.end - offset + 1);
      const call = { offset, limit };
      if (first.length < MAX_DIAGNOSTIC_ITEMS) first.push(call);
      last = call;
      total += 1;
      offset += limit;
    }
  }
  return {
    first,
    last,
    total,
    sweepStart: mergedTargets[0]?.start,
    sweepEnd: mergedTargets.at(-1)?.end,
  };
}

function formatSuggestedRead(call: SuggestedRead): string {
  return `hashline_read(offset=${call.offset}, limit=${call.limit})`;
}

function formatSuggestedReads(snapshot: Snapshot, missing: MissingIssuedCoverage): string {
  const reads = suggestedReads(snapshot, missing);
  if (reads.total <= MAX_DIAGNOSTIC_ITEMS) {
    return reads.first.map(formatSuggestedRead).join(", ");
  }
  const head = reads.first.slice(0, MAX_DIAGNOSTIC_ITEMS - 1).map(formatSuggestedRead);
  const omitted = reads.total - MAX_DIAGNOSTIC_ITEMS;
  if (reads.last === undefined || reads.sweepStart === undefined || reads.sweepEnd === undefined) {
    return head.join(", ");
  }
  const listed = `${head.join(", ")}, ... (+${omitted} more ${omitted === 1 ? "call" : "calls"}), ${formatSuggestedRead(reads.last)}`;
  const sweepLimit = Math.min(HASHLINE_READ_MAX_LINES, reads.sweepEnd - reads.sweepStart + 1);
  return `${listed}. For omitted calls, use hashline_read(offset=${reads.sweepStart}, limit=${sweepLimit}) and follow @more with limit=1000 until line ${reads.sweepEnd} is issued`;
}

function issuedCoverageError(snapshot: Snapshot, missing: MissingIssuedCoverage): string {
  const parts: string[] = [];
  if (missing.ranges.length > 0) {
    parts.push(`line gaps: ${formatMissingRanges(missing.ranges)}`);
  }
  if (missing.bof) parts.push("BOF boundary");
  if (missing.eof) parts.push("EOF boundary");
  return `Missing issued coverage: ${parts.join("; ")}. Suggested reads: ${formatSuggestedReads(snapshot, missing)}. Only fully rendered N| lines issue coverage; preview-only N!| lines remain unissued. Reuse the old snapshotId only if every suggested read returns that same ID; otherwise replan the full batch from the new snapshot.`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SnapshotStore {
  readonly #snapshots = new Map<string, Snapshot>();
  #weight = 0;

  constructor(
    private readonly options: Pick<
      ResolvedOptions,
      | "maxCacheBytes"
      | "maxSnapshots"
      | "maxSnapshotsPerPath"
      | "maxSnapshotsPerSession"
      | "snapshotTtlMs"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  remember(
    scope: SnapshotScope,
    canonicalPath: string,
    document: TextDocument,
    authority?: SnapshotAuthority,
  ): Snapshot {
    const digest = sha256(document.bytes);
    const timestamp = this.now();
    for (const snapshot of [...this.#snapshots.values()]) {
      if (
        snapshot.invalid ||
        !scopeMatches(snapshot.scope, scope) ||
        snapshot.authority !== authority ||
        snapshot.canonicalPath !== canonicalPath ||
        snapshot.digest !== digest ||
        !bytesEqual(snapshot.document.bytes, document.bytes)
      ) {
        continue;
      }
      if (timestamp - snapshot.lastUsedAt <= this.options.snapshotTtlMs) {
        this.#touch(snapshot);
        return snapshot;
      }
      if (snapshot.pins === 0) this.#remove(snapshot.id);
    }

    const weight =
      document.bytes.byteLength + document.text.length * 2 + document.lines.length * 96;
    if (weight > this.options.maxCacheBytes) {
      fail("UNSUPPORTED_FILE", "The file is larger than the snapshot cache budget.");
    }

    this.#evictScope(
      (snapshot) => scopeMatches(snapshot.scope, scope) && snapshot.canonicalPath === canonicalPath,
      this.options.maxSnapshotsPerPath,
    );
    this.#evictScope(
      (snapshot) => snapshot.scope.sessionId === scope.sessionId,
      this.options.maxSnapshotsPerSession,
    );

    let id: string;
    do {
      id = `s_${randomBytes(16).toString("base64url")}`;
    } while (this.#snapshots.has(id));

    const snapshot: Snapshot = {
      id,
      scope: { ...scope },
      canonicalPath,
      authority,
      digest,
      document,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      weight,
      issued: [],
      issuedBof: false,
      issuedEof: false,
      complete: false,
      delivered: false,
      pins: 0,
      invalid: false,
    };
    this.#snapshots.set(id, snapshot);
    this.#weight += weight;
    this.#evict(snapshot.id);
    if (
      this.#weight > this.options.maxCacheBytes ||
      this.#snapshots.size > this.options.maxSnapshots
    ) {
      this.#remove(snapshot.id);
      fail("UNSUPPORTED_FILE", "The snapshot cache is temporarily full with active edits.");
    }
    return snapshot;
  }

  issue(snapshot: Snapshot, page: IssuedPage): void {
    if (snapshot.invalid || this.#snapshots.get(snapshot.id) !== snapshot) {
      fail(
        "SNAPSHOT_UNKNOWN",
        "The snapshot is no longer usable. Rerun hashline_read in this same session and use only the snapshot ID it returns; old IDs cannot be revived.",
      );
    }
    snapshot.issued = mergeRanges([...snapshot.issued, ...page.ranges]);
    snapshot.issuedBof ||= page.bof;
    snapshot.issuedEof ||= page.eof;
    const lineCount = snapshot.document.lines.length;
    snapshot.complete =
      snapshot.issuedBof &&
      snapshot.issuedEof &&
      (lineCount === 0 ||
        (snapshot.issued.length === 1 &&
          snapshot.issued[0]?.start === 1 &&
          snapshot.issued[0]?.end === lineCount));
    snapshot.delivered = true;
    this.#touch(snapshot);
  }

  assertDelivered(snapshot: Snapshot): void {
    if (snapshot.delivered) return;
    fail(
      "SNAPSHOT_REQUIRED",
      "This snapshot has not received delivered issued evidence. Rerun hashline_read in this same session and use only the snapshot ID it returns; old IDs cannot be revived.",
    );
  }

  assertAuthority(snapshot: Snapshot, authority: SnapshotAuthority): void {
    if (snapshot.authority === authority) return;
    fail(
      "SNAPSHOT_REQUIRED",
      "This snapshot does not belong to the active native-alias process epoch. Rerun hashline_read in this same session and use only the snapshot ID it returns; old IDs cannot be revived.",
    );
  }

  peek(scope: SnapshotScope, id: string): Snapshot {
    return this.#get(scope, id, false);
  }

  pin(scope: SnapshotScope, id: string): Snapshot {
    return this.#get(scope, id, true);
  }

  release(snapshot: Snapshot): void {
    snapshot.pins = Math.max(0, snapshot.pins - 1);
    if (snapshot.invalid && snapshot.pins === 0) this.#remove(snapshot.id);
    else this.#evict();
  }

  assertRangeIssued(snapshot: Snapshot, start: number, end: number): void {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > snapshot.document.lines.length
    ) {
      fail("INVALID_ARGUMENT", `Lines ${start}-${end} are outside the snapshot.`);
    }
    const covered = snapshot.issued.some((range) => range.start <= start && range.end >= end);
    if (!covered) {
      fail(
        "RANGE_NOT_FULLY_ISSUED",
        `Lines ${start}-${end} were not fully issued. Read hashline_read pages covering this exact range, then retry with the same snapshotId.`,
      );
    }
  }

  assertBoundaryIssued(snapshot: Snapshot, position: number): void {
    const lineCount = snapshot.document.lines.length;
    if (position < 0 || position > lineCount) {
      fail("INVALID_ARGUMENT", `Boundary ${position} is outside the snapshot.`);
    }
    if (position === 0 && !snapshot.issuedBof) {
      fail(
        "REF_NOT_ISSUED",
        "The beginning-of-file boundary was not issued. Read hashline_read with offset=1, then retry with the same snapshotId.",
      );
    }
    if (position === lineCount && !snapshot.issuedEof) {
      fail(
        "REF_NOT_ISSUED",
        "The end-of-file boundary was not issued. Read a hashline_read page that reaches @eof, then retry with the same snapshotId.",
      );
    }
    if (position > 0) this.assertRangeIssued(snapshot, position, position);
    if (position < lineCount) {
      this.assertRangeIssued(snapshot, position + 1, position + 1);
    }
  }

  assertIssuedCoverage(snapshot: Snapshot, requirements: IssuedCoverageRequirements): void {
    const missing = collectMissingIssuedCoverage(snapshot, requirements);
    if (missing.ranges.length === 0 && !missing.bof && !missing.eof) return;
    const code =
      missing.primaryRanges.length > 0
        ? "RANGE_NOT_FULLY_ISSUED"
        : missing.bof || missing.eof
          ? "REF_NOT_ISSUED"
          : "RANGE_NOT_FULLY_ISSUED";
    fail(code, issuedCoverageError(snapshot, missing));
  }

  assertComplete(snapshot: Snapshot, operation = "replace_file"): void {
    if (!snapshot.complete) {
      fail(
        "RANGE_NOT_FULLY_ISSUED",
        `${operation} needs a complete snapshot. Read the file from offset=1 through @eof with the same snapshotId, then retry.`,
      );
    }
  }

  invalidatePath(scope: SnapshotScope, canonicalPath: string): void {
    for (const snapshot of [...this.#snapshots.values()]) {
      if (scopeMatches(snapshot.scope, scope) && snapshot.canonicalPath === canonicalPath) {
        snapshot.invalid = true;
        // Active calls retain the object they pinned, but stale IDs must stop
        // occupying cache capacity before a verified successor is remembered.
        this.#remove(snapshot.id);
      }
    }
  }

  invalidateSessionPath(sessionId: string, canonicalPath: string): void {
    for (const snapshot of [...this.#snapshots.values()]) {
      if (snapshot.scope.sessionId === sessionId && snapshot.canonicalPath === canonicalPath) {
        snapshot.invalid = true;
        this.#remove(snapshot.id);
      }
    }
  }

  clear(): void {
    this.#snapshots.clear();
    this.#weight = 0;
  }

  #get(scope: SnapshotScope, id: string, pin: boolean): Snapshot {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot || snapshot.invalid || !scopeMatches(snapshot.scope, scope)) {
      fail(
        "SNAPSHOT_UNKNOWN",
        "Rerun hashline_read in this same session and use only the snapshot ID it returns; old IDs cannot be revived.",
      );
    }
    if (this.now() - snapshot.lastUsedAt > this.options.snapshotTtlMs) {
      if (snapshot.pins === 0) this.#remove(snapshot.id);
      fail(
        "SNAPSHOT_EXPIRED",
        "Rerun hashline_read in this same session and use only the snapshot ID it returns; old IDs cannot be revived.",
      );
    }
    if (pin) snapshot.pins += 1;
    this.#touch(snapshot);
    return snapshot;
  }

  #touch(snapshot: Snapshot): void {
    snapshot.lastUsedAt = this.now();
    this.#snapshots.delete(snapshot.id);
    this.#snapshots.set(snapshot.id, snapshot);
  }

  #evict(protectedId?: string): void {
    while (
      this.#weight > this.options.maxCacheBytes ||
      this.#snapshots.size > this.options.maxSnapshots
    ) {
      const candidate = [...this.#snapshots.values()].find(
        (snapshot) => snapshot.pins === 0 && snapshot.id !== protectedId,
      );
      if (!candidate) return;
      this.#remove(candidate.id);
    }
  }

  #evictScope(predicate: (snapshot: Snapshot) => boolean, limit: number): void {
    const matching = [...this.#snapshots.values()].filter(predicate);
    while (matching.length >= limit) {
      const index = matching.findIndex((snapshot) => snapshot.pins === 0);
      if (index === -1) {
        fail("UNSUPPORTED_FILE", "The snapshot cache is temporarily full with active edits.");
      }
      const [candidate] = matching.splice(index, 1);
      if (candidate) this.#remove(candidate.id);
    }
  }

  #remove(id: string): void {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) return;
    this.#snapshots.delete(id);
    this.#weight -= snapshot.weight;
  }
}
