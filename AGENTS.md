# Repository Instructions

## Commands

- Use Bun 1.3.14 and `bun install --frozen-lockfile`; do not introduce `package-lock.json`.
- `bun run check` is non-mutating typecheck, Biome CI, and documentation-link validation.
- Run one file with `bun test tests/plugin.test.ts`; pass multiple test paths for a focused safety suite.
- Before a PR, run `bun run format`, then `bun run ci` (`check -> coverage -> build`).
- Run `bun run pack:check` after package exports, build, hooks, dependencies, or packed files change. It tests the real tarball through pinned OpenCode 1.18.3.
- `bun run release:pack` additionally retains an ignored `.tgz`; use it only for release work.

## Architecture And Invariants

- `src/index.ts` is the public library entry and `src/server.ts` is OpenCode's preferred `./server` entry. Keep the explicit import/default export in `server.ts` and the two separate Bun build invocations; collapsing either previously produced an invalid bundle.
- Protocol logic stays pure in `text.ts`, `snapshots.ts`, `render.ts`, `rebase.ts`, and `edits.ts`; filesystem authorization/publication belongs in `filesystem.ts`; OpenCode schemas and hooks belong in `plugin.ts`.
- Keep `.js` specifiers in TypeScript imports. Do not edit generated `dist/` or `coverage/`.
- Snapshot refs become editable only in `tool.execute.after`, after host truncation and output-digest checks. Retained or pending bytes are not issued provenance.
- Exact retained bytes are freshness authority. `rebase: "none"` stays strict by default; `"unique"` is explicit, exact, and ambiguity-rejecting. Do not add fuzzy matching, normalization, nearest-match selection, source repair, or silent fallback.
- Keep unique `hashline_*` IDs and native `read`. `enforce` hides and tripwires native `edit`, `write`, and `apply_patch`; it is not a shell sandbox.
- Preserve the filesystem order: canonicalize and authorize, plan one immutable result, approve that exact diff, reread bytes/identity, then stage and publish. Never replan after approval.
- OpenCode may swallow plugin initialization failures. Option errors must retain diagnostic fail-closed mode rather than escaping initialization.
- Keep public tool schemas flat/provider-friendly; validate operation-specific field combinations at runtime instead of adding union-heavy schemas.
- Tool schemas, rendering, defaults, mismatch behavior, and normalization are public protocol surface. Changes require deterministic tests plus updates to `docs/protocol.md`; follow `CONTRIBUTING.md` for wire-size and migration evidence.

## Tests And Benchmarks

- Coverage thresholds are 90% and can fail for an individual included source file even when aggregate coverage passes.
- Filesystem and plugin tests cover authorization, races, host hooks, and fail-closed behavior; update them when those paths change.
- `bun run bench` is deterministic but result paths are write-once. Never `--force` published evidence; add a new dated result.
- `bun run bench:model` is a no-cost dry run. `--preflight` performs installs/writes but no model call. Never use `--execute` without explicit user approval, a model/auth source, and `BENCHMARK_ACK_COSTS=yes`.

## Workflow

- Use Conventional Commit prefixes; Release Please derives versions and changelog entries from them.
- `main` is protected; normal changes land through reviewed PRs with required checks.
- The `v0.1.0` bootstrap is complete. Future npm releases go only through the Release Please workflow and `npm-release` OIDC environment. Do not add `NPM_TOKEN`, manually republish, retag, or overwrite a version.
