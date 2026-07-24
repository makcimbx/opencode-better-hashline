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
| `src/session-protocol.ts` | Offline bounded v2 history validation, lifecycle path correlation, attested rejection markers, and instance-local live-epoch binding |
| `src/session-export.ts` | Strict bounded export identity and independently bound worktree-locator attestation |
| `src/model-trace.ts` | Shared trace/export correlation, lifecycle mutation evidence, and native-alias benchmark oracle |
| `src/path-identity.ts` | Exact canonical path equality, containment, and filesystem-root identity |
| `src/process-capture.ts` | Bounded subprocess capture and process-tree termination |
| `src/exact-tree.ts` | Race-resistant physical tree, file-identity, reparse, and stream evaluation |
| `src/rebase.ts` | Exact unique range/boundary relocation, bounded comparison work, and diagnostic-only EOL-change detection |
| `src/edits.ts` | Text-operation validation, deterministic conflict-pair evidence, transfer composition, bounded projection, and final bytes |
| `src/filesystem.ts` | Canonicalization, authorization, deterministic locks, stable reads, fixed parent plans, and text/lifecycle publication |
| `src/plugin.ts` | Flat tool schemas, hooks, native-mutator enforcement, readback delivery, and fixed-plan filesystem orchestration |
| `src/index.ts` | Public library exports and OpenCode `PluginModule` |
| `src/server.ts` | Modern OpenCode `./server` package entrypoint |
| `src/verify.ts`, `src/cli.ts` | Credential-free packed OpenCode route, schema, hook, export/import, and renderer verification |

## Design Boundaries

### Addressing is not authority

The model addresses logical lines by ordinary one-based numbers. Authority comes from a random snapshot ID bound to exact retained bytes, session, worktree, and canonical path. This makes display width independent of collision resistance.

### Read provenance is explicit

The snapshot store distinguishes bytes retained by the process from line references actually issued to a model. A range cannot be edited when an interior line was omitted or rendered preview-only. Issuance occurs after the host's generic truncation layer, not when the tool initially constructs output. Requested `hashline_read.limit` accepts `1..100,000` and defaults to 1,000, but `maxOutputBytes` remains authoritative (40 KiB by default, configurable to at most 45 KiB). `@more` means rendering stopped before EOF; `@eof` means EOF was reached, and `partial=true` may accompany either when complete editable evidence is absent. A preview-only `N!|` line cannot be issued by pagination. Complete-coverage diagnostics aggregate bounded missing ranges and boundary requirements, while recovery suggestions deliberately cap each read at a conservative 1,000 lines.

### Planning is pure where the operation is textual

`planEdits` receives base and current immutable text documents and returns final text/bytes or a
stable rejection. It performs no I/O and asks no permission. This makes exhaustive and property
testing possible without weakening the filesystem path.

Before planning, omitted `rebase` resolves from the validated operation set. Batches limited to
`replace`, `insert`, `copy_range`, and `move_range` select exact, ambiguity-rejecting `unique`;
sole `replace_file`, `delete_file`, and `move_file` select strict `none`. Explicit `none` requires
full-byte freshness, while explicit `unique` retains the same incremental-only constraints as
omission. This is selection, not fallback: a failed strict check never activates relocation.

`replace` removes the exact one-based inclusive `startLine..endLine` range, and its `lines` payload is the complete replacement; outside neighbors remain. Every operation in a batch uses coordinates from the immutable original snapshot, not an intermediate result or a line created by another operation. For sole `replace_file`, omitted `finalNewline` preserves snapshot state for non-empty `lines`, while empty `lines` infer `false`; explicit `true` with an empty payload rejects.

Transfer-containing batches are one simultaneous transformation over the pre-batch document. Copy
reads retained pre-edit logical texts and inserts them with destination-local EOL rules, even when
another operation writes across its source. Move rewrites one source-to-destination corridor by
permuting texts over fixed positional EOL slots. One move can absorb pairwise-disjoint replacements
wholly inside its intervening corridor and outside its source; all payloads still come from the
immutable pre-batch corridor, and full-corridor issuance/freshness remains authoritative. A
declarative write-footprint graph rejects every other intersecting destructive span, internal
insertion destination, and duplicate insertion destination instead of giving operation array order
sequential meaning. Rejections preserve their overlap/boundary code and report the lexicographically
smallest zero-based original operation pair. Projected text statistics compose CRLF across planned
segment boundaries; after bounded projection, every move is rendered lazily and reparsed to prove
that its expected logical texts and positional EOL slots remain representable.

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

