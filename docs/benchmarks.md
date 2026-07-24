# Benchmarks

Better Hashline separates mechanical protocol evidence from model-quality evidence. This prevents a collision regression test, a microbenchmark, and a language-model task from being summarized as one misleading score.

## Evidence Layers

| Layer | Runs by default | CI gate | What it can show |
| --- | --- | --- | --- |
| Unit and contract tests | Yes | Yes | Invariants and OpenCode adapter behavior |
| Deterministic adversarial corpus | Manual/benchmark workflow | Safety assertions may be inspected | Mechanical accept/reject outcomes |
| Static model-visible size | Manual | No | Exact UTF-8 output bytes for fixed fixtures |
| Core microbenchmarks | Manual | No | Named-machine latency distribution |
| Paired model-in-the-loop | Opt-in only | No | Model/task-specific editing outcomes |

## Retained Deterministic Run

Preceding retained raw result: [`benchmarks/results/2026-07-23-operation-aware-rebase-default-windows-x64.json`](../benchmarks/results/2026-07-23-operation-aware-rebase-default-windows-x64.json)

Current write-once retained schema-v10 result: [`benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json`](../benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json)

The 15-scenario and 21-scenario results remain available as immutable historical evidence in
[`2026-07-18-windows-x64.json`](../benchmarks/results/2026-07-18-windows-x64.json) and
[`2026-07-19-windows-x64.json`](../benchmarks/results/2026-07-19-windows-x64.json). The frozen
[`2026-07-19-transfer-windows-x64.json`](../benchmarks/results/2026-07-19-transfer-windows-x64.json)
schema-v5 record adds transfer safety, raw-schema fixture, call-payload, and move-corridor evidence
without rewriting either earlier result.

The schema-v5 evidence is frozen. It predates `delete_file`, `move_file`, `file-ops-v1`, and
`native-aliases/v2`; it must not be relabeled as lifecycle-operation evidence. The immutable
[`2026-07-22-file-lifecycle-windows-x64.json`](../benchmarks/results/2026-07-22-file-lifecycle-windows-x64.json)
schema-v6 record adds model-free lifecycle operation-schema and call-wire fixtures. The retained
schema-v7 record adds the composed-move case and edit/write/readback/parent-create wire fixtures.
The schema-v8 record keeps those safety cases and measures the simpler inferred defaults. The
schema-v9 record adds an omitted/default adapter using the incremental branch of the shared runtime
policy resolver. The current schema-v10 runner keeps those classifications and adds wire fixtures
for cumulative coverage headers and explicit `replace_file` readback. Strict-only defaults are
covered by runtime tests rather than this corpus. Schema-v5 through schema-v9 and pilot-v7 remain
immutable. All are mechanical textual fixture evidence, not semantic, paid, or model-quality
evidence.

Environment: Windows x64, Bun 1.3.14, AMD64 Family 25 Model 97. Five microbenchmark warmups; 100 measured runs below 10,000 lines and 30 runs at or above it.

The schema-v6 adversarial corpus contains 28 generated cases spanning the previous exact, stale, ambiguous,
boundary, overlap, encoding, and collision cases plus exact copy/move, independently relocated copy
anchors, an intact relocated move corridor, changed transfer sources/corridors, and a copy-read versus
replace-write conflict.

| Adapter | Exact applies | Safe rejects | False rejects | Unsafe accepts |
| --- | ---: | ---: | ---: | ---: |
| Better Hashline strict | 5 | 18 | 5 | 0 |
| Better Hashline unique | 10 | 18 | 0 | 0 |
| Target-only exact search/replace | 9 | 13 | 1 | 5 |
| Original line numbers | 6 | 1 | 0 | 21 |
| 8-bit endpoint hashes | 6 | 12 | 4 | 6 |
| 16-bit endpoint hashes | 6 | 13 | 4 | 5 |

