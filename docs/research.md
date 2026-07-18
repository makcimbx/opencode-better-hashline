# Hashline Research and Prior Art

Audit date: 2026-07-18. Findings are tied to the linked commits, issues, and pull requests; upstream behavior can change.

## Origin and Evolution

Can Boluk introduced the coding-agent Hashline format in oh-my-pi in February 2026 and explained the motivation in [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/). The original family displayed a small line hash beside each line. Current oh-my-pi instead uses a short normalized whole-file tag, retained snapshots, and richer operations.

The useful idea is compact, model-copyable addressing. The unsafe leap is treating a small checksum as proof of current identity.

## Audited Implementations

| System | Useful ideas | Observed limitation relevant here |
| --- | --- | --- |
| [oh-my-pi](https://github.com/can1357/oh-my-pi/tree/3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0/packages/hashline) | Whole-file snapshots, provenance, recovery, rich operations | 16-bit normalized file tag can collide; writes across files are sequential |
| [oh-my-pi issue #4024](https://github.com/can1357/oh-my-pi/issues/4024) | Public collision reproduction | Two distinct files shared tag `1D84`; stronger handling remains under [PR #4038](https://github.com/can1357/oh-my-pi/pull/4038) |
| [OpenCode PR #13405](https://github.com/anomalyco/opencode/pull/13405) | Small line-address format integrated into native tools | 8-bit whitespace-insensitive hashes, truncated-line hashing, request-order mutation, stale retry and EOL/BOM defects |
| [OpenCode PR #14677](https://github.com/anomalyco/opencode/pull/14677) | Better prevalidation, permissions, BOM/EOL work, bottom-up edits | 8-bit tags, endpoint-only spans, overlap/boundary gaps, heuristic source repair, provider-heavy union schema |
| [AngDrew/opencode-hashline](https://github.com/AngDrew/opencode-hashline) | Plugin approach and translation layer | Relies on before-hook argument reassignment affected by [OpenCode #31680](https://github.com/anomalyco/opencode/issues/31680), then lowers to native fuzzy whole-file replacement |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | Strong prevalidation and active ecosystem integration | Optional after schema/model failures; 8-bit IDs, repair heuristics, endpoint gaps, no external-writer CAS |
| [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) | Snapshot replay, conflict checks, queue, temp replacement, telemetry | Short context hashes and endpoint-only range validation remain |
| [pi-hashline-readmap](https://github.com/coctostan/pi-hashline-readmap) | Extensive read-map tests | Deliberately permissive/fuzzy and no external CAS |
| [pi-anchor-edit-core](https://github.com/T50-Systems/pi-anchor-edit-core/tree/63d60de890e6edbf0c42f7c7b809c2a51358fca6) | Strong SHA-256 destination validation, inode/mode checks, exclusive temp, fsync | Correctly documents residual race; consuming integrations may pin older core versions |
| [Dirac](https://github.com/dirac-run/dirac) | Task-scoped opaque word anchors and Myers identity reconciliation | Duplicate ambiguity, source-prefix handling, cache questions, and no established external CAS |

OpenCode stable 1.18.3 and development commit `fab213312927ea64cf968832c527206e8c944f9e` had no merged native Hashline implementation at audit time. Both core proposals above were closed unmerged.

## Repeated Failure Modes

### Short hashes used as authority

For `b` bits, a fixed changed target falsely passes with probability `1 / 2^b`. For `L` independently distributed identities, the probability of any collision is approximately:

```text
1 - exp(-L(L - 1) / (2 * 2^b))
```

At 1,000 identities, this is about 99.95% for 16 bits. Width and what is normalized matter more than whether the digest function is fashionable.

### Endpoint-only validation

Checking the first and last row of a multiline range says nothing about changed interior rows. It also fails to define overlap and multiple insertion behavior.

### Read-to-write TOCTOU

Retained snapshots detect model staleness but do not stop an editor, formatter, second agent, or daemon from changing the destination during permission approval or publication.

### Heuristic repair

Stripping copied prefixes, normalizing whitespace, auto-indenting, applying the nearest match, or continuing after a failed block can turn a malformed model call into a syntactically valid wrong edit. Better Hashline rejects these cases and requires an explicit retry.

### Provider-incompatible schemas

Large unions, optional discriminator combinations, and wrapper-specific argument rewriting have failed on some model providers. Better Hashline uses one flat operation shape with bounded primitive fields, validates operation-specific combinations at runtime, and tests the actual OpenCode tool definitions.

### Partial mutation

Sequential multi-file or multi-block application often leaves committed prefixes after a later failure. Better Hashline composes one file in memory and attempts one replacement, while explicitly declining a multi-file atomicity claim.

## Other Agent Editing Systems

Exact unique search/replace, contextual patches, fuzzy diff application, whole-file generation, and checksum-based daemon APIs each make different tradeoffs:

- Claude-style exact unique `old_string` is a strong local textual-CAS baseline.
- Codex/OpenCode contextual patch matchers can progressively relax matching and select a first candidate.
- Aider's SEARCH/REPLACE and simplified unified diff formats have strong historical model evidence but include permissive recovery paths.
- Qwen's workspace daemon is a strong filesystem reference: full SHA-256, unique old text, canonical-path mutex, workspace/symlink checks, limits, same-directory temp rename, and audit events.
- Git blob identity and three-way apply illustrate stronger revision binding than tiny line tags.

No transport alone solves authorization, semantic conflict, crash behavior, and external concurrency. These dimensions must be measured separately.

## Evidence Quality

Can's original 180-task, 16-model study reported Hashline gains for 14 of 16 models, roughly 15 aggregate points, and lower output tokens. It also found regressions for some models and is author-produced evidence.

An independent [Hashline vs Replace benchmark](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html) found worse Python results, roughly neutral TypeScript, and slightly better Rust over a much smaller three-model corpus. Older [Aider edit-format results](https://aider.chat/docs/benchmarks.html) favored simplified unified diffs for GPT-4-era models.

These results do not establish a universal winner. Harness quality, model snapshot, tool schema, baseline fidelity, task language, retry policy, and success evaluator can dominate the edit format itself.

## Decisions Taken Here

- Random opaque snapshot ID plus exact retained bytes and SHA-256.
- Native line numbers without production per-line hashes.
- Entire issued range and insertion-boundary provenance.
- Strict default; exact unique recovery is explicit.
- No fuzzy matching, normalization, source repair, or successful partial blocks.
- Standard OpenCode permissions with the exact planned diff.
- Canonical-path lock, post-permission reread, same-directory temp, and post-write verification.
- Stable error codes and conservative unsupported-file policy.
- Deterministic adversarial benchmarks before paid model claims.

## Related Evaluation Work

Useful broader references include SWE-agent's Agent-Computer Interface work, EDIT-Bench, CanItEdit, Diff-XYZ, SWE-Edit, AdaEdit, CodeStruct, and Aider's edit-format studies. Any future imported corpus must pin its revision, checksum, license, evaluator, and contamination assumptions.