Automatic `hashline_write` parent planning follows the same principle. The deepest existing ancestor,
zero to 64 missing directories, target, lock set, and permission metadata are frozen before approval.
Every planned directory and the target are authorized and locked, and revalidation never replaces the
approved chain with a newly observed one. A zero-directory plan delegates directly to file publication.

### Publication is separate from conflict detection

Conflict detection uses exact bytes and identity. Text edits use same-directory staging plus rename,
which improves visibility and crash behavior where supported but is not conditional compare-and-swap.
Delete revalidates the direct source entry before unlink. Move creates a no-clobber destination hard
link, verifies exact inode/bytes/link count, then unlinks the source. If publication passes the link
boundary but cannot safely finish, `PARTIAL_PUBLICATION` reports that both names may exist; there is
no unsafe automatic rollback. Parent creation uses exclusive non-recursive root-to-leaf `mkdir`
before delegating to existing staged no-clobber file publication. After its first directory exists,
or a failed `mkdir` leaves the outcome ambiguous, every later failure is `PARTIAL_PUBLICATION` and no
created state is rolled back.
These distinctions are explicit in API errors and documentation.

## OpenCode Integration

The npm package default-exports a modern `PluginModule` and exposes both root and `./server` exports. OpenCode's stable V1 loader prefers the server entrypoint.

The default unique tool IDs avoid three OpenCode hazards:

- later registry collisions silently replacing a builtin;
- model-dependent filtering of exact IDs such as `edit` and `apply_patch`;
- inability to call a displaced builtin for media or directory reads.

The plugin keeps native `read` and adds `hashline_read`, `hashline_edit`, and `hashline_write`. With `enforce: true`, `chat.message` disables native mutator IDs on every user turn and `tool.execute.before` is a second tripwire. This is defense in depth, not a shell sandbox.

The explicit native-alias preview instead registers Better Hashline's shared executor as `edit` and
`apply_patch`, lets OpenCode retain one by model route, and preserves unique read/create tools. The
aliases require Better Hashline's top-level `filePath`/`snapshotId`/`operations`, accept only the
documented optional controls, reject native argument shapes, and restrict source and destination
paths to the current worktree. Authorized external mutation requires switching to the unique hashline
surface and restarting. Activation uses the host-configured SDK transport to observe exact host and schema
fingerprints, `native-aliases/v2` operation/path markers, delivered-read live-epoch attestation,
double argument parsing, and native renderer metadata. Registry ownership still cannot be attested,
so this surface does not replace the unique-ID recommendation.

Persisted v1 and v2 history remains subject to bounded exact validation in offline verifier,
model-trace, and evidence paths. The live executor does not fetch that history to admit edits. The
marker string remains v2 across provider-contract changes, but package version, canonical schema
SHA-256, and protocol fingerprint are exact identity. An identity change invalidates the process-local
epoch;
restart the plugin as required and use a fresh delivered `hashline_read` to rebind in the same
session. Old snapshot IDs remain unusable.

Preparing a read for the same fingerprint and canonical worktree may reuse the current candidate authority. Preparing a differing identity retires active authority immediately. Only the current candidate delivered and attested by `tool.execute.after` can commit, and each snapshot token must match the active authority; stale, reordered, and ABA completions cannot bind or revive old IDs.

Before a delivered and attested `hashline_read` establishes or replaces that exact epoch, native-alias
`edit` and `apply_patch` calls are rejected. Once bound, alias calls may overlap only when their
complete canonical source/destination path sets are disjoint; sorted path locks serialize every
overlap. Locks are acquired sequentially in canonical order, and cancellation while queued releases
already acquired locks without reserving later independent paths. Each approval and publication
remains independent. A partial move or parent publication invalidates affected snapshots and unbinds
the epoch. After inspecting and repairing the paths, a fresh delivered read can rebind in the same
session; old snapshot IDs cannot be revived.

## State and Eviction

Snapshots are process-memory objects. Retained weight accounts for raw bytes plus decoded UTF-16 text. Limits apply globally, per session, and per session/path. LRU and TTL eviction skip pinned edits. If all eligible entries are pinned or one file cannot fit the configured budget, the operation rejects rather than exceeding the budget silently.

