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

## Recorded Deterministic Run

Latest raw result: [`benchmarks/results/2026-07-19-transfer-windows-x64.json`](../benchmarks/results/2026-07-19-transfer-windows-x64.json)

The 15-scenario and 21-scenario results remain available as immutable historical evidence in
[`2026-07-18-windows-x64.json`](../benchmarks/results/2026-07-18-windows-x64.json) and
[`2026-07-19-windows-x64.json`](../benchmarks/results/2026-07-19-windows-x64.json). The latest
schema-v5 record adds transfer safety, provider-schema, call-payload, and move-corridor evidence
without rewriting either earlier result.

Environment: Windows x64, Bun 1.3.14, AMD64 Family 25 Model 97. Five microbenchmark warmups; 100 measured runs below 10,000 lines and 30 runs at or above it.

The adversarial corpus contains 28 generated cases spanning the previous exact, stale, ambiguous,
boundary, overlap, encoding, and collision cases plus exact copy/move, independently relocated copy
anchors, an intact relocated move corridor, changed transfer sources/corridors, and a copy-read versus
replace-write conflict.

| Adapter | Exact applies | Safe rejects | False rejects | Unsafe accepts |
| --- | ---: | ---: | ---: | ---: |
| Better Hashline strict | 4 | 19 | 5 | 0 |
| Better Hashline unique | 9 | 19 | 0 | 0 |
| Target-only exact search/replace | 8 | 14 | 1 | 5 |
| Original line numbers | 5 | 2 | 0 | 21 |
| 8-bit endpoint hashes | 5 | 13 | 4 | 6 |
| 16-bit endpoint hashes | 5 | 14 | 4 | 5 |

The expected outcomes encode this project's conservative relocation contract. This is useful for finding violations of that contract, not ranking arbitrary production tools. The target-only exact search arm's single false reject is the duplicate-target case that equivalent exact context can resolve; its unsafe accepts are stale selected-target and boundary cases that a stronger revision/context protocol could reject. The row does not establish an advantage for line-number addressing.

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

Adding both transfer operations and their model-facing coordinate rules grows the compact
`hashline_edit` description plus generated JSON Schema from 1,300 to 1,541 UTF-8 bytes: +241 bytes,
or 18.54%. The provider schema remains flat; `lines` is optional at schema level and runtime-required
for the three payload operations.

Making every operation-specific field combination and payload constraint explicit, while matching
the runtime's optional `rebase`, grows the same compact payload from 1,541 to 2,749 UTF-8 bytes:
+1,208 bytes, or 78.39%. This adds description metadata and relaxes the generated schema to accept an
already-supported omitted default; existing calls, transcripts, and configuration require no
migration.

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
20-line corridor required one page and 611 rendered bytes. A 5,000-line corridor required five pages
and 142,126 rendered bytes under the 1,000-line and 40-KB page limits. Copy and move therefore have
different read-economics and should be evaluated independently.

## Core Timings

The raw result contains median and p95 timings for SHA-256, strict UTF-8 decoding, and one-line edit planning from 10 through 20,000 lines. These are non-gating wall-clock measurements from one named machine. They do not establish cross-platform performance and should be rerun after material protocol changes.

Timing values are intentionally not duplicated here: the immutable JSON is the source of truth and includes the exact implementation, corpus, lockfile, source revision, and dirty-state provenance.

## Run Locally

```sh
bun run bench
bun run bench --output=benchmarks/results/local/my-run.json
```

The runner prints summary tables and optionally writes the complete corpus, classifications,
environment, static/rendering sizes, provider-schema and transfer-call sizes, corridor-read evidence,
and microbenchmark distributions.

Result paths are write-once by default. Use `--force` only when deliberately regenerating an unpublished checked result from its final source revision.

## Model Harness

The staged expansion from transport smoke to preregistered real-repository studies is specified in
the [Model Evaluation Plan](model-evaluation-plan.md). The plan is a study design, not evidence that
model quality has improved.

The default `baseline-v1` model harness has 12 exact-output tasks across mechanical, ambiguous,
batch, boundary, range, encoding, structured, creation, whole-file, and multi-file categories. The
separate eight-task `transfer-v1` development manifest covers copy, upward/downward move, multiple
transfers, a long corridor, conflict recovery, duplicate source content, and a legacy control. Neither
set is confirmatory evidence. The harness pairs native OpenCode editing against Better Hashline in
fresh temporary directories and alternates adapter order.

Adapter sets are independently versioned. `native-vs-unique-v1` remains the default. The experimental
`native-aliases-v1` set pairs unique Better Hashline with `better-hashline-native-aliases`; it does
not compare aliases against native OpenCode. Alias traces classify Better-shaped versus native-shaped
arguments, stable error codes, active alias, and `native-aliases/v1` marker validity.