The expected outcomes encode this project's conservative relocation contract. This is useful for finding violations of that contract, not ranking arbitrary production tools. The target-only exact search arm's single false reject is the duplicate-target case that equivalent exact context can resolve; its unsafe accepts are stale selected-target and boundary cases that a stronger revision/context protocol could reject. The row does not establish an advantage for line-number addressing.

## Schema-v7 Retained Result

The schema-v7 runner emitted schema v7. That retained result used the generated, seed-free, model-free
classification methodology, added one allowed move-with-intervening-replacements case to the
adversarial corpus, and measured then-current edit/write raw-schema plus compact readback and parent
creation fixtures. Its retained classifications are:

| Adapter | Exact applies | Safe rejects | False rejects | Unsafe accepts |
| --- | ---: | ---: | ---: | ---: |
| Better Hashline strict | 6 | 18 | 5 | 0 |
| Better Hashline unique | 11 | 18 | 0 | 0 |
| Target-only exact search/replace | 10 | 13 | 1 | 5 |
| Original line numbers | 7 | 1 | 0 | 21 |
| 8-bit endpoint hashes | 7 | 12 | 4 | 6 |
| 16-bit endpoint hashes | 7 | 13 | 4 | 5 |

These values are retained in
[`2026-07-22-edit-protocol-ux-windows-x64.json`](../benchmarks/results/2026-07-22-edit-protocol-ux-windows-x64.json).
The schema-v6 lifecycle record and schema-v5 records remain immutable, as does the closed pilot-v7
scope. This output makes no paid or model-quality claim.

## Schema-v8 Retained Result

The schema-v8 runner retained the schema-v7 29-case corpus and therefore the same
classifications: strict `6/18/5/0`, unique `11/18/0/0`, exact search `10/13/1/5`, line numbers
`7/1/0/21`, endpoint-8 `7/12/4/6`, and endpoint-16 `7/13/4/5`
(`exact_apply/safe_reject/false_reject/unsafe_accept`). The new record changes wire fixtures only:
readback windows imply readback, `lines:[]` implies no final newline, and create-only writes create
bounded missing parents without a separate option.

These values are retained in
[`2026-07-23-default-simplification-r2-windows-x64.json`](../benchmarks/results/2026-07-23-default-simplification-r2-windows-x64.json).
The prior schema records and closed pilot-v7 scope remain immutable. This output makes no paid or
model-quality claim.

## Schema-v9 Retained Result

The retained schema-v9 runner used the same 29-case corpus and explicit adapter outcomes, then added
`better-hashline-default`, which omits `rebase` and resolves the effective mode through the
incremental branch of the same pure policy function used by the plugin. Its classifications are
strict `6/18/5/0`, explicit unique `11/18/0/0`, omitted/default `11/18/0/0`, exact search
`10/13/1/5`, line numbers `7/1/0/21`, endpoint-8 `7/12/4/6`, and endpoint-16 `7/13/4/5`
(`exact_apply/safe_reject/false_reject/unsafe_accept`).

These values are retained in
[`2026-07-23-operation-aware-rebase-default-windows-x64.json`](../benchmarks/results/2026-07-23-operation-aware-rebase-default-windows-x64.json).
The omitted arm establishes equivalence with explicit unique for this textual corpus only. It does
not prove semantic independence, model quality, hook behavior, permission behavior, or filesystem
publication safety. Historical records and the closed pilot-v7 scope remain immutable.

## Schema-v10 Retained Result

The current schema-v10 result preserves the schema-v9 29-case classifications and adds deterministic
wire fixtures for mandatory cumulative `coverage` headers and explicitly requested `replace_file`
readback. Its write-once path is
[`2026-07-24-coverage-readback-ux-windows-x64.json`](../benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json).
This is mechanical textual fixture evidence. Strict-only defaults remain runtime-test evidence, not
corpus evidence; no semantic, paid, or model-quality claim is made.

## Static Size

One generated 1,000-line TypeScript fixture was rendered in each model-facing format. Values are exact UTF-8 bytes, not token estimates.

