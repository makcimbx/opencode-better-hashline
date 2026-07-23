# Repository Instructions

## Commands

- Use Bun 1.3.14 and `bun install --frozen-lockfile`; do not introduce `package-lock.json`.
- `bun run check` is non-mutating typecheck, Biome CI, and documentation-link validation.
- Run one file with `bun test tests/plugin.test.ts`; pass multiple test paths for a focused safety suite.
- Before a PR, run `bun run format`, then `bun run ci` (`check -> coverage -> build`).
- Run `bun run pack:check` after package exports, build, hooks, dependencies, or packed files change. It tests the real tarball through pinned OpenCode 1.18.4.
- `bun run release:pack` additionally retains an ignored `.tgz`; use it only for release work.

## Architecture And Invariants

- `src/index.ts` is the public library entry, `src/server.ts` is OpenCode's preferred `./server` entry, and `src/cli.ts` is the verifier bin. Keep the explicit import/default export in `server.ts` and all three separate Bun build invocations; collapsing entry builds previously produced an invalid bundle.
- Protocol and shared evidence logic stays pure or bounded in `text.ts`, `snapshots.ts`, `render.ts`, `rebase.ts`, `edits.ts`, `presentation.ts`, `session-protocol.ts`, `session-export.ts`, `model-trace.ts`, `path-identity.ts`, `process-capture.ts`, and `exact-tree.ts`; filesystem authorization/publication belongs in `filesystem.ts`; OpenCode schemas and hooks belong in `plugin.ts`.
- Keep `.js` specifiers in TypeScript imports. Do not edit generated `dist/` or `coverage/`.
- Snapshot refs become editable only in `tool.execute.after`, after host truncation and output-digest checks. Retained or pending bytes are not issued provenance.
- Exact retained bytes are freshness authority. `rebase: "none"` stays strict by default; `"unique"` is explicit, exact, and ambiguity-rejecting. Do not add fuzzy matching, normalization, nearest-match selection, source repair, or silent fallback.
- `replace` removes the exact one-based inclusive `startLine..endLine` range; `lines` is the complete replacement, and outside neighbors remain. Every batch coordinate refers to the immutable original snapshot, never to an intermediate result or a line created by another operation.
- For sole strict `replace_file`, omitted `finalNewline` preserves snapshot state when `lines` is non-empty, while `lines: []` infers `false`; explicit `true` with an empty payload is invalid.
- Preserve stable overlap/boundary error codes and deterministic zero-based operation-pair diagnostic suffixes. One `move_range` may compose only with pairwise-disjoint replacements wholly inside its intervening corridor and outside its source; all other conflicts remain conservative.
- Text readback is one optional contiguous successor page. For text edits, `readback:true` or either window field requests it; a window with explicit `readback:false` is invalid. Lifecycle operations reject `readback:true` and all windows. Only an after-hook-attested delivered page issues refs, and there is no ID-only successor.
- Keep `hashline` as the default unique-ID surface and native `read`. Experimental `native-aliases` requires `enforce:true`, compatible host capabilities, exact observed-version/schema/worktree identity, a process-local live epoch established only by a delivered and attested `hashline_read`, and no silent fallback; it never aliases native `write`, and both source and destination mutations must remain inside the current worktree. Neither surface is a shell sandbox.
- Keep the native-alias marker name `native-aliases/v2`, but treat every schema SHA/fingerprint change as live-epoch-incompatible. Restart as required and use a fresh delivered `hashline_read` to rebind in the same session; old snapshot IDs remain unusable.
- Live alias edit admission never fetches persisted history. It requires the exact bound epoch and a delivered snapshot, and rejects unbound or mismatched mutation until a fresh delivered same-session read.
- Same-fingerprint/worktree reads may reuse the current candidate authority. Preparing a differing identity retires active authority; only the current candidate delivered and attested by `tool.execute.after` may commit. Snapshot authority must equal the active authority, so stale, reordered, or ABA completions cannot bind or revive old IDs.
- Persisted-history validation and bounded active-call stabilization belong only to offline verifier, model-trace, and evidence paths. Never use them to bind live edits or substitute fuzzy, cross-ID, or stale-input correlation.
- Preserve the filesystem order: canonicalize and authorize, plan one immutable result, approve that exact diff, reread bytes/identity, then stage and publish. Never replan after approval.
- File lifecycle operations stay sole, strict, complete-coverage mutations outside `planEdits`. Delete revalidates a direct single-link source; move is no-clobber and same-filesystem with pinned parents, deterministic two-path locks, explicit `PARTIAL_PUBLICATION`, and no rollback that could delete a raced path.
- `hashline_write` is strict and accepts only `filePath` and `content`; the obsolete `createParents` field is rejected. It always freezes a plan from the deepest existing ancestor and automatically creates at most 64 missing directories. Authorize and lock every planned directory plus the target, create missing directories root-to-leaf with exclusive non-recursive `mkdir`, then use staged no-clobber file publication; with zero missing directories, publish directly through that same path. After the first directory exists or a `mkdir` outcome becomes ambiguous, fail as `PARTIAL_PUBLICATION` without rollback. `move_file` never creates parents.
- Partial move or parent publication invalidates affected snapshots and unbinds the native-alias live epoch. After inspecting and repairing paths, a fresh delivered `hashline_read` may rebind in the same session; old snapshot IDs never revive.
- No Better Hashline failure or resource limit requires abandoning the OpenCode transcript or task ID. Recover in the same task according to the error: retry only when explicitly safe, take a fresh delivered read, inspect and reconcile partial publication before retrying, repair paths/configuration, restart the plugin or host as applicable and reread, or explicitly switch configuration to enforced `toolSurface:"hashline"`; this is never a silent fallback, and old snapshot IDs are not reused. This invariant is scoped to Better Hashline and does not cover loss of OpenCode's own session database.
- OpenCode may swallow plugin initialization failures. Option errors must retain diagnostic fail-closed mode rather than escaping initialization.
- Keep public tool schemas flat/provider-friendly; validate operation-specific field combinations at runtime instead of adding union-heavy schemas.
- Tool schemas, rendering, defaults, mismatch behavior, recovery text, and normalization are public protocol surface. Apply `docs/tool-contract-guidelines.md`; changes require deterministic tests plus updates to `docs/protocol.md`, and must follow `CONTRIBUTING.md` for wire-size and migration evidence.

