# Contributing

Contributions are welcome, especially minimized failure cases, cross-platform fixes, and benchmark
scenarios that distinguish editing protocols.

## Development

Requirements:

- Bun 1.3.14 or newer
- OpenCode 1.18.4

```sh
bun install --frozen-lockfile
bun run ci
bun run pack:check
```

Use `bun run format` before opening a pull request. Tests must be deterministic and must not require
provider credentials. Live-model benchmarks are opt-in and never gate a pull request.

## Protocol Changes

Tool names, flat schemas, operation-specific field combinations, line rendering, cumulative coverage
headers, hash inputs, normalization, validation, mismatch behavior, permission metadata, and
publication results are public protocol surface. File lifecycle changes also include direct path
identity, complete issued coverage, source/destination authorization, lock sets, native renderer
metadata, and partial-state semantics. Readback windows, operation-pair conflict diagnostics, and
parent-chain creation plans are also public protocol surface. A pull request changing any of them
must include:

- a concrete failure or measured opportunity;
- deterministic safety and compatibility tests;
- an updated protocol specification, architecture/threat-model notes, and changelog entry;
- before/after wire-size measurements for schema or model-visible output changes;
- migration notes when existing transcripts, native-alias fingerprints, generated clients, or configuration are affected.

Lifecycle tests must cover exact strict bytes, complete BOF-to-EOF source issuance, direct regular
single-link sources, occupied destinations including symlinks, stable existing parents,
same-filesystem moves, dual-path permissions, deterministic overlapping locks, post-approval races
without replanning, and `PARTIAL_PUBLICATION` without unsafe rollback. Native-alias tests must also
cover operation/source/destination metadata correlation, offline old-version history rejection,
delivered-read live-epoch admission without persisted-history fetches, affected snapshot invalidation
and epoch unbinding after partial publication, and same-session fresh-read recovery without reviving
old snapshot IDs.

Automatic parent-creating write tests must additionally cover the strict `filePath`/`content` schema,
rejection of the obsolete `createParents` field, the zero-missing-directory path, the 64-directory
bound, deepest-existing-ancestor identity pinning, a fixed full authorization/lock reservation of the
initially missing directory names plus target, exact pre-approval adoption of only a contiguous
root-side directory prefix, retention of the original missing-name/target lock envelope, permission
metadata for only the remaining mutation suffix, exclusive non-recursive root-to-leaf `mkdir`, staged
no-clobber file publication, no state created by the call before its first directory or an ambiguous
creation outcome, retained state and `PARTIAL_PUBLICATION` afterward, generation fencing of already
queued overlapping calls, and no rollback. `move_file` never creates parents.

Filesystem recovery tests must prove bounded delayed and abort-aware retries of complete read-only
observations, exhaustion behavior, exact staging ownership and descriptor cleanup, and phase-correct
final proof. Target `rename`, `link`, `unlink`, and `mkdir` publication attempts remain single-shot.
Read and readback tests must cover requested `limit` and `readbackLimit` values across the public
`1..100,000` range, the 1,000-line default, and authoritative `maxOutputBytes` pagination (40 KiB
by default and at most 45 KiB when configured). Every header must report `coverage=partial|complete`,
computed from evidence already issued at render time plus the candidate page, without mutating
issuance during rendering. Tests must prove that `complete` inputs are sufficient and remain so when
the candidate stays valid and is attested, and that a `partial` render can become conservative when
another page is delivered and attested later or out of order. They must also cover a complete page, a cumulatively
completing `partial=true coverage=complete` page, preview-only and out-of-range partial coverage, exact
byte budgets after reserving the longest header marker, and candidate invalidation issuing nothing.
Byte-limited pages use `@more` only before EOF; `@eof` can coexist with `partial=true`. Readback remains
one contiguous, one-based, text-only delivered page; undelivered, pending, invalidated, or ID-only
successor authority must be rejected. Text-edit tests, including sole strict `replace_file`, must prove
that `readback:true` works without a window, either window field implies readback, omission requests
none, and explicit `readback:false` plus a window is rejected. Lifecycle tests for `delete_file` and
`move_file` must prove that `readback:true` and every window are rejected without a successor.
Coverage diagnostics must aggregate missing ranges and boundary requirements while recommending
conservative reads of at most 1,000 lines. Replacement tests must prove that `startLine..endLine` is
inclusive, `lines` is the complete replacement, outside neighbors remain, and every operation uses
immutable original-snapshot coordinates. Whole-file tests must prove that omitted `finalNewline`
preserves snapshot state for non-empty `lines`, while empty `lines` infer `false` and reject explicit
`true`. Conflict tests must preserve stable codes and deterministic zero-based operation-pair suffixes.

Use [`docs/tool-contract-guidelines.md`](docs/tool-contract-guidelines.md) for every model-visible
tool, schema, system-guidance, receipt, or recovery-message change. Apply its rubric across all
configured surfaces and preserve phase-correct error recovery.

Do not replace fail-closed behavior with fuzzy matching, silent fallback, overwrite, authorization or
lock expansion, unplanned or recursive parent creation, publication-syscall retries, or destructive
rollback merely to improve a success-rate benchmark. Conversely, do not expose a model retry when a
small bounded complete observation can still prove the exact same authorized state and safely continue.

## Benchmarks

Benchmark pull requests must pin fixtures, task and adapter identities, seeds, OpenCode and plugin
revisions, runtime versions, and model snapshots where applicable. Preserve raw results and report
failures, retries, partial publications, and unintended changes rather than success-conditioned
averages. Never rewrite retained evidence to cover a new schema, operation, task set, or adapter; add
a new identity and result. Dry runs and model-free verifier evidence are not paid model evidence.
Development runner output is not retained evidence until it is written once at a new final result
path. Preserve schema-v5 through schema-v9 results and pilot-v7 scope unchanged. The current
schema-v10 write-once retained result is
`benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json`; future runner or protocol
revisions require another new result identity.

## Commits

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`. Release
automation uses these commits to prepare the changelog.
