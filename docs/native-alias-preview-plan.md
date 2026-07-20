# Experimental Native-Alias Preview Plan

| Field | Value |
| --- | --- |
| Status | Pilot v1 stopped after session 1; release no-go; corrected pilot requires fresh approval |
| Plan version | 1.1 |
| Plan date | 2026-07-20 |
| Package baseline | `opencode-better-hashline@0.2.1` |
| Source baseline | `da94bef57bf6319779f024d446b0c26bf62918ba` |
| Initial host target | OpenCode `1.18.3` |

This document defines an optional Better Hashline tool surface that uses OpenCode's native
`edit` and `apply_patch` renderer IDs while retaining Better Hashline's snapshot-bound edit
executor. It does not change the current unique `hashline_*` tool IDs, runtime behavior,
support policy, or safety claims.

The purpose of the experiment is presentation compatibility: completed Better Hashline edits
should appear as native colored diff cards in the normal OpenCode session timeline. The proposed
mode is not display-only internally. Tool IDs are model-visible, persisted, replayed, filtered,
and used for permissions and client dispatch. The mode therefore requires a separate protocol,
threat model, test matrix, and model study.

## Goals

- Render completed Better Hashline edits through stock OpenCode's native inline diff cards.
- Keep exact snapshots, issued provenance, strict freshness, conservative unique relocation,
  immutable planning, normal edit permission, and staged filesystem publication unchanged.
- Keep the current unique-ID surface as the default and fully supported mode.
- Make the renderer-compatible surface explicit, opt-in, experimental, and removable.
- Reject native-shaped edit or patch arguments before permissions or filesystem access.
- Preserve model-family-independent, create-only `hashline_write` behavior.
- Establish exact host compatibility and fail closed when the requested surface is unavailable.
- Measure whether familiar native names increase malformed calls, retries, or tool loops before
  considering a public release.

## Non-Goals

- Do not call OpenCode's built-in edit, write, or patch executors.
- Do not alias `hashline_write` to native `write`.
- Do not expose unique and alias edit surfaces to a model at the same time.
- Do not add fuzzy matching, source repair, normalization, nearest-match selection, or silent
  fallback.
- Do not claim registry ownership that OpenCode cannot attest.
- Do not claim that alias mode has the same host-level fail-closed properties as unique IDs.
- Do not make alias mode the default based only on UI appearance.
- Do not run external or paid model calls without the repository's existing explicit approval,
  authentication, and cost gates.

## Current Evidence

### Source audit

OpenCode `1.18.3` loads built-ins and custom tools as separate definitions, then constructs the
session tool map by assigning each final ID in order. A later plugin definition can therefore
replace a built-in definition with the same ID. OpenCode also filters exact IDs by model family:

- GPT patch-mode routes retain `apply_patch` and remove `edit` and `write`.
- Other routes retain `edit` and `write` and remove `apply_patch`.

Native TUI, CLI, session-ui, sharing, and ACP presentation are selected by exact persisted tool
ID. Arbitrary custom metadata does not make `hashline_edit` use the native renderer.

The server plugin API does not expose executable-definition ownership, duplicate detection, a
renderer registry, or a display-only tool identity. Hooks receive a tool ID and arguments, not
the selected definition or owning plugin.

### Temporary feasibility probe

A model-free, isolated loopback-provider probe against stock OpenCode `1.18.3` completed 44
machine assertions:

- non-GPT requests exposed the custom `edit` definition exactly once;
- GPT-5-like requests exposed the custom `apply_patch` definition exactly once;
- provider requests contained only the Better Hashline-shaped schema;
- valid calls reached the custom executor through real before/execute/after lifecycle hooks;
- deliberately native-shaped calls rejected before filesystem access;
- JSONL output and session export retained alias IDs, inputs, outputs, titles, and metadata;
- CLI native rendering accepted both edit and patch metadata contracts;
- no external model, credential, repository write, Git change, or publication occurred.

This probe proves technical feasibility, not production eligibility. It used a minimal read-only
executor, a scripted provider, and noninteractive renderer captures. The repository's packed
implementation, interactive TUI, session-ui, collision cases, continuation, and real models still
require dedicated coverage.

## Decision