## Tests And Benchmarks

- Coverage thresholds are 90% and can fail for an individual included source file even when aggregate coverage passes.
- Filesystem and plugin tests cover authorization, races, host hooks, and fail-closed behavior; update them when those paths change.
- `bun run bench` is deterministic but result paths are write-once. Never `--force` published evidence; add a new dated result.
- The current deterministic runner uses schema v8 and has a retained write-once model-free result. Keep schema-v5, schema-v6, schema-v7, schema-v8, and pilot-v7 evidence immutable; make no paid or model-quality claim from deterministic output.
- `bun run bench:model` is a no-cost dry run. `--preflight` performs installs/writes but no model call. Never use `--execute` without explicit user approval, a model/auth source, and `BENCHMARK_ACK_COSTS=yes`.
- The frozen native-alias pilot v7 completed 48/48 sessions. Every pilot ID through v7 is closed and may never resume or retry. A new pilot identity is created only after a paid launch consumes its durable reservation, never for pre-reservation failures or ordinary development findings. Never treat development probes, deterministic checks, or packed evidence as the paid release gate.

## Fast Benchmark Development

- Iterate with focused tests and batch related fixes. Do not rerun full CI, pack checks, audits, or approval preparation after every small finding.
- Before candidate A, run an exhaustive model-free task x adapter evidence matrix and one full development rehearsal of the complete proposed model/task/adapter schedule. Rehearsals use write-once ignored outputs, explicit request/cost bounds, and no pilot reservation.
- Candidate A is forbidden until the full rehearsal passes. Then run one consolidated independent audit, remediate its findings, and run the final verifier/CI/pack matrix once on the unchanged tree.
- Build external bundle B and anchor-only commit C only after candidate A and its clean eligible preflight are final. Do not rebuild approval evidence while implementation or schedule bytes are changing.
- Parallelize independent checks and per-model rehearsals. Communicate only material blockers, terminal outcomes, and evidence changes.
- Ignored local preflights, raw pilot outputs, and development-probe results are temporary. Delete them before candidate A after diagnosis; retain only publishable deterministic evidence and the privacy-safe terminal result needed for the current release decision.

## Workflow

- Use Conventional Commit prefixes; Release Please derives versions and changelog entries from them.
- For every user-visible change, update `CHANGELOG.md` under `## [Unreleased]` in `Added`, `Changed`, or `Fixed` in the same PR. The release workflow promotes these entries into release PR and GitHub Release notes; Conventional Commit notes are only the fallback.
- `main` is protected; normal changes land through reviewed PRs with required checks.
- The `v0.1.0` bootstrap is complete. Future npm releases go only through the Release Please workflow and `npm-release` OIDC environment. Do not add `NPM_TOKEN`, manually republish, retag, or overwrite a version.