A successful or attempted publication transition invalidates prior snapshots for every affected
path. Successful output explicitly reports that transition through
`@hashline-edit previous=consumed successor=none|attached|unavailable`. Text edits require a reread
by default; `readback:true` or either readback window field requests that post-rename verification
bytes create a new pending snapshot with one contiguous page. `readbackOffset` selects a one-based
post-edit start, defaulting to the first hunk; requested `readbackLimit` accepts `1..100,000` and
defaults to 1,000. Explicit `readback:false` conflicts with either window field. A successful
mutation may still report `successor=unavailable`. The authoritative `maxOutputBytes` budget can stop
rendering early: `@more` means before EOF, `@eof` means EOF was reached, and either may accompany
`partial=true`. Only refs on the page attested by the after-hook are issued; there is no ID-only
successor. Failed delivery does not turn the completed write into a mutation failure. Lifecycle
operations never return a successor and reject `readback:true`, `readbackOffset`, and `readbackLimit`.
Delete invalidates the source; move invalidates source and destination immediately before link
publication, including when the result becomes `PARTIAL_PUBLICATION`. Parent-creating publication
invalidates snapshots for every planned directory and target path. On the native-alias surface,
either partial outcome also unbinds the live epoch.
Multiple exact reads can reuse one retained snapshot only when digest and bytes both match, and
their issued pages can accumulate complete coverage.

## Filesystem Model

Text edits resolve existing symlinks to one canonical target, which is authorized, locked, reread,
and replaced. Alias stability is checked around reads and before publication. Lifecycle sources use
a stricter resolver: the requested terminal entry itself must be a regular file, never a symlink,
and must remain bound to the canonical source and stable parent. New files locate and pin the deepest
existing canonical ancestor, while move destinations still require an existing canonical parent.
Every existing terminal entry, including a symlink, is occupied.

The strict `hashline_write` schema contains only `filePath` and `content`; the obsolete
`createParents` field is rejected. Every call freezes up to 64 absent directory entries and the target.
Every planned directory and target are canonicalized, authorized, and locked; missing directories are
created exclusively from root to leaf and identity-checked before staged no-clobber file publication.
A zero-missing-directory plan runs no `mkdir` and delegates to the same publication path. The first
directory observed after an attempted `mkdir`, including an ambiguous reported failure, is the
no-rollback boundary; a later error can leave the target file and directories present and requires
inspection and reconciliation before retrying. `move_file` never enters this path.

Supported existing targets are regular, single-link files within the size and UTF-8 policy limits.
Hardlinks are rejected because replacing, deleting, or moving one directory entry would violate the
protocol's alias expectations. Special files and unsupported metadata states reject. `move_file`
also requires distinct source/destination paths, an absent destination, stable existing parents, and
one filesystem; it never overwrites or creates directories.

Process-global lock keys are canonical physical paths, case-folded on Windows. A call reserves its
deduplicated sorted path set, so delete/text calls lock one path and move locks both source and
destination. Disjoint complete path sets can progress concurrently after native live-epoch admission;
any overlap serializes. These locks cannot coordinate another OpenCode process, editor,
formatter, daemon, or network client.

## Testing Strategy

The test suite has separate layers:

- pure text, relocation, and edit planner tests;
- snapshot provenance, complete-coverage, TTL, pinning, invalidation, and byte-budget tests;
- renderer truncation and UTF-8 budget tests;
- real temporary-filesystem tests for direct terminal binding, symlinks, hardlinks, destination absence, parent/source races, fixed parent chains, exclusive directory creation, deterministic path-set locks, no-replace creation and movement, and partial publication;
- plugin contract tests with fake OpenCode contexts and real tool/hook definitions, including inferred readback windows/issuance, deterministic conflict pairs, lifecycle and strict automatic parent-creation shapes, complete path permissions, immutable approval metadata, receipts, attested terminal rejections, live-epoch unbinding/rebinding, and bound/unbound alias admission and concurrency;
- packed-tarball installation, root/server/CLI entrypoint checks, and deterministic stock OpenCode sessions, including lifecycle routes and two-process native-alias rejection/fresh-read restart recovery;
- collision fixtures for registration order, same-schema replacement, namespaced MCP controls, and later output mutation;
- deterministic non-gating benchmarks and an opt-in model harness with separately versioned task and adapter identities. The schema-v9 model-free result measures explicit strict, explicit unique, and the incremental branch of the operation-aware omitted adapter; strict-only defaults remain runtime-test evidence. It is textual protocol evidence, not semantic or model-quality evidence. The historical schema-v5 through schema-v8 results and pilot-v7 evidence remain immutable.

Timing benchmarks never gate shared CI. Safety regressions do.

## Future-Compatible Seams

Potential extensions should stay behind explicit protocol fields:

- provider-specific or task-adaptive display formats;
- stronger platform-specific conditional replacement primitives;
- OpenCode-native UI metadata when a public API exists;
- an experimental per-line tag A/B arm, never promoted to authority;
- multi-file plans with truthful partial-result reporting or a real transaction primitive.

Do not add silent compatibility fallbacks. A format change should fail clearly and ship with fixtures and benchmark evidence.