Research may proceed with an unpublished branch. Public support is conditional on every go/no-go
gate in this document.

The proposed option is deliberately named after the changed model/tool surface, not its visual
effect:

```ts
type BetterHashlineOptions = {
  toolSurface?: "hashline" | "native-aliases"
}
```

Default:

```json
{
  "toolSurface": "hashline"
}
```

Experimental request:

```json
{
  "enforce": true,
  "toolSurface": "native-aliases"
}
```

Names such as `nativePreview` are rejected because the option changes provider schemas,
persisted tool IDs, replay, filtering, permission visibility, and model behavior.

## Tool Surface Contract

| Surface | Model family | Exposed edit tool | Create tool | Native `write` |
| --- | --- | --- | --- | --- |
| `hashline` | All | `hashline_edit` | `hashline_write` | Hidden and tripwired |
| `native-aliases` | GPT patch-mode | `apply_patch` | `hashline_write` | Filtered and tripwired |
| `native-aliases` | Other | `edit` | `hashline_write` | Hidden and tripwired |

Both aliases invoke one shared Better Hashline executor. Neither invokes a built-in executor.
The executor continues to require `filePath`, `snapshotId`, and the flat, runtime-validated
operation array.

Alias mode does not register a second model-visible `hashline_edit`. Persisted historical
`hashline_edit` parts do not require the definition to remain registered for display or replay.
Switching surfaces requires a restart and a new session.

`hashline_read`, native `read`, and create-only `hashline_write` retain their unique IDs. Native
`write` is never reused because its overwrite semantics, model filtering, persisted identity, and
renderer behavior are incompatible with Better Hashline's create-only contract.

## Shared Executor

Implementation must first extract one behavior-preserving edit executor and separate tool
definition factories:

```text
hashline_edit ----+
edit -------------+--> executeSnapshotBoundEdit()
apply_patch ------+
```

The shared executor must preserve:

- strict top-level and operation-specific runtime validation;
- session/worktree/canonical-path snapshot binding;
- issued range, boundary, and complete-file provenance;
- strict default freshness and explicit exact unique relocation;
- simultaneous range-transfer semantics;
- copied-display-prefix protection;
- exact immutable diff planning before approval;
- standard OpenCode external/read/edit permissions;
- canonical-path process lock and post-approval reread;
- staged publication and post-write verification;
- snapshot consumption/invalidation behavior;
- stable protocol errors and output wording.

The behavior-preserving extraction must land separately from alias registration so regressions can
be attributed correctly.

## Native Renderer Metadata

### `edit`

Terminal TUI and CLI use `metadata.diff`. Session-ui additionally reads
`metadata.filediff`. The compact patch form avoids duplicating complete before/after files:

```ts
{
  diff: unifiedDiff,
  filediff: {
    file: canonicalAbsolutePath,
    patch: unifiedDiff,
    additions,
    deletions,
  },
  diagnostics: {},
  betterHashline: {
    protocol: "native-aliases/v1",
    packageVersion,
    schemaSha256,
    hostVersion,
    surface: "edit",
    canonicalPathSha256,
  },
}
```

### `apply_patch`

Native patch renderers consume `metadata.files`:

```ts
{
  files: [
    {
      filePath: canonicalAbsolutePath,
      relativePath: slashNormalizedWorktreeRelativePath,
      type: "update",
      patch: unifiedDiff,
      additions,
      deletions,
    },
  ],
  diagnostics: {},
  betterHashline: {
    protocol: "native-aliases/v1",
    packageVersion,
    schemaSha256,
    hostVersion,
    surface: "apply_patch",
    canonicalPathSha256,
  },
}
```

The alias executor remains single-file. It must not fabricate multi-file semantics merely because
the patch renderer accepts an array.

### Metadata properties

- Metadata is persisted and exported but is not replayed into subsequent model context.
- Metadata is not subject to the generic output truncation limit.
- Unsanitized export/share can disclose absolute paths and source diffs.
- Sanitized export behavior must be tested, not assumed.
- ACP classifies the alias as edit-kind but cannot construct native structured diffs from Better
  Hashline's snapshot operation schema.

### Preview size