| Format | Bytes | Change from OpenCode-style `N: content` |
| --- | ---: | ---: |
| Native line rendering | 26,678 | baseline |
| Better Hashline | 25,758 | -3.45% |
| 8-bit hash on every line | 28,678 | +7.50% |
| 16-bit hash on every line | 30,678 | +14.99% |

Better Hashline happens to be smaller in this fixture because `N|` is one byte shorter than `N: ` and the fixed header/footer cost amortizes over 1,000 lines. Different pagination and escaping can change the result. Do not translate byte deltas into token or cost claims without provider-specific tokenization and full traces.

## Long-Line Rendering Change

The renderer previously marked every line over 2,000 UTF-16 units as preview-only even when its complete annotation fit the configured byte budget. The deterministic wire fixture uses one 3,000-character ASCII line and a 4,096-byte output budget:

| Behavior | UTF-8 bytes | Line reference issued |
| --- | ---: | --- |
| Legacy fixed character cutoff | 2,171 | No |
| Byte-budget rendering | 3,079 | Yes |

The change spends 908 additional visible bytes in this fixture to make the complete line editable. Lines that cannot fit one page remain preview-only. These are exact serialized bytes, not token or model-quality claims.

## Transfer Wire Size

The retained transfer fixture measured the compact `hashline_edit` description plus generated raw
JSON Schema growing from 1,300 to 1,541 UTF-8 bytes: +241 bytes, or 18.54%. This is a
`z.toJSONSchema` fixture, not the actual provider projection. It remains flat; `lines` is optional at
schema level and runtime-required for the three payload operations.

The subsequent retained fixture made every operation-specific field combination and payload
constraint explicit while matching the runtime's optional `rebase`. Its compact raw-schema payload
grew from 1,541 to 2,749 UTF-8 bytes: +1,208 bytes, or 78.39%. This added description metadata and
relaxed the generated fixture to accept an already-supported omitted default; existing calls,
transcripts, and configuration required no migration.

The call-size fixture compares one compact transfer call with the equivalent retained text echoed in
an `insert`, or in an `insert` plus deletion for move:

| Source lines | Copy savings | Move savings |
| ---: | ---: | ---: |
| 1 | -1 byte | 55 bytes |
| 10 | 188 bytes | 244 bytes |
| 100 | 2,077 bytes | 2,134 bytes |
| 1,000 | 20,976 bytes | 21,034 bytes |
| 100,000 | 2,099,974 bytes | 2,100,034 bytes |

These values measure serialized call bytes, not tokens. A one-line copy is one byte larger than the
equivalent payload insert; savings begin in this fixture between one and ten source lines.

Move additionally requires issued provenance for its complete source-to-destination corridor. A
20-line corridor required one page and 624 rendered bytes. A 5,000-line corridor required five pages
and 142,191 rendered bytes under the 1,000-line and 40-KB page limits. Copy and move therefore have
different read-economics and should be evaluated independently.

## File Lifecycle Wire Size

The retained schema-v6 runner compared its then-current flat description and raw generated JSON
Schema fixture with a synthetic pre-transfer/lifecycle baseline derived from that schema:

| Fixture | Synthetic baseline bytes | Expanded fixture bytes | Change |
| --- | ---: | ---: | ---: |
| `hashline_edit` description plus raw JSON Schema fixture | 3,095 | 4,125 | +1,030 (+33.28%) |

It also compares compact valid lifecycle calls with equivalent native `apply_patch` calls:

| Operation | Better Hashline bytes | Native `apply_patch` bytes | Difference |
| --- | ---: | ---: | ---: |
| `delete_file` | 121 | 79 | +42 |
| `move_file` | 154 | 108 | +46 |

These are exact compact UTF-8 JSON fixture sizes, not token, safety, or model-quality measurements.
The Better Hashline calls include source path, snapshot, and strict rebase evidence; the native
fixture contains patch text only, so the delta is not a semantic-equivalence or protocol-advantage
claim. The retained schema-v6 JSON records these values without expanding their claim scope.

