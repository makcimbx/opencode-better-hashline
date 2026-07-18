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

Latest raw result: [`benchmarks/results/2026-07-19-windows-x64.json`](../benchmarks/results/2026-07-19-windows-x64.json)

The initial 15-scenario result remains available as immutable historical evidence in
[`2026-07-18-windows-x64.json`](../benchmarks/results/2026-07-18-windows-x64.json). The
expanded result adds contradictory-context, surviving-duplicate, and copied-edge-boundary
regressions without rewriting the original record.

Environment: Windows x64, Bun 1.3.14, AMD64 Family 25 Model 97. Five microbenchmark warmups; 100 measured runs below 10,000 lines and 30 runs at or above it.

The adversarial corpus contains 21 generated cases spanning exact edits, shifted targets, changed targets, interior range mutation, duplicate content, contradictory relocation evidence, copied boundaries, concurrent boundary insertion, EOL change, overlapping insertions, BOF/EOF change, generated 8/16-bit collisions, unrelated cooperative changes, and empty-file boundaries.

| Adapter | Exact applies | Safe rejects | False rejects | Unsafe accepts |
| --- | ---: | ---: | ---: | ---: |
| Better Hashline strict | 2 | 16 | 3 | 0 |
| Better Hashline unique | 5 | 16 | 0 | 0 |
| Target-only exact search/replace | 4 | 12 | 1 | 4 |
| Original line numbers | 3 | 1 | 0 | 17 |
| 8-bit endpoint hashes | 3 | 10 | 2 | 6 |
| 16-bit endpoint hashes | 3 | 11 | 2 | 5 |

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

## Core Timings

The raw result contains median and p95 timings for SHA-256, strict UTF-8 decoding, and one-line edit planning from 10 through 20,000 lines. These are non-gating wall-clock measurements from one named machine. They do not establish cross-platform performance and should be rerun after material protocol changes.

Timing values are intentionally not duplicated here: the immutable JSON is the source of truth and includes the exact implementation, corpus, lockfile, source revision, and dirty-state provenance.

## Run Locally

```sh
bun run bench
bun run bench --output=benchmarks/results/local/my-run.json
```

The runner prints summary tables and optionally writes the complete corpus, classifications, environment, static sizes, and microbenchmark distributions.

Result paths are write-once by default. Use `--force` only when deliberately regenerating an unpublished checked result from its final source revision.

## Model Harness

The model harness has 12 exact-output tasks across mechanical, ambiguous, batch, boundary, range, encoding, structured, creation, whole-file, and multi-file categories. It pairs native OpenCode editing against Better Hashline in fresh temporary directories and alternates adapter order.

Dry run, no model calls:

```sh
bun run bench:model
```

Model-free adapter preflight:

```sh
bun run bench:model --preflight --output=benchmarks/results/local/preflight
```

Preflight makes no model requests, but it builds, packs, installs dependencies with lifecycle scripts disabled, invokes the pinned OpenCode CLI, and writes evidence. It may access the npm registry when dependencies are not cached. The output directory must not already exist.

Paid execution:

```sh
BENCHMARK_AUTH_FILE=/path/to/opencode-auth.json \
BENCHMARK_ACK_COSTS=yes \
bun run bench:model --execute --model=provider/model --repeats=2
```

Alternatively, explicitly pass only the provider variables required by the selected model with `--pass-env=KEY_ONE,KEY_TWO`. OpenCode, home, configuration, and temporary-directory variables cannot be passed through.

The harness:

- builds and clean-installs one hashed npm tarball with lifecycle scripts disabled;
- uses the pinned OpenCode 1.18.3 executable and verifies both adapters before model execution;
- isolates home, profile, application-data, temporary, and all XDG directories;
- copies only an explicitly selected auth file or explicitly named provider variables;
- disables external skills and denies shell, task, and web tools;
- uses a fresh directory for every adapter/task/repeat;
- evaluates exact bytes and unexpected files;
- requires successful expected edit tools and rejects forbidden transport usage;
- validates the observed parent-session model and agent from a sanitized export;
- records process/timeout/transport status, exact token categories, retries, OpenCode-reported parent-session cost, JSONL, stderr, and sanitized exports;
- ignores raw model traces in Git by default.

The harness reports requested and observed identities separately. Reported usage covers the validated parent session and is not asserted to equal a provider invoice. Before publishing model claims, inspect all traces, redact secrets, report malformed calls/retries/tokens/cost with their stated scope, run enough paired tasks for the intended claim, and preregister the primary metric. The default 48-session pilot is useful for harness debugging, not a universal superiority claim.

## Result Vocabulary

| Outcome | Meaning |
| --- | --- |
| `exact_apply` | Accepted and produced the specified exact bytes |
| `safe_reject` | Rejected a scenario expected to reject |
| `false_reject` | Rejected an allowed exact/cooperative edit |
| `unsafe_accept` | Accepted a stale/ambiguous edit or produced wrong bytes |

Future concurrent harnesses should distinguish stale clobber, wrong-target accept, partial commit, false success, permission bypass, timeout, and post-write overwrite rather than collapsing them into pass/fail.

## Claims Policy

Until paired results exist, this project claims only:

- deterministic invariants covered by tests;
- exact collision mathematics;
- exact serialized bytes for declared fixtures;
- named-machine non-gating timings;
- outcomes on the checked-in deterministic corpus.

It does not claim universal model accuracy, token savings, lower cost, semantic conflict detection, filesystem CAS, transactionality, or superiority over OpenCode's actual current tools.