Adding `filediff.patch` or `files[].patch` can serialize the same unified diff more than once.
Before release, deterministic wire/storage measurements must cover small, typical, and near-limit
edits.

If a bounded completed-card preview is required, it must be hunk-aware and explicit:

```ts
{
  previewTruncated: true,
  fullDiffSha256: "...",
  omittedHunks: 12,
}
```

The implementation must never cut UTF-8 or unified-diff syntax at an arbitrary byte boundary.
The exact full diff used for permission approval remains independent from any display preview.
Preview limits must never change planned or published bytes.

## Activation And Host Gating

Alias mode may activate only when all conditions hold:

| Condition | Failure behavior |
| --- | --- |
| `enforce === true` | `CONFIG_INVALID` diagnostic mode |
| Host version is detectable | `TOOL_SURFACE_UNAVAILABLE` |
| Host version is explicitly allowlisted | `TOOL_SURFACE_UNAVAILABLE` |
| Alias schemas and protocol fingerprint are available | `TOOL_SURFACE_UNAVAILABLE` |
| Session protocol is compatible | `SESSION_PROTOCOL_MISMATCH` |
| No dual surface is requested | `CONFIG_INVALID` |

The initial allowlist contains only OpenCode `1.18.3`. Compatibility is not inferred from
`engines.opencode`. Each additional host version needs source review, packed-host integration, and
renderer fixtures.

The plugin receives `serverUrl`; version discovery can use the host health route with a bounded
timeout. The stable root SDK does not expose a convenient typed health method. Health failure,
unexpected response, or unknown version must leave the loaded plugin in diagnostic fail-closed
mode rather than silently selecting unique or native tools for the same session.

This gating cannot protect a complete module import/factory failure because absent plugin code
cannot hide or tripwire built-ins. That is an existing documented OpenCode boundary and is more
misleading for native-looking aliases.

## Hook Semantics

### Normal user messages

Unique mode remains unchanged:

```text
edit=false
write=false
apply_patch=false
```

Alias mode sets only inactive/dangerous IDs false:

```text
write=false
hashline_edit=false
```

The plugin must not force `edit` or `apply_patch` true. User, agent, and session-level restrictions
remain authoritative. OpenCode's own model filtering leaves exactly one alias for supported model
families.

### Before hook

Unique mode continues to reject all literal native mutator IDs.

Alias mode performs a second strict parse for `edit` and `apply_patch`, verifies the session
protocol fingerprint, and allows execution only for Better Hashline-shaped input. It always rejects
literal `write`.

Executor entry repeats strict parsing. The provider schema and host validation are not a security
boundary. The temporary probe proved that raw malformed input can reach a custom executor in
OpenCode `1.18.3`.

### Synthetic and compacted turns

Some synthetic continuation paths bypass `chat.message`. The unconditional before-hook remains the
mutation authority. A message transform may reapply visibility suppression for model UX, but
safety cannot depend on that transform.

## Session Protocol And Audit Metadata

Alias mode persists native-looking IDs. Each successful result must therefore include a Better
Hashline marker containing at least:

```text
package version
protocol version
schema hash
tool surface
host version
canonical path digest or display-safe path metadata
```

The marker is diagnostic, not cryptographic ownership proof. Another trusted same-process plugin
can spoof it.

A process-local map binds `sessionID` to one protocol fingerprint. A surface or schema change in
the same process returns `SESSION_PROTOCOL_MISMATCH`.

Before the first alias execution in a resumed session, the plugin should inspect completed
historical `edit` and `apply_patch` parts. Any unmarked native call, conflicting marker, ambiguous
history, or unreadable session state rejects and requests a new session. The check must ignore the
currently pending call and must be bounded.

After process restart, snapshots are unavailable regardless of history, so every edit still
requires a fresh `hashline_read`.

Historical calls are not re-executed during replay. If the plugin is later absent, old Better
Hashline alias cards remain visually native while new calls resolve to actual native definitions.
This cannot be repaired by an absent plugin and must be prominent in the option warning.

## Permissions And Configuration

Both alias IDs map to OpenCode's `edit` permission. Better Hashline continues to request that
permission for the canonical path and exact planned diff.

Important host behavior:

