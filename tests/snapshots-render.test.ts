import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { renderSnapshotPage } from "../src/render.js";
import { NativeAliasSessionRegistry } from "../src/session-protocol.js";
import { collectMissingIssuedCoverage, SnapshotStore } from "../src/snapshots.js";
import { decodeTextDocument } from "../src/text.js";

const encoder = new TextEncoder();
const scope = { sessionId: "session", worktree: "/worktree" };
const document = (text: string) => decodeTextDocument(encoder.encode(text));

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the function to throw.");
}

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

  test("separates process-local snapshot authorities without changing default deduplication", () => {
    const store = new SnapshotStore(options());
    const firstAuthority = Symbol("first");
    const secondAuthority = Symbol("second");
    const first = store.remember(scope, "/worktree/authority", document("same"), firstAuthority);
    expect(store.remember(scope, "/worktree/authority", document("same"), firstAuthority)).toBe(
      first,
    );
    const second = store.remember(scope, "/worktree/authority", document("same"), secondAuthority);
    expect(second).not.toBe(first);
    expect(second.id).not.toBe(first.id);
    expect(() => store.assertAuthority(first, firstAuthority)).not.toThrow();
    expect(() => store.assertAuthority(first, secondAuthority)).toThrow("SNAPSHOT_REQUIRED:");

    const defaultSnapshot = store.remember(scope, "/worktree/default", document("same"));
    expect(store.remember(scope, "/worktree/default", document("same"))).toBe(defaultSnapshot);
  });

  test("does not revive retained authority after registry eviction and reattestation", () => {
    const store = new SnapshotStore(options());
    const registry = new NativeAliasSessionRegistry(1);
    const firstCandidate = registry.prepare("session", "fingerprint", "/worktree");
    expect(registry.commit(firstCandidate)).toBeTrue();
    const retained = store.remember(
      scope,
      "/worktree/retained",
      document("same"),
      firstCandidate.authority,
    );
    store.issue(retained, { ranges: [{ start: 1, end: 1 }], bof: true, eof: true });

    const evictionCandidate = registry.prepare("other", "fingerprint", "/worktree");
    expect(registry.commit(evictionCandidate)).toBeTrue();
    expect(
      registry.isActive("session", "fingerprint", "/worktree", firstCandidate.authority),
    ).toBeFalse();

    const replacementCandidate = registry.prepare("session", "fingerprint", "/worktree");
    expect(registry.commit(replacementCandidate)).toBeTrue();
    expect(replacementCandidate.authority).not.toBe(firstCandidate.authority);
    expect(store.peek(scope, retained.id)).toBe(retained);
    expect(() => store.assertAuthority(retained, replacementCandidate.authority)).toThrow(
      "SNAPSHOT_REQUIRED:",
    );
    const replacement = store.remember(
      scope,
      "/worktree/retained",
      document("same"),
      replacementCandidate.authority,
    );
    expect(replacement.id).not.toBe(retained.id);
  });

  test("aggregates all missing ranges and edges independently of requirement order", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(
      scope,
      "/worktree/aggregate",
      document(Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n")),
    );
    store.issue(snapshot, {
      ranges: [
        { start: 2, end: 3 },
        { start: 7, end: 8 },
      ],
      bof: true,
      eof: false,
    });
    const requirements = {
      ranges: [
        { start: 7, end: 10 },
        { start: 1, end: 5 },
      ],
      bof: true,
      eof: true,
    };

    expect(collectMissingIssuedCoverage(snapshot, requirements)).toEqual({
      ranges: [
        { start: 1, end: 1 },
        { start: 4, end: 5 },
        { start: 9, end: 10 },
      ],
      primaryRanges: [
        { start: 1, end: 1 },
        { start: 4, end: 5 },
        { start: 9, end: 10 },
      ],
      boundaryRanges: [],
      bof: false,
      eof: true,
    });
    const first = thrownMessage(() => store.assertIssuedCoverage(snapshot, requirements));
    const second = thrownMessage(() =>
      store.assertIssuedCoverage(snapshot, {
        ...requirements,
        ranges: [...requirements.ranges].reverse(),
      }),
    );
    expect(second).toBe(first);
    expect(first).toContain(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 1, 4-5, 9-10; EOF boundary.",
    );
    expect(first).toContain("hashline_read(offset=1, limit=1)");
    expect(first).toContain("hashline_read(offset=4, limit=2)");
    expect(first).toContain("hashline_read(offset=9, limit=2)");
    expect(first).toContain("hashline_read(offset=12, limit=1)");
    expect(first).toContain(
      "Reuse the old snapshotId only if every suggested read returns that same ID; otherwise replan the full batch from the new snapshot.",
    );
    expect(snapshot.issued).toEqual([
      { start: 2, end: 3 },
      { start: 7, end: 8 },
    ]);
  });

  test("preserves boundary error precedence while retaining every missing range", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(
      scope,
      "/worktree/boundary-precedence",
      document("one\ntwo\nthree\nfour\nfive\nsix\n"),
    );
    store.issue(snapshot, { ranges: [{ start: 1, end: 1 }], bof: true, eof: false });

    const edgeRequirements = {
      ranges: [{ start: 1, end: 1 }],
      boundaryRanges: [{ start: 6, end: 6 }],
      bof: false,
      eof: true,
    };
    expect(collectMissingIssuedCoverage(snapshot, edgeRequirements)).toEqual({
      ranges: [{ start: 6, end: 6 }],
      primaryRanges: [],
      boundaryRanges: [{ start: 6, end: 6 }],
      bof: false,
      eof: true,
    });
    expect(thrownMessage(() => store.assertIssuedCoverage(snapshot, edgeRequirements))).toContain(
      "REF_NOT_ISSUED: Missing issued coverage: line gaps: 6; EOF boundary.",
    );

    const internalNeighbor = {
      ranges: [{ start: 1, end: 1 }],
      boundaryRanges: [{ start: 5, end: 5 }],
      bof: false,
      eof: false,
    };
    expect(thrownMessage(() => store.assertIssuedCoverage(snapshot, internalNeighbor))).toContain(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 5.",
    );

    const missingPrimaryAtEdge = {
      ranges: [{ start: 2, end: 2 }],
      boundaryRanges: [{ start: 6, end: 6 }],
      bof: false,
      eof: true,
    };
    expect(
      thrownMessage(() => store.assertIssuedCoverage(snapshot, missingPrimaryAtEdge)),
    ).toContain("RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 2, 6; EOF boundary.");
  });

  test("chunks long gaps and bounds sparse-gap diagnostics", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(
      scope,
      "/worktree/long",
      document(Array.from({ length: 2505 }, (_, index) => `line-${index + 1}`).join("\n")),
    );
    const longGap = thrownMessage(() =>
      store.assertIssuedCoverage(snapshot, {
        ranges: [{ start: 1, end: 2505 }],
        bof: true,
        eof: true,
      }),
    );
    expect(longGap).toContain("line gaps: 1-2505; BOF boundary; EOF boundary");
    expect(longGap).toContain("hashline_read(offset=1, limit=1000)");
    expect(longGap).toContain("hashline_read(offset=1001, limit=1000)");
    expect(longGap).toContain("hashline_read(offset=2001, limit=505)");

    const sparseRanges = Array.from({ length: 30 }, (_, index) => ({
      start: index * 2 + 1,
      end: index * 2 + 1,
    }));
    const sparse = thrownMessage(() =>
      store.assertIssuedCoverage(snapshot, { ranges: sparseRanges, bof: false, eof: false }),
    );
    expect(sparse).toContain("... (+18 more gaps), 59");
    expect(sparse).toContain("... (+18 more calls), hashline_read(offset=59, limit=1)");
    expect(sparse).toContain(
      "For omitted calls, use hashline_read(offset=1, limit=59) and follow @more with limit=1000 until line 59 is issued",
    );
    expect(sparse.length).toBeLessThan(2000);
  });

  test("reports edge-only coverage with REF_NOT_ISSUED and handles empty files", () => {
    const store = new SnapshotStore(options());
    const edgeSnapshot = store.remember(scope, "/worktree/edge", document("line"));
    store.issue(edgeSnapshot, { ranges: [{ start: 1, end: 1 }], bof: true, eof: false });
    const edgeOnly = thrownMessage(() =>
      store.assertIssuedCoverage(edgeSnapshot, {
        ranges: [{ start: 1, end: 1 }],
        bof: true,
        eof: true,
      }),
    );
    expect(edgeOnly).toContain("REF_NOT_ISSUED: Missing issued coverage: EOF boundary.");

    const empty = store.remember(scope, "/worktree/empty-coverage", document(""));
    expect(collectMissingIssuedCoverage(empty, { ranges: [], bof: true, eof: true })).toEqual({
      ranges: [],
      primaryRanges: [],
      boundaryRanges: [],
      bof: true,
      eof: true,
    });
    const bothEdges = thrownMessage(() =>
      store.assertIssuedCoverage(empty, { ranges: [], bof: true, eof: true }),
    );
    expect(bothEdges).toContain(
      "REF_NOT_ISSUED: Missing issued coverage: BOF boundary; EOF boundary.",
    );
    expect(bothEdges.match(/hashline_read\(/g)).toHaveLength(1);

    store.issue(empty, { ranges: [], bof: false, eof: true });
    const bofOnly = thrownMessage(() =>
      store.assertIssuedCoverage(empty, { ranges: [], bof: true, eof: true }),
    );
    expect(bofOnly).toContain("Missing issued coverage: BOF boundary.");
    store.issue(empty, { ranges: [], bof: true, eof: false });
    expect(() =>
      store.assertIssuedCoverage(empty, { ranges: [], bof: true, eof: true }),
    ).not.toThrow();
  });

  test("invalidates equivalent raw worktree spellings for one session and canonical path", () => {
    const store = new SnapshotStore(options());
    const canonicalPath = "/canonical/worktree/file.ts";
    const first = store.remember(
      { sessionId: "session", worktree: "/raw/worktree" },
      canonicalPath,
      document("first"),
    );
    const equivalent = store.remember(
      { sessionId: "session", worktree: "/raw/worktree/." },
      canonicalPath,
      document("second"),
    );
    const otherSession = store.remember(
      { sessionId: "other", worktree: "/raw/worktree" },
      canonicalPath,
      document("other"),
    );

    store.invalidateSessionPath("session", canonicalPath);
    expect(() => store.peek({ sessionId: "session", worktree: "/raw/worktree" }, first.id)).toThrow(
      "SNAPSHOT_UNKNOWN:",
    );
    expect(() =>
      store.peek({ sessionId: "session", worktree: "/raw/worktree/." }, equivalent.id),
    ).toThrow("SNAPSHOT_UNKNOWN:");
    expect(() =>
      store.peek({ sessionId: "other", worktree: "/raw/worktree" }, otherSession.id),
    ).not.toThrow();
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
  test("renders complete and cumulatively completing pages without issuing during rendering", () => {
    const store = new SnapshotStore(options());
    const completeSnapshot = store.remember(scope, "/worktree/complete", document("a\nb"));
    const complete = renderSnapshotPage({
      snapshot: completeSnapshot,
      offset: 1,
      limit: 2,
      maxOutputBytes: 4096,
    });
    expect(complete.output.split("\n")[0]).toBe(
      `@hashline snapshot=${completeSnapshot.id} sha256=${completeSnapshot.digest.slice(0, 12)} lines=2 coverage=complete`,
    );
    expect(complete.page).toEqual({ ranges: [{ start: 1, end: 2 }], bof: true, eof: true });
    expect(completeSnapshot.issued).toEqual([]);
    expect(completeSnapshot.complete).toBeFalse();
    expect(completeSnapshot.delivered).toBeFalse();

    const snapshot = store.remember(scope, "/worktree/paginated", document("a\nb\nc"));
    const first = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 2,
      maxOutputBytes: 4096,
    });
    expect(first.output.split("\n")[0]).toBe(
      `@hashline snapshot=${snapshot.id} sha256=${snapshot.digest.slice(0, 12)} lines=3 partial=true coverage=partial`,
    );
    expect(first.output).toContain("1|a\n2|b\n@more offset=3");
    expect(first.page).toEqual({ ranges: [{ start: 1, end: 2 }], bof: true, eof: false });
    expect(first.nextOffset).toBe(3);
    expect(snapshot.issued).toEqual([]);

    store.issue(snapshot, first.page);
    const evidenceBeforeSecondRender = {
      issued: snapshot.issued.map((range) => ({ ...range })),
      issuedBof: snapshot.issuedBof,
      issuedEof: snapshot.issuedEof,
      complete: snapshot.complete,
      delivered: snapshot.delivered,
      lastUsedAt: snapshot.lastUsedAt,
    };
    const second = renderSnapshotPage({
      snapshot,
      offset: 3,
      limit: 2,
      maxOutputBytes: 4096,
    });
    expect(second.output.split("\n")[0]).toBe(
      `@hashline snapshot=${snapshot.id} sha256=${snapshot.digest.slice(0, 12)} lines=3 partial=true coverage=complete`,
    );
    expect(second.output).toContain("3|c\n@eof");
    expect(second.page).toEqual({ ranges: [{ start: 3, end: 3 }], bof: false, eof: true });
    expect(second.nextOffset).toBeUndefined();
    expect({
      issued: snapshot.issued,
      issuedBof: snapshot.issuedBof,
      issuedEof: snapshot.issuedEof,
      complete: snapshot.complete,
      delivered: snapshot.delivered,
      lastUsedAt: snapshot.lastUsedAt,
    }).toEqual(evidenceBeforeSecondRender);
  });

  test("keeps a pending partial prediction conservative across reordered delivery", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/reordered", document("a\nb\nc"));
    const trailing = renderSnapshotPage({
      snapshot,
      offset: 3,
      limit: 1,
      maxOutputBytes: 4096,
    });
    const leading = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 2,
      maxOutputBytes: 4096,
    });

    expect(trailing.output).toContain("partial=true coverage=partial");
    expect(leading.output).toContain("partial=true coverage=partial");
    store.issue(snapshot, leading.page);
    store.issue(snapshot, trailing.page);
    expect(snapshot.complete).toBeTrue();
  });

  test("reserves the longest coverage marker at exact byte boundaries", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/file", document("x".repeat(3000)));
    const complete = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 4096,
    });
    expect(complete.output).toContain(`1|${"x".repeat(3000)}`);
    expect(complete.output).toContain("lines=1 coverage=complete");
    expect(complete.output).not.toContain("partial=true");
    expect(complete.page.ranges).toEqual([{ start: 1, end: 1 }]);

    const exactBytes = Buffer.byteLength(complete.output, "utf8");
    const exactBudget = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: exactBytes,
    });
    expect(exactBudget.output).toBe(complete.output);

    const oneByteShort = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: exactBytes - 1,
    });
    expect(Buffer.byteLength(oneByteShort.output, "utf8")).toBeLessThanOrEqual(exactBytes - 1);
    expect(oneByteShort.output).toContain("partial=true coverage=partial");
    expect(oneByteShort.output).toContain("1!|");
    expect(oneByteShort.page.ranges).toEqual([]);

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
    expect(displaced.output).toContain("partial=true coverage=partial");
    expect(displaced.output).toContain("1!|");
    expect(displaced.page.ranges).toEqual([]);
  });

  test("marks preview-only pages as partial cumulative coverage", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/preview", document("x".repeat(3000)));
    const rendered = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(Buffer.byteLength(rendered.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(rendered.output).toContain("1!|");
    expect(rendered.output).toContain("line not issued");
    expect(rendered.output).toContain("partial=true coverage=partial");
    expect(rendered.page).toEqual({ ranges: [], bof: true, eof: true });
    expect(snapshot.issued).toEqual([]);
    expect(snapshot.delivered).toBeFalse();

    store.issue(snapshot, rendered.page);
    const previewOnly = thrownMessage(() =>
      store.assertIssuedCoverage(snapshot, {
        ranges: [{ start: 1, end: 1 }],
        bof: false,
        eof: false,
      }),
    );
    expect(previewOnly).toContain("Missing issued coverage: line gaps: 1.");
    expect(previewOnly).toContain("preview-only N!| lines remain unissued");
  });

  test("uses byte budgets for multibyte preview lines", () => {
    const store = new SnapshotStore(options());
    const snapshot = store.remember(scope, "/worktree/multibyte", document("😀".repeat(1000)));
    const rendered = renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(Buffer.byteLength(rendered.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(rendered.output).toContain("partial=true coverage=partial");
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
  });

  test("reports complete empty coverage and partial out-of-range coverage", () => {
    const store = new SnapshotStore(options());
    const empty = store.remember(scope, "/worktree/empty", document(""));
    const emptyPage = renderSnapshotPage({
      snapshot: empty,
      offset: 1,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(emptyPage.output).toContain("lines=0 coverage=complete\n@eof");
    expect(emptyPage.output).not.toContain("partial=true");
    expect(emptyPage.page).toEqual({ ranges: [], bof: true, eof: true });

    const snapshot = store.remember(scope, "/worktree/out-of-range", document("line"));
    const pastEnd = renderSnapshotPage({
      snapshot,
      offset: 99,
      limit: 1,
      maxOutputBytes: 1024,
    });
    expect(pastEnd.page).toEqual({ ranges: [], bof: false, eof: true });
    expect(pastEnd.output).toContain("lines=1 partial=true coverage=partial");
    expect(snapshot.issued).toEqual([]);
    expect(snapshot.delivered).toBeFalse();
  });
});
