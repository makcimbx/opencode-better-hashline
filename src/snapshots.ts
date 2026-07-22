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

export interface Snapshot {
  readonly id: string;
  readonly scope: SnapshotScope;
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
  pins: number;
  invalid: boolean;
}

export interface IssuedPage {
  ranges: readonly IssuedRange[];
  bof: boolean;
  eof: boolean;
}

function scopeMatches(left: SnapshotScope, right: SnapshotScope): boolean {
  return left.sessionId === right.sessionId && left.worktree === right.worktree;
}

function mergeRanges(ranges: readonly IssuedRange[]): IssuedRange[] {
  const sorted = ranges
    .filter((range) => range.start <= range.end)
    .toSorted((left, right) => left.start - right.start);
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

  remember(scope: SnapshotScope, canonicalPath: string, document: TextDocument): Snapshot {
    const digest = sha256(document.bytes);
    const existing = [...this.#snapshots.values()].find(
      (snapshot) =>
        !snapshot.invalid &&
        scopeMatches(snapshot.scope, scope) &&
        snapshot.canonicalPath === canonicalPath &&
        snapshot.digest === digest &&
        bytesEqual(snapshot.document.bytes, document.bytes),
    );
    if (existing) {
      this.#touch(existing);
      return existing;
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

    const timestamp = this.now();
    const snapshot: Snapshot = {
      id,
      scope: { ...scope },
      canonicalPath,
      digest,
      document,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      weight,
      issued: [],
      issuedBof: false,
      issuedEof: false,
      complete: false,
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
      fail("SNAPSHOT_UNKNOWN", "The snapshot is no longer usable.");
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
    this.#touch(snapshot);
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

  clear(): void {
    this.#snapshots.clear();
    this.#weight = 0;
  }

  #get(scope: SnapshotScope, id: string, pin: boolean): Snapshot {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot || snapshot.invalid || !scopeMatches(snapshot.scope, scope)) {
      fail("SNAPSHOT_UNKNOWN", "Reread the file with hashline_read.");
    }
    if (this.now() - snapshot.lastUsedAt > this.options.snapshotTtlMs) {
      if (snapshot.pins === 0) this.#remove(snapshot.id);
      fail("SNAPSHOT_EXPIRED", "Reread the file with hashline_read.");
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