- terminal `permission.edit: deny` hides `edit`, `write`, and `apply_patch`, including aliases;
- path-specific edit denies leave the alias visible but reject the later exact permission request;
- literal `permission.write` or `permission.apply_patch` settings do not replace the actual edit
  permission used by the executor;
- per-message tool disabling is turn-local visibility, not an ownership or permission guarantee;
- subagent and resumed-session permissions have different inheritance paths.

Alias documentation and verification must report the effective edit permission. It must not
rewrite user permissions merely to make the preview work.

## Collision And Ownership Boundary

OpenCode `1.18.3` has no final executable owner or schema attestation. Effective order is:

1. built-ins;
2. directory/config tools;
3. configured plugin tools in resolved order;
4. MCP insertion, normally under namespaced IDs;
5. final assignment by ID.

A conventional later native-schema collider is blocked by Better Hashline's strict before-hook.
A later executor intentionally accepting the same Better Hashline schema cannot be distinguished
or proven safe. A later after-hook can also mutate output or throw after publication.

Current project policy already treats same-process plugins as trusted and states that `enforce` is
not a plugin or shell sandbox. Alias mode adds an operational precondition:

- Better Hashline is the last external plugin defining `edit` or `apply_patch`;
- no local custom tool defines those IDs after effective config merging;
- no untrusted same-process plugin is installed;
- users rerun model-free verification after any plugin/config/host change.

The plugin can inspect resolved config and reject obvious ordering violations, but it cannot prove
final registry ownership. Public documentation must not imply otherwise.

## Verification Command

The package should eventually provide a model-free command such as:

```powershell
bunx opencode-better-hashline verify --surface native-aliases
```

It should use isolated files and a loopback scripted provider to verify:

- exact OpenCode version;
- effective non-GPT `edit` schema and executor;
- effective GPT-like `apply_patch` schema and executor;
- strict rejection of native-shaped arguments before filesystem access;
- absence of exposed native `write`;
- before/after hook execution;
- renderer metadata shape;
- session export protocol marker;
- package and schema fingerprints;
- no mutation outside the disposable fixture.

Verification reduces configuration mistakes but does not create continuous host ownership or fix a
later runtime/config change.

## Error Surface

New stable errors proposed by the experiment:

| Code | Meaning |
| --- | --- |
| `TOOL_SURFACE_UNAVAILABLE` | Requested alias surface is unsupported or cannot be verified |
| `SESSION_PROTOCOL_MISMATCH` | Session history/fingerprint does not match the active alias protocol |

Existing errors remain authoritative:

- `CONFIG_INVALID` for invalid option combinations;
- `INVALID_ARGUMENT` for native-shaped or malformed alias calls;
- `NATIVE_TOOL_DISABLED` for `write` and for native IDs in unique mode;
- snapshot/provenance/path/permission/race errors from the existing protocol.

No error may cause automatic execution by a built-in tool or silent surface fallback.

## Implementation Phases

Phases 0-5 and the Phase 6 harness were implemented on the feature branch on 2026-07-20. The Phase 6
behavioral gate is incomplete: pilot v1 failed closed, v2 was retired without execution, and corrected
v3 is unapproved and hard-disabled.
The default production registry
remains exactly `hashline_read`, `hashline_edit`, and `hashline_write`. The explicit alias preview,
deterministic matrix, collision fixtures, credential-free packed verifier, and model adapter are
implemented. Packed verification covers resumed, forked, and imported edits, sanitized export, frozen
stock terminal renderer output, pinned GPT-4/GPT-OSS/GPT-5 routing, wildcard/path edit permissions,
and rollback to unique IDs. Pilot v1 started from commit `57376db02bdaa31667df4891ab582f4e089a74da`
and stopped after session 1 as required by its protocol-integrity gate. The edit and exact-file
outcome succeeded, but the benchmark oracle incorrectly compared OpenCode's drive-root worktree
metadata with the non-VCS fixture root. The immutable sanitized incident record is
[`2026-07-20-native-alias-pilot-v1-incident.json`](../benchmarks/results/2026-07-20-native-alias-pilot-v1-incident.json).
Pilot v1 cannot be resumed or retried. Phase 7 and npm release are no-go; a corrected pilot requires
a new ID, commit, runner hash, model-free preflight, and explicit approval.