Dry run, no model calls:

```sh
bun run bench:model
bun run bench:model --task-set=transfer-v1
bun run bench:model --adapter-set=native-aliases-v1 --repeats=1
bun run bench:model --native-alias-pilot
```

Model-free adapter preflight:

```sh
bun run bench:model --preflight --output=benchmarks/results/local/preflight
```

Preflight makes no model requests, but it builds, packs, installs dependencies with lifecycle scripts disabled, invokes the pinned OpenCode CLI, and writes evidence. It may access the npm registry when dependencies are not cached. The output directory must not already exist.
It also runs the packed credential-free verifier for unique, non-GPT alias, and GPT-like alias routes.

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

The harness reports requested and observed identities separately. Reported usage covers the validated parent session and is not asserted to equal a provider invoice. Before publishing model claims, inspect all traces, redact secrets, report malformed calls/retries/tokens/cost with their stated scope, run enough paired tasks for the intended claim, and preregister the primary metric. The default 48-session pilot is useful for harness debugging, not a universal superiority claim.

Native-alias pilot v3 froze 12 baseline tasks x 2 surfaces x four models: 96 sessions and at most 1,152
requests. It executed one Luna session, stopped fail-closed after five observed requests, consumed its
reservation, and may never resume or retry. Reported cost was USD 0, but accounting remained incomplete
with an unknown cost upper bound; no file mutation or model-comparison result exists. See the
[sanitized incident](../benchmarks/results/2026-07-21-native-alias-pilot-v3-incident.json).

Native-alias pilot v1 stopped after its first session because the benchmark oracle conflated the
task fixture with OpenCode's worktree. The edit itself, model identity, transport, and exact files
passed, but protocol-marker classification failed closed. The run is not release evidence and cannot
be resumed or retried. See the
[sanitized incident record](../benchmarks/results/2026-07-20-native-alias-pilot-v1-incident.json).
A future corrected pilot requires a new immutable runner identity and explicit approval.
The corrected v3 oracle physically confines files to the disposable fixture and separately uses the one
strictly attested export worktree for renderer paths. It exactly correlates trace and unsanitized export
terminal records, validates complete history, and assigns every expected file mutation to the required
executor. The unsanitized export remains memory-only; persisted evidence is sanitized. Model-free
preflight records the same oracle's normalized v1-topology fixture and a packed one-request retry-abort probe. The fixture declares the private incident trace hash but is topology evidence, not a cryptographic replay of untracked raw bytes.
Pilot v2 was never executed and is retired. Pilot v4 executed two sessions and stopped fail-closed after
the baseline session produced exact bytes but its trace lacked fixture-root path authority, causing a
mutation-ledger false negative. Its reservation is consumed, it may never resume or retry, and no model
comparison result exists. See the
[v4 incident](../benchmarks/results/2026-07-21-native-alias-pilot-v4-incident.json). Pilot v5 then passed
16 sessions and stopped fail-closed on session 17 because the create-file fixture omitted the parent
directory required by strict create-only `hashline_write`. Its reservation is consumed, it may never
resume or retry, and no unsafe mutation occurred. See the
[v5 incident](../benchmarks/results/2026-07-21-native-alias-pilot-v5-incident.json). Pilot v6 then passed
22 sessions and stopped fail-closed after its benchmark ledger cleared a still-valid
snapshot for another file. Its reservation is consumed, it may never resume or retry, and exact expected
bytes were preserved. See the
[v6 incident](../benchmarks/results/2026-07-21-native-alias-pilot-v6-incident.json). Pilot v7 then used a
new identity, exact A/B/C approval chain, and new external reservation to complete all 48 sessions.

The completed v7 schedule used the same 12 tasks and paired surfaces with Luna and Sol medium. All 48
sessions passed in 181 observed requests with complete accounting, zero retries/failures/timeouts, and USD
0 reported cost. Nano was excluded after an
intermittent malformed-argument development failure; Ultra and alternative NVIDIA candidates were
excluded after provider-capacity, model-format, reasoning-length, or no-tool instability. Development
probes are non-publishable evidence. The
[privacy-safe v7 summary](../benchmarks/results/2026-07-21-native-alias-pilot-v7.json) is technical evidence,
not a model-superiority claim or release authorization.

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

Until paired results exist, this project claims only:

- deterministic invariants covered by tests;
- exact collision mathematics;
- exact serialized bytes for declared fixtures;
- named-machine non-gating timings;
- outcomes on the checked-in deterministic corpus.

It does not claim universal model accuracy, token savings, lower cost, semantic conflict detection, filesystem CAS, transactionality, or superiority over OpenCode's actual current tools.
