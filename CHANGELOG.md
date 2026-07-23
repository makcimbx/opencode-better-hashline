# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a redesigned, quick-start-oriented project README and a packaged Russian-language guide.

### Changed

### Fixed

## [0.6.1](https://github.com/makcimbx/opencode-better-hashline/compare/v0.6.0...v0.6.1) (2026-07-23)

### Added

- Added bounded aggregate issued-coverage diagnostics that report all missing line ranges plus required internal-neighbor, BOF, and EOF evidence while recommending conservative 1,000-line recovery reads.

### Changed

- Raised requested `hashline_read.limit` and text `readbackLimit` ceilings from 1,000 to 100,000 while retaining 1,000 defaults, one contiguous readback page, and authoritative byte pagination (`maxOutputBytes` defaults to 40 KiB and is capped at 45 KiB) with `@more` on byte-limited partial pages.
- Clarified that `replace` removes the exact inclusive range, `lines` is the complete replacement while outside neighbors remain, and every operation uses immutable original-snapshot coordinates rather than sequential batch coordinates.
- Made snapshot page rendering linear in emitted content. The expanded public schemas and descriptions intentionally change raw/projected schema identities and the native-alias fingerprint while retaining the `native-aliases/v2` marker.

### Fixed

- Fixed offline evidence to accept OpenCode 1.18.4's exact interrupted `unknown` cleanup shadow, while native-alias live admission now uses delivered and attested process-local epochs without fetching persisted history.
- Fenced candidate and snapshot authority so same-identity reads may reuse the current candidate, differing fingerprint/worktree preparation retires active authority, and stale, reordered, or ABA completions cannot bind or revive old IDs.
- Fixed partial move and parent publication to invalidate affected snapshots and unbind the live epoch instead of permanently poisoning it; after path repair, a fresh delivered read recovers in the same OpenCode task without reviving old snapshot IDs.
- Fixed lifecycle readback-window arguments to return lifecycle-specific errors even without `readback:true`, and aligned native-alias descriptions, complete path-set concurrency guidance, and current documentation with the live runtime.

## [0.6.0](https://github.com/makcimbx/opencode-better-hashline/compare/v0.5.0...v0.6.0) (2026-07-22)

### Added

- Add text-only `readbackOffset` and `readbackLimit` controls for one contiguous post-edit successor page, with one-based/default-first-hunk addressing, a `1..1000`/default-1000 limit, and delivered-page-only issuance without an ID-only successor.
- Add explicit `hashline_write.createParents` support for at most 64 missing directories through one deepest-ancestor plan, complete directory/target authorization and locking, exclusive root-to-leaf creation, staged no-clobber file publication, and no-rollback `PARTIAL_PUBLICATION` after a directory exists or creation becomes ambiguous.
- Add schema-v7 deterministic methodology and an immutable write-once result for the expanded 29-case corpus, edit/write schemas, readback call, and parent-creation call.
- Add sole snapshot-bound `delete_file` and no-clobber `move_file` operations with exact-byte freshness, complete issued BOF-to-EOF source coverage, direct regular single-link sources, source authorization, and, for moves, dual-path authorization plus an absent destination under a stable existing parent on the same filesystem.
- Add the two-task `file-ops-v1` deterministic model manifest and current `native-aliases-v2` adapter identity without making a paid model claim.
- Add model-free schema-v6 lifecycle operation-schema and compact call-wire fixtures, retained in a new immutable result without rewriting the schema-v5 evidence.

### Changed

- Permit one `move_range` to compose with pairwise-disjoint replacements wholly inside its intervening corridor and outside its source while retaining full-corridor freshness/issuance, positional EOL validation, and conservative rejection of every other conflict.
- Append deterministic zero-based operation-pair evidence to overlap and insertion-boundary diagnostics without changing their stable error codes, and shorten complete-snapshot recovery guidance to one full reread from `offset=1` through `@eof`.
- Keep the `native-aliases/v2` marker name while changing the canonical schema SHA/fingerprint for the expanded tool contracts; prior v2 sessions fail closed and require a restart plus a new session.
- Record current schema-v7 development values: adversarial counts strict `6/18/5/0`, unique `11/18/0/0`, exact search `10/13/1/5`, line numbers `7/1/0/21`, endpoint-8 `7/12/4/6`, endpoint-16 `7/13/4/5`; edit schema `3686 -> 5033` (+1347, 36.54%); write schema `282 -> 548` (+266, 94.33%); readback call `181 -> 218` (+37); and parent-create call `50 -> 81` (+31). Existing lifecycle, transfer, corridor, and static values are unchanged.
- Remove the completed native-alias preview plan and superseded pre-v7 incident records while retaining the final pilot evidence and closed-ID safety rules.
- Upgrade native-alias history and metadata to `native-aliases/v2`, binding each result to exact `update`, `delete_file`, or `move_file` operation identity and move destination correlation; v1 history now fails closed.
- Plan file lifecycle operations separately from pure text `planEdits`, approve one immutable exact patch/metadata result before reread and publication, and serialize overlapping source/destination path sets while allowing disjoint sets to progress.
- Keep retained schema-v5 and pilot-v7 evidence immutable and scoped to the earlier text-operation contract; neither result covers the new lifecycle task or adapter identity.
- Keep the retained schema-v6 lifecycle result and pilot-v7 scope immutable; retain schema-v7 separately as model-free mechanical evidence without a paid or model-quality claim.