### Phase 0: ADR and frozen contract

- Review and approve this document.
- Record OpenCode source commit and renderer contracts.
- Freeze option names, protocol marker, error codes, host allowlist, and non-goals.
- Record the temporary probe as non-release evidence.
- Do not change runtime tools.

### Phase 1: behavior-preserving refactor

- Extract the shared edit executor.
- Extract edit tool-definition and schema factories.
- Extract alias renderer metadata builders.
- Add schema/protocol fingerprint utilities.
- Add deterministic diff-metadata size measurement.
- Preserve unique-mode outputs, schemas, hooks, tests, and packed behavior exactly.
- Land this separately so later alias failures can be attributed.

### Phase 2: unpublished alias prototype

- Add `toolSurface` option parsing.
- Require `enforce:true` for aliases.
- Add exact host-version discovery and allowlist.
- Register `edit` and `apply_patch` factories only in alias mode.
- Keep `hashline_read` and `hashline_write` unique.
- Do not register a second model-visible edit surface.
- Add surface-aware chat and before-hook logic.
- Add renderer metadata and protocol markers.
- Add process-local session fingerprinting.
- Keep work on an unreleased feature branch.

### Phase 3: deterministic unit and contract coverage

The minimum matrix includes:

1. option defaults and unknown/invalid combinations;
2. `enforce:false` plus alias rejection;
3. exact GPT-5, GPT-4, GPT-OSS, and non-GPT filtering;
4. exactly one model-visible alias per representative model;
5. exact provider schema fingerprint;
6. native edit and patch argument rejection;
7. hybrid/unknown-field rejection;
8. valid calls reaching the shared executor;
9. unchanged snapshot/provenance/permission/publication behavior;
10. transfer operations through both aliases;
11. native `write` hidden and tripwired on normal and synthetic turns;
12. create-only `hashline_write` across model families;
13. edit permission allow, ask, path deny, and wildcard deny;
14. invalid option diagnostic mode without alias registration;
15. unsupported or unavailable host diagnostic mode;
16. surface and schema mismatch within one session;
17. cross-session snapshot rejection;
18. subagent/new-child/resumed-child behavior;
19. compaction and synthetic continuation;
20. restart with fresh reread;
21. sanitized and unsanitized export behavior;
22. bounded large-diff metadata behavior;
23. renderer metadata omissions and malformed shapes;
24. additions/deletions/path normalization correctness.

### Phase 4: collision harness

Use isolated plugins/configuration to test:

```text
builtin only
Better last
Better before a native-schema plugin
Better before a Better-shaped plugin
directory custom tool before Better
normal namespaced MCP tools
a later output-mutating hook
```

Expected outcomes and unresolved ownership cases must be encoded as tests or explicit negative
fixtures. The experiment must not convert an unprovable case into a passing assertion.

### Phase 5: packed stock-OpenCode integration

Extend the existing credential-free package/session smoke with three cases:

| Case | Model ID | Expected edit tool |
| --- | --- | --- |
| Unique baseline | non-GPT | `hashline_edit` |
| Alias non-GPT | non-GPT | `edit` |
| Alias GPT-like | GPT-5-like | `apply_patch` |

Each case must:

- install the real tarball with lifecycle scripts disabled;
- run pinned OpenCode through the normal SessionTools path;
- issue a real `hashline_read` snapshot;
- apply an exact real edit;
- assert before/after hook ordering;
- assert exact final bytes and no collateral files;
- inspect the provider-facing tool list and schema;
- assert native-shaped calls are side-effect-free;
- assert persisted alias inputs, outputs, and protocol metadata;
- continue for another turn to exercise replay;
- export, reopen, and validate the session;
- capture terminal edit/patch renderer snapshots;
- retain no credentials and make no external model call.

Run packed integration on Windows, Linux, and macOS where OpenCode supports the tested host version.

### Phase 6: behavioral model pilot

Add a separate benchmark adapter:

```text
better-hashline-native-aliases
```

Pilot v1 compared unique and alias surfaces, not native OpenCode. The corrected, unapproved v3
manifest is hard-disabled and retains these proposed bounds:

| Dimension | Value |
| --- | --- |
| Tasks | Existing 12 transport tasks |
| Surfaces | Unique and aliases |
| Models | OpenAI Luna, OpenAI Sol, OpenRouter Nemotron Nano, OpenRouter Nemotron Ultra |
| Repeats | 1 |
| Sessions | 96 |
| Maximum model requests | 1,152 (12 per session) |
| Session timeout | 300,000 ms |
| Requested host output-token limit | 2,048 per model request; not independently proven as a provider cap |
| Maximum retained JSONL | 8 MiB per session |
| Reported-cost stop thresholds | USD 4 total (USD 1 per model run) |
| Authentication | One isolated copy of the approved OpenCode auth file |

The exact model IDs are `openai/gpt-5.6-luna` (`medium`), `openai/gpt-5.6-sol`
(`medium`), `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`, and
`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`. One `--native-alias-pilot` manifest freezes all
models, variants, tasks, adapter order, 96 sessions, 1,152 requests, and the USD 4 stop threshold.
The manifest pins task SHA-256 `8a5ed7c8169bacf135c68037ea1717c980dd47c7141f03d723ba6ef578d9cb1a`
and adapter-behavior SHA-256 `cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8`.
If v3 is separately approved, only the approved auth-file copy and a clean approval commit C are
accepted; dirty overrides are forbidden. Paid execution binds candidate A, approval commit C, bundle B,
and A's staged runner-executable SHA-256, confines
output to ignored model results, and snapshots authentication once before the first session. Provider
retry status terminates the session before another request, every completed
session is atomically journaled, and the first process, identity, protocol, request, cost, or exact-file
failure stops the entire pilot without substitution or retry.

The v3 oracle physically confines canonical files to the disposable fixture, but treats the one strictly
attested worktree from the unsanitized session export as the sole renderer/protocol path authority. It
requires exact trace-to-export correlation for session, message, part, call, tool, state, input, output,
error, and metadata; validates the complete persisted history; and binds every expected file mutation to
the correct executor. The unsanitized export is inspected only in memory; only a sanitized export is
persisted. A normalized v1-topology fixture exercises the legacy false negative, the corrected valid
decision, and forged/outside-fixture rejection. It declares the private incident trace hash but does not
claim cryptographic replay of the untracked raw trace. Packed verification executes this same oracle and a
one-request retry-abort probe. Pilot v3 is not approved for paid execution; its committed approval anchor
is null, and activation requires the reviewed A/B/C handoff below.

The proposal also freezes OpenRouter provider order with fallback disabled, the timeout/output/trace
limits above, exact-tree evaluation without links or special entries, and an exact schema-v6 preflight
receipt. Candidate commit A retains the null anchor and produces the exact receipt, tarball,
package-tree manifest, and staged runner. External canonical bundle B binds those hashes to auth,
provider endpoint, hard-budget, exact user approval, toolchain, schedule, and broker evidence. Reviewed
direct-child commit C may change only the anchor to B's hash and must reuse A's runner bytes. Before any
model process, the approved broker must atomically consume the global v3 identity in durable state outside
every repository and worktree. Those external attestations and broker are not supplied by this repository.

Pilot outcomes:

- native-shaped malformed-call rate;
- first accepted edit;
- eventual exact success;
- retries and repeated-invalid loops;
- forbidden write or shell fallback attempts;
- tool-unavailable errors;
- exact input/output/reasoning/cache tokens;
- latency and provider failures;
- exact final bytes and unintended files.

The pilot is transport evidence only. It cannot establish superiority. It runs only after explicit
user approval and all existing model/auth/cost gates in the model evaluation plan.

Implementation status: the `native-aliases-v1` adapter set, authoritative oracle, mutation ledger,
exact-tree evaluator, marker/retry metrics, and model-free v3 harness checks are implemented. Any v3
dry run and packed preflight must be repeated from a future
approval commit before paid execution. Pilot v1 executed one of 96 sessions and then stopped. It consumed
four requests at USD 0 reported cost and produced no model-comparison result. The failure was a
benchmark-oracle worktree mismatch, not a runtime, model, exact-file, or retry failure. Raw evidence
remains ignored and unchanged; only the sanitized incident record is included in this review candidate.

