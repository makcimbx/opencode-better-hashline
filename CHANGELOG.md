# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
