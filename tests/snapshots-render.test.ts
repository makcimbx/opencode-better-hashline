import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { renderSnapshotPage } from "../src/render.js";
import { SnapshotStore } from "../src/snapshots.js";
import { decodeTextDocument } from "../src/text.js";

const encoder = new TextEncoder();
const scope = { sessionId: "session", worktree: "/worktree" };
const document = (text: string) => decodeTextDocument(encoder.encode(text));

function options(overrides: Partial<ConstructorParameters<typeof SnapshotStore>[0]> = {}) {
  return {
    maxCacheBytes: 1024 * 1024,
    maxSnapshots: 8,
    maxSnapshotsPerPath: 3,
    maxSnapshotsPerSession: 6,
    snapshotTtlMs: 60_000,
    ...overrides,
  };
}

describe("snapshot store", () => {
  test("creates opaque IDs, reuses exact bytes, and tracks issued provenance", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/file.ts", document("a\nb\n"));
    expect(snapshot.id).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
    expect(store.remember(scope, "/worktree/file.ts", document("a\nb\n"))).toBe(snapshot);

    store.issue(snapshot, { ranges: [{ start: 2, end: 2 }], bof: false, eof: true });
    expect(() => store.assertRangeIssued(snapshot, 1, 1)).toThrow("RANGE_NOT_FULLY_ISSUED:");
    expect(() => store.assertBoundaryIssued(snapshot, 0)).toThrow("REF_NOT_ISSUED:");
    store.issue(snapshot, { ranges: [{ start: 1, end: 1 }], bof: true, eof: false });
    expect(snapshot.issued).toEqual([{ start: 1, end: 2 }]);
    expect(snapshot.complete).toBe(true);
    expect(() => store.assertComplete(snapshot)).not.toThrow();
    expect(() => store.assertBoundaryIssued(snapshot, 1)).not.toThrow();
  });

  test("keeps scopes isolated and expires idle snapshots", () => {
    let now = 0;
    const store = new SnapshotStore(options({ snapshotTtlMs: 1000 }), () => now);
    const snapshot = store.remember(scope, "/worktree/file.ts", document("a"));
    expect(() => store.peek({ ...scope, sessionId: "other" }, snapshot.id)).toThrow(
      "SNAPSHOT_UNKNOWN:",
    );
    now = 1001;
    expect(() => store.peek(scope, snapshot.id)).toThrow("SNAPSHOT_EXPIRED:");
    expect(() => store.peek(scope, snapshot.id)).toThrow("SNAPSHOT_UNKNOWN:");
  });

  test("invalidates pinned revisions and admits a successor at the per-path limit", () => {
    const store = new SnapshotStore(options({ maxSnapshotsPerPath: 1 }));
    const first = store.remember(scope, "/worktree/file.ts", document("a"));
    const pinned = store.pin(scope, first.id);
    store.invalidatePath(scope, "/worktree/file.ts");
    expect(pinned.invalid).toBe(true);
    expect(() => store.peek(scope, first.id)).toThrow("SNAPSHOT_UNKNOWN:");
    const successor = store.remember(scope, "/worktree/file.ts", document("b"));
    expect(() => store.peek(scope, successor.id)).not.toThrow();
    store.release(pinned);
    expect(() => store.peek(scope, first.id)).toThrow("SNAPSHOT_UNKNOWN:");
  });

  test("evicts least-recently-used unpinned snapshots", () => {
    let now = 0;
    const store = new SnapshotStore(
      options({ maxSnapshots: 2, maxSnapshotsPerPath: 2, maxSnapshotsPerSession: 2 }),
      () => now,
    );
    const first = store.remember(scope, "/worktree/a", document("a"));
    now += 1;
    const second = store.remember(scope, "/worktree/b", document("b"));
    now += 1;
    store.peek(scope, first.id);
    now += 1;
    store.remember(scope, "/worktree/c", document("c"));
    expect(() => store.peek(scope, second.id)).toThrow("SNAPSHOT_UNKNOWN:");
    expect(() => store.peek(scope, first.id)).not.toThrow();
  });

  test("fails closed when scoped limits contain only pinned snapshots", () => {
    const store = new SnapshotStore(options({ maxSnapshotsPerPath: 1, maxSnapshotsPerSession: 2 }));
    const first = store.remember(scope, "/worktree/file", document("first"));
    store.pin(scope, first.id);
    expect(() => store.remember(scope, "/worktree/file", document("second"))).toThrow(
      "UNSUPPORTED_FILE:",
    );
    store.release(first);
  });

  test("rejects entries that exceed the byte budget and stale issue handles", () => {
    const tiny = new SnapshotStore(options({ maxCacheBytes: 2 }));
    expect(() => tiny.remember(scope, "/worktree/file", document("large"))).toThrow(
      "UNSUPPORTED_FILE:",
    );

    const store = new SnapshotStore(
      options({ maxSnapshots: 1, maxSnapshotsPerPath: 1, maxSnapshotsPerSession: 1 }),
    );
    const evicted = store.remember(scope, "/worktree/first", document("first"));
    store.remember(scope, "/worktree/second", document("second"));
    expect(() => store.issue(evicted, { ranges: [], bof: true, eof: true })).toThrow(
      "SNAPSHOT_UNKNOWN:",
    );
    expect(() => store.assertBoundaryIssued(evicted, -1)).toThrow("INVALID_ARGUMENT:");
    expect(() => store.assertComplete(evicted)).toThrow(
      "RANGE_NOT_FULLY_ISSUED: replace_file needs a complete snapshot. Read the file from offset=1 through @eof with the same snapshotId, then retry.",
    );
    expect(() => store.assertComplete(evicted, "delete_file")).toThrow(
      "RANGE_NOT_FULLY_ISSUED: delete_file needs a complete snapshot. Read the file from offset=1 through @eof with the same snapshotId, then retry.",
    );
    expect(() => store.assertComplete(evicted, "move_file")).toThrow(
      "RANGE_NOT_FULLY_ISSUED: move_file needs a complete snapshot. Read the file from offset=1 through @eof with the same snapshotId, then retry.",
    );
    store.clear();
  });
});

