# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

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
