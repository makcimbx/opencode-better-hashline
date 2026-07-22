# Architecture

Better Hashline is intentionally split into pure protocol logic, bounded state, filesystem publication, and a thin OpenCode adapter.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/text.ts` | Fatal UTF-8 decoding, BOM/EOL model, byte-preserving encode, payload validation |
| `src/snapshots.ts` | Opaque IDs, exact bytes/SHA-256, scope, issued provenance, TTL/LRU limits |
| `src/render.ts` | Byte-bounded `N|content` pages and preview-only oversized lines |
| `src/presentation.ts` | `native-aliases/v2` renderer metadata, operation/path fingerprints, and serialized-size measurement |
| `src/native-alias.ts` | Bounded exact-host detection through OpenCode's configured SDK transport |
| `src/session-protocol.ts` | Bounded v2 history validation, lifecycle path correlation, attested rejection markers, and instance-local alias session binding |
| `src/session-export.ts` | Strict bounded export identity and independently bound worktree-locator attestation |
| `src/model-trace.ts` | Shared trace/export correlation, lifecycle mutation evidence, and native-alias benchmark oracle |
| `src/path-identity.ts` | Exact canonical path equality, containment, and filesystem-root identity |
| `src/process-capture.ts` | Bounded subprocess capture and process-tree termination |
| `src/exact-tree.ts` | Race-resistant physical tree, file-identity, reparse, and stream evaluation |
| `src/rebase.ts` | Exact unique range/boundary relocation with a cumulative comparison budget |
| `src/edits.ts` | Text-operation validation, transfer effect analysis, immutable planning, bounded projection, and final bytes |
| `src/filesystem.ts` | Canonicalization, dual-path authorization, deterministic locks, stable reads, and text/lifecycle publication |
| `src/plugin.ts` | Flat tool schemas, hooks, native-mutator enforcement, and fixed-plan lifecycle orchestration |
| `src/index.ts` | Public library exports and OpenCode `PluginModule` |
| `src/server.ts` | Modern OpenCode `./server` package entrypoint |
| `src/verify.ts`, `src/cli.ts` | Credential-free packed OpenCode route, schema, hook, export/import, and renderer verification |

## Design Boundaries

### Addressing is not authority

The model addresses logical lines by ordinary one-based numbers. Authority comes from a random snapshot ID bound to exact retained bytes, session, worktree, and canonical path. This makes display width independent of collision resistance.

### Read provenance is explicit

The snapshot store distinguishes bytes retained by the process from line references actually issued to a model. A range cannot be edited when an interior line was omitted or rendered preview-only. Issuance occurs after the host's generic truncation layer, not when the tool initially constructs output.

### Planning is pure where the operation is textual

`planEdits` receives base and current immutable text documents and returns final text/bytes or a
stable rejection. It performs no I/O and asks no permission. This makes exhaustive and property
testing possible without weakening the filesystem path.

Transfer-containing batches are one simultaneous transformation over the pre-batch document. Copy
reads retained pre-edit logical texts and inserts them with destination-local EOL rules, even when
another operation writes across its source. Move rewrites one source-to-destination corridor by
permuting texts over fixed positional EOL slots. A declarative write-footprint graph rejects
intersecting destructive spans, internal insertion destinations, and duplicate insertion
destinations instead of giving operation array order sequential meaning. Projected text statistics
compose CRLF across planned segment boundaries; after bounded projection, every move is rendered
lazily and reparsed to prove that its expected logical texts and positional EOL slots remain
representable.

Whole-file deletion and movement are intentionally outside `planEdits`. They depend on direct
directory-entry identity, destination absence, stable parents, filesystem identity, and link-count
evidence rather than a final text document. The plugin validates the sole operation and complete
snapshot provenance, then freezes an immutable filesystem plan with the exact operation, canonical
source/destination paths, stable identities, patch, and renderer metadata. It never converts a
lifecycle request into a text replacement or replans it after approval.

### Permissions approve a fixed plan

For text edits, the exact diff is created before `context.ask({ permission: "edit" })`. For delete
and move, the exact lifecycle patch and metadata are created before one edit request covering the
complete source/destination path set. After approval, current bytes, identities, direct terminal
binding, parent identity, and destination absence are checked again. The plugin never asks approval
for one patch, then silently rebases, substitutes a destination, or publishes another.

### Publication is separate from conflict detection

Conflict detection uses exact bytes and identity. Text edits use same-directory staging plus rename,
which improves visibility and crash behavior where supported but is not conditional compare-and-swap.
Delete revalidates the direct source entry before unlink. Move creates a no-clobber destination hard
link, verifies exact inode/bytes/link count, then unlinks the source. If publication passes the link
boundary but cannot safely finish, `PARTIAL_PUBLICATION` reports that both names may exist; there is
no unsafe automatic rollback. These distinctions are explicit in API errors and documentation.

## OpenCode Integration

The npm package default-exports a modern `PluginModule` and exposes both root and `./server` exports. OpenCode's stable V1 loader prefers the server entrypoint.

The default unique tool IDs avoid three OpenCode hazards:

- later registry collisions silently replacing a builtin;
- model-dependent filtering of exact IDs such as `edit` and `apply_patch`;
- inability to call a displaced builtin for media or directory reads.

The plugin keeps native `read` and adds `hashline_read`, `hashline_edit`, and `hashline_write`. With `enforce: true`, `chat.message` disables native mutator IDs on every user turn and `tool.execute.before` is a second tripwire. This is defense in depth, not a shell sandbox.

The explicit native-alias preview instead registers Better Hashline's shared executor as `edit` and
`apply_patch`, lets OpenCode retain one by model route, and preserves unique read/create tools.
Activation uses the host-configured SDK transport, exact observed host and schema fingerprints,
`native-aliases/v2` operation/path markers, bounded session-history validation, double argument
parsing, and native renderer metadata. V1 history is incompatible by design. Registry ownership
still cannot be attested, so this surface does not replace the unique-ID recommendation.

Before process-local session binding, alias calls remain sequential so history validation sees at
most one active native-looking call. A bound session skips repeated history inspection for the same
exact package/schema/host/worktree fingerprint. Calls may overlap only when their full canonical
source/destination path sets are disjoint; sorted path locks serialize every overlap. Locks are
acquired sequentially in canonical order, and cancellation while queued releases already acquired
locks without reserving later independent paths. Each approval and publication remains independent.
A partial move publication poisons the binding, forcing inspection and a new session rather than
permitting unsafe continuation.

## State and Eviction

Snapshots are process-memory objects. Retained weight accounts for raw bytes plus decoded UTF-16 text. Limits apply globally, per session, and per session/path. LRU and TTL eviction skip pinned edits. If all eligible entries are pinned or one file cannot fit the configured budget, the operation rejects rather than exceeding the budget silently.

A successful or attempted publication transition invalidates prior snapshots for every affected
path. Successful output explicitly reports that transition through
`@hashline-edit previous=consumed successor=none|attached|unavailable`. Text edits require a reread
by default; with explicit `readback: true`, post-rename verification bytes may instead create a new
snapshot near the changed hunk. Its refs are issued only after the after-hook attests delivery, and
continuation never changes the already-completed write into a reported mutation failure. Lifecycle
operations reject readback. Delete invalidates the source; move invalidates source and destination
immediately before link publication, including when the result becomes `PARTIAL_PUBLICATION`.
Multiple exact reads can reuse one retained snapshot only when digest and bytes both match, and
their issued pages can accumulate complete coverage.

## Filesystem Model

Text edits resolve existing symlinks to one canonical target, which is authorized, locked, reread,
and replaced. Alias stability is checked around reads and before publication. Lifecycle sources use
a stricter resolver: the requested terminal entry itself must be a regular file, never a symlink,
and must remain bound to the canonical source and stable parent. New files and move destinations
resolve an existing canonical parent and treat every existing terminal entry, including a symlink,
as occupied.

Supported existing targets are regular, single-link files within the size and UTF-8 policy limits.
Hardlinks are rejected because replacing, deleting, or moving one directory entry would violate the
protocol's alias expectations. Special files and unsupported metadata states reject. `move_file`
also requires distinct source/destination paths, an absent destination, stable existing parents, and
one filesystem; it never overwrites or creates directories.

Process-global lock keys are canonical physical paths, case-folded on Windows. A call reserves its
deduplicated sorted path set, so delete/text calls lock one path and move locks both source and
destination. Disjoint path sets can progress concurrently after native session requirements are
satisfied; any overlap serializes. These locks cannot coordinate another OpenCode process, editor,
formatter, daemon, or network client.

## Testing Strategy

The test suite has separate layers:

- pure text, relocation, and edit planner tests;
- snapshot provenance, complete-coverage, TTL, pinning, invalidation, and byte-budget tests;
- renderer truncation and UTF-8 budget tests;
- real temporary-filesystem tests for direct terminal binding, symlinks, hardlinks, destination absence, parent/source races, deterministic path-set locks, no-replace creation and movement, and partial move publication;
- plugin contract tests with fake OpenCode contexts and real tool/hook definitions, including lifecycle shapes, dual-path permissions, immutable approval metadata, receipts, attested terminal rejections, poisoned bindings, and bound/unbound alias concurrency;
- packed-tarball installation, root/server/CLI entrypoint checks, and deterministic stock OpenCode sessions, including lifecycle routes and two-process native-alias rejection/restart recovery;
- collision fixtures for registration order, same-schema replacement, namespaced MCP controls, and later output mutation;
- deterministic non-gating benchmarks and an opt-in model harness with separately versioned task and adapter identities.

Timing benchmarks never gate shared CI. Safety regressions do.

## Future-Compatible Seams

Potential extensions should stay behind explicit protocol fields:

- provider-specific or task-adaptive display formats;
- stronger platform-specific conditional replacement primitives;
- OpenCode-native UI metadata when a public API exists;
- an experimental per-line tag A/B arm, never promoted to authority;
- multi-file plans with truthful partial-result reporting or a real transaction primitive.

Do not add silent compatibility fallbacks. A format change should fail clearly and ship with fixtures and benchmark evidence.