## Schema-v7 Retained Wire Size

The retained schema-v7 result records the following exact compact UTF-8 fixture sizes:

| Fixture | Synthetic baseline bytes | Expanded fixture bytes | Change |
| --- | ---: | ---: | ---: |
| `hashline_edit` raw-schema fixture | 3,686 | 5,033 | +1,347 (+36.54%) |
| `hashline_write` raw-schema fixture | 282 | 548 | +266 (+94.33%) |
| Explicit text readback call | 181 | 218 | +37 |
| Parent-creating write call | 50 | 81 | +31 |

The edit schema delta covers deterministic conflict evidence, one qualified move/replacement
composition, and text readback windows. The write schema delta covers explicit bounded parent
creation. The calls isolate `readbackOffset`/`readbackLimit` and `createParents:true`; they do not
measure tokens or model behavior. Static-size, long-line rendering, lifecycle-call, transfer-call,
move-corridor, and timing methodology are unchanged from the earlier retained evidence.

## Schema-v8 Retained Wire Size

The retained schema-v8 result records exact compact UTF-8 fixture sizes for its then-current defaults:

| Fixture | Legacy explicit bytes | Simplified/current bytes | Change |
| --- | ---: | ---: | ---: |
| `hashline_edit` raw-schema fixture | 4,694 | 6,127 | +1,433 (+30.53%) |
| `hashline_write` raw-schema fixture | 849 | 531 | -318 (-37.46%) |
| Bounded text readback call | 202 | 186 | -16 (-7.92%) |
| Empty-file `replace_file` call | 138 | 117 | -21 (-15.22%) |
| Parent-creating write call | 81 | 60 | -21 (-25.93%) |

The write comparison reconstructs the pre-change optional `createParents` property on the current
two-field schema; it is not the older schema-v7 JSON fixture. The three call comparisons remove only
redundant controls: `readback:true`, `finalNewline:false` for `lines:[]`, and `createParents:true`.
The same run records compact lifecycle calls without redundant `rebase:"none"`: delete is 105 bytes
versus 79 for native `apply_patch`; move is 138 versus 108. These byte deltas are not token, safety,
or model-quality claims.

## Schema-v9 Retained Wire Size

The retained schema-v9 result records the operation-aware wording in the then-current edit fixture:

| Fixture | Synthetic baseline bytes | Current bytes | Change |
| --- | ---: | ---: | ---: |
| `hashline_edit` raw-schema fixture | 5,035 | 6,637 | +1,602 (+31.82%) |

The same run retains the schema-v8 write and compact inferred-call fixtures: write schema
`849 -> 531`, readback `202 -> 186`, empty-file newline `138 -> 117`, and parent creation `81 -> 60`.
The raw edit fixture is generated schema plus description text, not a provider projection or token
estimate. Exact normalized provider-contract sizes and hashes are recorded in the protocol migration.

## Schema-v10 Retained Wire Evidence

Schema v10 adds exact fixtures for the mandatory cumulative-coverage header and explicit
`replace_file` readback. Their final byte counts, hashes, and deltas are retained in the write-once
JSON and are not inferred from schema v9. All retained schema-v5 through schema-v9 wire values above
remain immutable.

## Core Timings

The raw result contains median and p95 timings for SHA-256, strict UTF-8 decoding, and one-line edit planning from 10 through 20,000 lines. These are non-gating wall-clock measurements from one named machine. They do not establish cross-platform performance and should be rerun after material protocol changes.

Timing values are intentionally not duplicated here: the immutable JSON is the source of truth and includes the exact implementation, corpus, lockfile, source revision, and dirty-state provenance.

## Run Locally

```sh
bun run bench
bun run bench --output=benchmarks/results/local/my-run.json
```