### Phase 7: release decision

Public opt-in support is considered only when every go/no-go gate passes. Otherwise the branch is
closed without npm publication.

## Go/No-Go Gates

### Required to proceed beyond prototype

- Default unique surface is byte-, schema-, hook-, and behavior-compatible with `0.2.1`.
- All deterministic protocol, filesystem, and plugin tests remain green.
- Alias calls use only the shared Better Hashline executor.
- Native-shaped arguments produce no permission request or filesystem side effect.
- Native `write` is absent or tripwired on every tested turn path.
- Exactly one alias reaches each supported model route.
- Packed stock-OpenCode sessions prove both aliases and native inline rendering.
- Unsupported host versions fail closed after successful plugin load.
- Session surface/schema mismatch is rejected.
- Renderer metadata size and privacy behavior are documented and bounded.
- Collision limitations are represented honestly in tests and threat model.

### Required before npm release

- The 96-session pilot shows no material malformed-call or retry regression requiring redesign.
- No wrong-target, stale-clobber, overwrite, permission bypass, or false-success outcome occurs.
- Alias-specific documentation does not inherit unique-ID ownership guarantees.
- A model-free verification command is available.
- Rollback is tested from the published tarball.
- Support is limited to exact verified OpenCode versions.
- The feature remains explicit opt-in and marked experimental.

### Automatic no-go

- Any native executor runs after the loaded alias mode accepts a call.
- Any malformed alias call reaches permission or filesystem work.
- Native `write` becomes executable.
- Alias registration weakens unique-mode behavior.
- Host/version mismatch silently falls back to native mutation.
- Session mismatch can silently continue under a different protocol.
- Real models enter persistent native-schema loops at an unacceptable rate.
- Required renderer metadata creates unbounded or misleading completed-card output.

## Documentation Changes For Preview

- Add the option with an experimental warning beside the configuration example.
- Explain that the option changes model-visible and persisted tool IDs.
- Separate unique-ID guarantees from alias-mode guarantees in the threat model.
- Document exact supported OpenCode versions and clients.
- Document plugin ordering and trusted-plugin preconditions.
- Document native-shaped argument rejection and possible retry cost.
- Document ACP and sharing/export limitations.
- Document renderer metadata privacy and truncation behavior.
- Require restart, model-free verification, and a new session when changing surfaces.
- Publish deterministic renderer/session evidence and the unique-versus-alias pilot.
- Keep model-performance claims scoped to the exact tested panel.

## Rollback

Rollback configuration:

```json
{
  "toolSurface": "hashline"
}
```

Required procedure:

1. Change the option to `hashline`.
2. Restart OpenCode.
3. Run model-free unique-tool verification.
4. Confirm `edit`, `write`, and `apply_patch` are hidden/tripwired.
5. Start a new session.
6. Reread files to obtain fresh snapshots.
7. Do not continue an alias session after plugin removal or surface change.

No project-file migration is required. Snapshot state is process-local and disappears on restart.
Historical alias cards remain in old session history and are not retroactively re-executed.

## Proposed Repository Changes

The eventual implementation is expected to touch:

```text
src/options.ts
src/plugin.ts
src/render.ts or a new presentation.ts
tests/options.test.ts
tests/plugin.test.ts
scripts/session-smoke.ts
scripts/package-smoke.ts
benchmarks/model/run.ts
benchmarks/model/tasks.ts or adapter configuration
docs/protocol.md
docs/architecture.md
docs/threat-model.md
docs/benchmarks.md
README.md
CHANGELOG.md
AGENTS.md, only after the invariant is intentionally changed
```

Generated `dist/`, coverage output, local experiments, credentials, and raw model traces must not
be committed.

## Recommended Delivery Sequence

```text
approve this plan
  -> behavior-preserving executor refactor PR
  -> unpublished alias prototype branch
  -> deterministic collision and packed-host evidence
  -> review threat-model delta
  -> explicit approval for 96-session pilot
  -> evaluate go/no-go gates
  -> optional experimental release
```

The current unique-ID implementation remains the production recommendation until the full sequence
passes. Visual parity and model-free evidence alone are not sufficient reason to weaken the default
protocol surface or publish the preview.
