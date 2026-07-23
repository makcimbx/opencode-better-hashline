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

Tool names, flat schemas, operation-specific field combinations, line rendering, hash inputs,
normalization, validation, mismatch behavior, permission metadata, and publication results are
public protocol surface. File lifecycle changes also include direct path identity, complete issued
coverage, source/destination authorization, lock sets, native renderer metadata, and partial-state
semantics. Readback windows, operation-pair conflict diagnostics, and parent-chain creation plans are
also public protocol surface. A pull request changing any of them must include:

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

Parent-creating write tests must additionally cover the 64-directory bound, a fixed deepest-ancestor
plan, authorization and deterministic locks for every directory plus the target, exclusive
non-recursive root-to-leaf `mkdir`, the existing staged no-clobber file publication, no state before
the first directory exists or creation becomes ambiguous, retained state and `PARTIAL_PUBLICATION`
afterward, and no rollback.
Omitted or false `createParents` must remain strict, and `move_file` must never create parents.
Read and readback tests must cover requested `limit` and `readbackLimit` values across the public
`1..100,000` range, the 1,000-line default, and authoritative `maxOutputBytes` pagination (40 KiB
by default, configurable to at most 45 KiB), with byte-limited partial pages ending in `@more`.
Readback remains one contiguous, one-based, text-only delivered page; undelivered or ID-only
successor authority must be rejected. Coverage diagnostics must aggregate missing ranges and boundary
requirements while recommending conservative reads of at most 1,000 lines. Replacement tests must prove
that `startLine..endLine` is inclusive, `lines` is the complete replacement, outside neighbors remain,
and every operation uses immutable original-snapshot coordinates. Conflict tests must preserve stable
codes and deterministic zero-based operation-pair suffixes.

Do not replace fail-closed behavior with fuzzy matching, silent fallback, overwrite, unplanned or
recursive parent creation, or destructive rollback merely to improve a success-rate benchmark.

## Benchmarks

Benchmark pull requests must pin fixtures, task and adapter identities, seeds, OpenCode and plugin
revisions, runtime versions, and model snapshots where applicable. Preserve raw results and report
failures, retries, partial publications, and unintended changes rather than success-conditioned
averages. Never rewrite retained evidence to cover a new schema, operation, task set, or adapter; add
a new identity and result. Dry runs and model-free verifier evidence are not paid model evidence.
Development runner output is not retained evidence until it is written once at a new final result
path. Preserve the schema-v6 and schema-v7 results plus pilot-v7 scope unchanged; future runner or
protocol revisions require a new result identity.

## Commits

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`. Release
automation uses these commits to prepare the changelog.
