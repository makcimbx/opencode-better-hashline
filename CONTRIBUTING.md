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

Tool names, schemas, line rendering, hash inputs, normalization, validation, and mismatch behavior
are public protocol surface. A pull request changing any of them must include:

- a concrete failure or measured opportunity;
- deterministic safety and compatibility tests;
- an updated protocol specification and documentation;
- before/after wire-size measurements;
- migration notes when existing transcripts or configuration are affected.

Do not replace fail-closed behavior with fuzzy matching merely to improve a success-rate benchmark.

## Benchmarks

Benchmark pull requests must pin fixtures, seeds, OpenCode and plugin revisions, runtime versions,
and model snapshots where applicable. Preserve raw results and report failures, retries, and
unintended changes rather than success-conditioned averages.

## Commits

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`. Release
automation uses these commits to prepare the changelog.