The schema-v10 runner prints summary tables and optionally writes the complete corpus,
classifications, environment, static/rendering sizes, edit/write raw-schema fixtures, cumulative
coverage and explicit `replace_file` readback fixtures, lifecycle and simplified-default call
fixtures, transfer-call evidence, corridor-read evidence, and microbenchmark distributions.

Result paths are write-once by default. Use `--force` only when deliberately regenerating an
unpublished checked result from its final source revision. Never overwrite retained evidence.
Schema v10 uses the dated
`benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json` path; schema-v5 through
schema-v9 evidence remains immutable.

## Model Harness

The staged expansion from transport smoke to preregistered real-repository studies is specified in
the [Model Evaluation Plan](model-evaluation-plan.md). The plan is a study design, not evidence that
model quality has improved.

The default `baseline-v1` model harness has 12 exact-output tasks across mechanical, ambiguous,
batch, boundary, range, encoding, structured, creation, whole-file, and multi-file categories. The
separate eight-task `transfer-v1` development manifest covers copy, upward/downward move, multiple
transfers, a long corridor, conflict recovery, duplicate source content, and a legacy control. The
two-task `file-ops-v1` development manifest covers exact source deletion and no-clobber movement
from a source to an absent destination. These identities are independent; none is confirmatory
evidence. The harness pairs native OpenCode editing against Better Hashline in fresh temporary
directories and alternates adapter order.

Adapter sets are independently versioned. `native-vs-unique-v1` remains the default.
`native-aliases-v1` is retained only as the frozen identity used by pilot v7. The current
`native-aliases-v2` set pairs unique Better Hashline with `better-hashline-native-aliases`; it does
not compare aliases against native OpenCode. V2 alias traces classify Better-shaped versus
native-shaped arguments, stable error codes, `update`/`delete_file`/`move_file` operation identity,
source and move destination correlation, active alias, and `native-aliases/v2` marker validity. V1
results cannot validate this contract.

Dry run, no model calls:

```sh
bun run bench:model
bun run bench:model --task-set=transfer-v1
bun run bench:model --task-set=file-ops-v1 --adapter-set=native-aliases-v2 --repeats=1
bun run bench:model --native-alias-pilot
```

Model-free adapter preflight:

```sh
bun run bench:model --preflight --output=benchmarks/results/local/preflight
bun run bench:model --preflight --task-set=file-ops-v1 --adapter-set=native-aliases-v2 \
  --output=benchmarks/results/local/file-ops-preflight
```

Preflight makes no model requests, but it builds, packs, installs dependencies with lifecycle
scripts disabled, invokes the pinned OpenCode CLI, and writes evidence. Every output directory must
be new. It may access the npm registry when dependencies are not cached. It also runs the packed
credential-free verifier for unique, non-GPT alias, and GPT-like alias routes, including the
deterministic lifecycle checks. Verifier evidence remains model-free and does not substitute for a
paid paired run.

Paid execution:

```sh
BENCHMARK_AUTH_FILE=/path/to/opencode-auth.json \
BENCHMARK_ACK_COSTS=yes \
bun run bench:model --execute --task-set=baseline-v1 --model=provider/model --repeats=2 \
  --approved-sessions=48 --approved-max-requests=576 --approved-max-cost-usd=10
```

Alternatively, explicitly pass only the provider variables required by the selected model with `--pass-env=KEY_ONE,KEY_TWO`. OpenCode, home, configuration, and temporary-directory variables cannot be passed through.

The harness:

- builds and clean-installs one hashed npm tarball with lifecycle scripts disabled;
- uses the pinned OpenCode 1.18.3 executable and verifies both adapters before model execution;
- isolates home, profile, application-data, temporary, and all XDG directories;
- copies only an explicitly selected auth file or explicitly named provider variables;
- disables external skills and denies shell, task, and web tools;
- caps every agent at 12 model steps and requires the exact derived session/request schedule;
- aborts provider retries before another request and journals every completed session atomically;
- stops before another session after OpenCode-reported cost reaches the explicitly approved stop threshold, which is not a provider billing cap;
- uses a fresh directory for every adapter/task/repeat;
- evaluates exact bytes and unexpected files;
- requires successful expected edit tools and rejects forbidden transport usage;
- validates the observed parent-session model and agent from a sanitized export;
- records process/timeout/transport status, exact token categories, retries, OpenCode-reported parent-session cost, JSONL, stderr, and sanitized exports;
- ignores raw model traces in Git by default.

The harness reports requested and observed identities separately. Reported usage covers the
validated parent session and is not asserted to equal a provider invoice. Before publishing model
claims, inspect all traces, redact secrets, report malformed calls/retries/tokens/cost with their
stated scope, run enough paired tasks for the intended claim, and preregister the primary metric.
The default 48-session pilot is useful for harness debugging, not a universal superiority claim.

The retained native-alias model result is pilot v7. Its frozen schedule used the 12 `baseline-v1`
tasks, the unique and `native-aliases-v1` surfaces, and Luna/Sol medium. All 48 sessions passed in
181 observed requests with complete accounting, zero retries/failures/timeouts, and USD 0 reported
cost. The [privacy-safe summary](../benchmarks/results/2026-07-21-native-alias-pilot-v7.json) is
technical transport evidence, not a model-superiority claim. It covered the earlier text-operation
contract only and provides no evidence for `delete_file`, `move_file`, `file-ops-v1`,
`native-aliases/v2`, or lifecycle metadata. The maintainer approved only an opt-in experimental
release; `hashline` remains the default.

There is no paid model run or model-quality result for `file-ops-v1` or `native-aliases-v2`. Dry
runs, model-free preflight, deterministic tests, and packed verifier checks must not be described as
paid lifecycle evidence or used to claim model accuracy, cost, or superiority.

Model-free preflight still exercises the fail-closed oracle against normalized worktree/fixture
topology, forged and outside-fixture paths, lifecycle source/destination correlation, and a
one-request retry abort. Trace and export terminal records must match exactly, complete history must
validate, and the per-file mutation ledger must bind each expected change to the required executor.
Unsanitized exports remain memory-only.

Earlier pilot IDs v1-v6 are retired or consumed and remain permanently closed. Their superseded
incident records remain available in Git history rather than the current benchmark result set.

## Result Vocabulary

| Outcome | Meaning |
| --- | --- |
| `exact_apply` | Accepted and produced the specified exact bytes |
| `safe_reject` | Rejected a scenario expected to reject |
| `false_reject` | Rejected an allowed exact/cooperative edit |
| `unsafe_accept` | Accepted a stale/ambiguous edit or produced wrong bytes |

Scenario truth is adapter-independent. An `expectedText` means that an exact cooperative result
exists for the scenario, so a strict adapter's intentional stale-snapshot rejection is counted as a
`false_reject`. This records the availability cost of conservative strict behavior; reclassifying the
same scenario per adapter would make cross-adapter safety and acceptance counts incomparable.

Future concurrent harnesses should distinguish stale clobber, wrong-target accept, partial commit, false success, permission bypass, timeout, and post-write overwrite rather than collapsing them into pass/fail.

## Claims Policy

Until paired results exist for the exact task and adapter identities being discussed, this project
claims only:

- deterministic invariants covered by tests and the model-free packed verifier;
- exact collision mathematics;
- exact serialized bytes for declared fixtures;
- named-machine non-gating timings;
- outcomes on the checked-in deterministic corpus.

It does not claim lifecycle-operation model accuracy from schema-v5 or pilot-v7, and it makes no paid
model claim for `file-ops-v1` or `native-aliases-v2`. Schema-v7 development output is likewise not a
retained or model-quality result. More generally, it does not claim universal
model accuracy, token savings, lower cost, semantic conflict detection, filesystem CAS,
transactionality, or superiority over OpenCode's actual current tools.