### Fixed

- Canonicalize renderer, permission, and verifier roots through physical worktree identities so macOS `/var` aliases and Windows 8.3/case aliases retain correct relative paths.
- Reject Windows alternate-data-stream path separators before permission or staging, classify ambiguous first-directory creation as `PARTIAL_PUBLICATION`, keep partial errors free of private canonical paths, and poison native-alias sessions after partial parent publication.
- Explain exact selected-range EOL-only changes after failed unique relocation while preserving `TARGET_CHANGED` and making no normalization, fuzzy-match, or fallback change.
- Report post-link move failures as `PARTIAL_PUBLICATION`, invalidate source and destination snapshots, poison the bound alias session, and require inspection plus a new session instead of attempting an unsafe rollback.
- Preserve safe native-alias session-history failure categories, recover bounded transient fetches under one total deadline, and distinguish retryable host failures from oversized histories that require a genuinely new task ID.

## [0.5.0](https://github.com/makcimbx/opencode-better-hashline/compare/v0.4.0...v0.5.0) (2026-07-22)

### Added

- Add a project-local OpenCode configuration that loads the working-tree plugin in enforced `native-aliases` mode for dogfooding.
- Add `INSERTION_BOUNDARY_CONFLICT` so duplicate insert/copy destinations are distinguishable from spatial overlap.
- Add `@hashline-edit` lifecycle receipts that distinguish consumed snapshots with attached, absent, or unavailable successors.

### Changed
- Mark incomplete snapshot pages and bounded readbacks with `partial=true`, clarify cumulative issued coverage, and provide actionable reread guidance.
- Clarify that `unique` relocates only still-retained snapshots after external changes.
- Permit concurrent native-alias calls for independent files only after exact process-local session binding; unbound and same-path calls remain serialized.
- Report exact display-prefix coordinates with bounded numeric evidence, recognize lifecycle markers, and reserve `allowHashlinePrefixes` for intentional source bytes in the initial call.
- Verify native-alias prefix rejection and restart recovery through two real pinned OpenCode processes during `pack:check`.

### Fixed
- Classify mixed `replace_file` batches as `INVALID_ARGUMENT` instead of spatial overlap.
- Persist native-alias `DISPLAY_PREFIX_REJECTED` recovery as an exact worktree-bound, completed non-mutating terminal result on supported OpenCode hosts.
- Measure actual projected hashline and native-alias provider contracts instead of a hybrid schema fixture.

## [0.4.0](https://github.com/makcimbx/opencode-better-hashline/compare/v0.3.2...v0.4.0) (2026-07-21)

### Added