describe("snapshot rendering", () => {
  test("renders paginated editable lines and exact continuation offsets", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/file", document("a\nb\nc"));
    const first = renderSnapshotPage({ snapshot, offset: 1, limit: 2, maxOutputBytes: 4096 });
    expect(first.output).toContain(`@hashline snapshot=${snapshot.id}`);
    expect(first.output).toContain("lines=3 partial=true");
    expect(first.output).toContain("1|a\n2|b\n@more offset=3");
    expect(first.page).toEqual({ ranges: [{ start: 1, end: 2 }], bof: true, eof: false });
    expect(first.nextOffset).toBe(3);

    const second = renderSnapshotPage({ snapshot, offset: 3, limit: 2, maxOutputBytes: 4096 });
    expect(second.output).toContain("3|c\n@eof");
    expect(second.output).toContain("lines=3 partial=true");
    expect(second.page).toEqual({ ranges: [{ start: 3, end: 3 }], bof: false, eof: true });
    expect(second.nextOffset).toBeUndefined();
  });

  test("issues long lines that fit and previews lines that exceed the byte budget", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/file", document("x".repeat(3000)));
    const complete = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 4096,
    });
    expect(complete.output).toContain(`1|${"x".repeat(3000)}`);
    expect(complete.output).not.toContain("partial=true");
    expect(complete.page.ranges).toEqual([{ start: 1, end: 1 }]);

    const exactBudget = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: Buffer.byteLength(complete.output, "utf8"),
    });
    expect(exactBudget.output).toBe(complete.output);

    const displacedSnapshot = store.remember(
      scope,
      "/worktree/displaced",
      document(`${"x".repeat(935)}\n${"y".repeat(100)}`),
    );
    const displaced = renderSnapshotPage({
      snapshot: displacedSnapshot,
      offset: 1,
      limit: 2,
      maxOutputBytes: 1024,
    });
    expect(Buffer.byteLength(displaced.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(displaced.output).toContain("partial=true");
    expect(displaced.output).toContain("1!|");
    expect(displaced.page.ranges).toEqual([]);

    const rendered = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(Buffer.byteLength(rendered.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(rendered.output).toContain("1!|");
    expect(rendered.output).toContain("line not issued");
    expect(rendered.output).toContain("partial=true");
    expect(rendered.page.ranges).toEqual([]);
  });

  test("uses byte budgets for multibyte lines and handles empty/out-of-range pages", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/file", document("😀".repeat(1000)));
    const rendered = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(Buffer.byteLength(rendered.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(rendered.page.ranges).toEqual([]);
    expect(() => new TextEncoder().encode(rendered.output)).not.toThrow();
    for (let index = 0; index < rendered.output.length; index += 1) {
      const code = rendered.output.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(rendered.output.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
        index += 1;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }

    const empty = store.remember(scope, "/worktree/empty", document(""));
    const emptyPage = renderSnapshotPage({
      snapshot: empty,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(emptyPage.output).toContain("lines=0\n@eof");
    expect(emptyPage.page).toEqual({ ranges: [], bof: true, eof: true });

    const pastEnd = renderSnapshotPage({ snapshot, offset: 99, limit: 1, maxOutputBytes: 1024 });
    expect(pastEnd.page).toEqual({ ranges: [], bof: false, eof: true });
    expect(pastEnd.output).toContain("lines=1 partial=true");
  });
});
