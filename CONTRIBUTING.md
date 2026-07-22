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
semantics. A pull request changing any of them must include:

- a concrete failure or measured opportunity;
- deterministic safety and compatibility tests;
- an updated protocol specification, architecture/threat-model notes, and changelog entry;
- before/after wire-size measurements for schema or model-visible output changes;
- migration notes when existing transcripts, native-alias fingerprints, generated clients, or configuration are affected.

Lifecycle tests must cover exact strict bytes, complete BOF-to-EOF source issuance, direct regular
single-link sources, occupied destinations including symlinks, stable existing parents,
same-filesystem moves, dual-path permissions, deterministic overlapping locks, post-approval races
without replanning, and `PARTIAL_PUBLICATION` without unsafe rollback. Native-alias tests must also
cover operation/source/destination metadata correlation, old-version history rejection, affected
snapshot invalidation, and poisoned-session recovery.

Do not replace fail-closed behavior with fuzzy matching, silent fallback, overwrite, parent creation,
or destructive rollback merely to improve a success-rate benchmark.

## Benchmarks

Benchmark pull requests must pin fixtures, task and adapter identities, seeds, OpenCode and plugin
revisions, runtime versions, and model snapshots where applicable. Preserve raw results and report
failures, retries, partial publications, and unintended changes rather than success-conditioned
averages. Never rewrite retained evidence to cover a new schema, operation, task set, or adapter; add
a new identity and result. Dry runs and model-free verifier evidence are not paid model evidence.

## Commits

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`. Release
automation uses these commits to prepare the changelog.