* add attested edit readback ([#25](https://github.com/makcimbx/opencode-better-hashline/issues/25)) ([a2edb86](https://github.com/makcimbx/opencode-better-hashline/commit/a2edb868af31796fdbc1d5d0c8cd7566ba739981))

## [0.3.2](https://github.com/makcimbx/opencode-better-hashline/compare/v0.3.1...v0.3.2) (2026-07-21)

### Fixed

* sync curated release notes ([#23](https://github.com/makcimbx/opencode-better-hashline/issues/23)) ([d30b291](https://github.com/makcimbx/opencode-better-hashline/commit/d30b29140b1b5a1455ab43393d1eadc7fdc6061f))

## [0.3.1](https://github.com/makcimbx/opencode-better-hashline/compare/v0.3.0...v0.3.1) (2026-07-21)

### Fixed

* support compatible OpenCode versions ([#21](https://github.com/makcimbx/opencode-better-hashline/issues/21)) ([d233318](https://github.com/makcimbx/opencode-better-hashline/commit/d233318c70a50bea20837c9dbab13ca2007a7058))

## [0.3.0](https://github.com/makcimbx/opencode-better-hashline/compare/v0.2.1...v0.3.0) (2026-07-21)

### Added

- Add an explicit experimental `native-aliases` tool surface for exact OpenCode 1.18.3, with bounded host detection, session protocol binding, native renderer metadata, and fail-closed diagnostics.
- Add a credential-free packaged verifier covering unique, non-GPT `edit`, and GPT-like `apply_patch` routes through stock OpenCode, including malformed calls, hooks, continuation, export/import, and renderer evidence.
- Add deterministic collision fixtures and a separate `native-aliases-v1` paired-model adapter set with protocol-marker and malformed-retry trace metrics.
- Record the failed-closed native-alias pilot v1, v3, v4, v5, and v6 incidents plus the successful privacy-safe pilot v7 summary; no model-superiority claim is made.
- Add a fail-closed benchmark oracle that correlates persisted history with JSONL, physically confines exact files, records per-file mutation provenance, and exercises a privacy-safe pilot-v1 topology fixture without model calls. The fixture declares but cannot independently prove the retained private trace hash.

### Changed

- Keep the unique `hashline` surface as the default while routing all edit IDs through one snapshot-bound executor and capping native renderer metadata before permission or publication.
- Retire unexecuted pilot v2 and permanently close consumed pilots v3, v4, v5, and v6 after their fail-closed sessions; none may resume or retry.
- Complete pilot v7 on Luna and Sol: all 48 paired sessions passed with 181 observed requests, complete accounting, zero retries/failures/timeouts, and USD 0 reported cost. The maintainer approved an opt-in experimental release; `hashline` remains the default.

### Fixed

- Bound native-alias current-call history stabilization to exact repeated reads of one call ID, tool, and input, preventing an OpenAI Responses persistence race from becoming a false session-protocol rejection without accepting stale or cross-file input.
- Bind creation-only native-alias evidence to exact export/history/ledger checks without requiring an edit protocol marker, and ensure create-file fixtures contain the parent directory required by create-only `hashline_write`.
- Keep mutation-ledger snapshot provenance path-scoped and accept idempotent rereads of the same unchanged file snapshot while rejecting cross-file snapshot reuse.

## [0.2.1](https://github.com/makcimbx/opencode-better-hashline/compare/v0.2.0...v0.2.1) - 2026-07-19

### Fixed

- Describe every operation-specific field combination in the flat provider schema, including that `finalNewline` is exclusive to `replace_file` and that empty `lines` are invalid for `insert`.
- Keep omitted `rebase` optional in generated JSON Schema, expose payload and move constraints, and align malformed-operation diagnostics across validation layers.

## [0.2.0](https://github.com/makcimbx/opencode-better-hashline/compare/v0.1.1...v0.2.0) - 2026-07-19

### Added

- Add snapshot-bound `copy_range` and `move_range` operations with immutable coordinates, issued-source authority, mixed-batch conflict analysis, and exact-unique multi-anchor relocation.
- Add a separately versioned eight-task `transfer-v1` model-development manifest without changing the 12-task baseline.
- Add deterministic transfer safety cases plus operation-call, provider-schema, and move-corridor wire evidence.

### Changed

- Preserve released legacy payload-limit precedence and overlap diagnostics while making transfer-batch conflict diagnostics independent of operation order.
- Make the flat provider-level `lines` field optional while retaining operation-specific runtime requirements for all existing payload operations.
- Preflight projected byte and logical-line limits before materializing transfer output.
- Reject blank-line moves that cannot preserve logical text and positional EOL slots under CRLF/no-phantom parsing instead of normalizing their byte layout.

## [0.1.1](https://github.com/makcimbx/opencode-better-hashline/compare/v0.1.0...v0.1.1) - 2026-07-18

### Added

- Exercise packed-package snapshot issuance and editing through a deterministic local OpenCode session with no external model call.
- Record an immutable 21-scenario adversarial corpus and reproducible long-line rendering wire-size evidence.

### Fixed

- Reject contradictory exact-context evidence during explicit `unique` relocation instead of selecting a duplicate by context-search order.
- Reject surviving duplicate targets, copied boundary pairs, and copied BOF/EOF evidence unless exact context identifies the selected base occurrence.
- Preserve previously issued snapshot refs when a later pending page expires, is truncated, loses its marker, or is changed by another hook.
- Preserve independent pending pages that reuse a snapshot when another page loses its private delivery marker.
- Validate complete custom-tool arguments inside each executor so direct or hook-mutated calls fail with `INVALID_ARGUMENT` before filesystem work.
- Reject invalid coordinates, overlaps, and mixed whole-file batches before requesting external-directory permission.
- Verify create-only publication identity, link count, bytes, and parent after the no-replace hard link, with stable filesystem errors and no destructive rollback.
- Report post-link cancellation and staging-cleanup failures as `RACE_AFTER_WRITE` without destructive rollback.

### Changed

- Issue complete lines according to the configured UTF-8 output-byte budget instead of an unrelated 2,000-character cutoff.
- Bound unique-relocation search by compared token length rather than treating arbitrarily long string comparisons as constant work.
- Clarify that the deterministic exact search/replace comparator is target-only and does not establish an addressing-format advantage.
- Support literal `[]{}!` path characters and POSIX `*?` names without persisting unsafe wildcard permission rules.
- Reject POSIX-only `*?` filename characters on Windows before any permission request.

## [0.1.0] - 2026-07-18

### Added

- Snapshot-bound `hashline_read`, `hashline_edit`, and create-only `hashline_write` tools.
- Exact-byte stale checks, issued-range provenance, conservative unique relocation, native permissions, and staged publication.
- Cross-platform tests, adversarial protocol benchmarks, static-size measurements, microbenchmarks, and an opt-in paired model harness.
- Architecture, protocol, threat-model, research, benchmark, contribution, security, support, and release documentation.
- Pinned GitHub Actions for CI, dependency review, CodeQL, benchmarks, Release Please, and npm OIDC publication.
