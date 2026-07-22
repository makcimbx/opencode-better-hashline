# Paired Model Harness

The harness compares selected editing adapters on exact-output fixtures. The default
`native-vs-unique-v1` set preserves the native OpenCode versus unique Better Hashline study. The
separate `native-aliases-v1` set compares unique Better Hashline with its experimental native-alias
surface. It is cost-gated and performs no model calls unless `--execute`, a model ID, the exact
session/request approvals, a reported-cost stop threshold (not a provider billing cap), exactly one auth source, and
`BENCHMARK_ACK_COSTS=yes` are all present. Every isolated agent is capped at 12 steps.

Use `--preflight --output=<new-directory>` to build, pack, install, probe adapter isolation, and run
the three-route stock-host verifier without a model request. Preflight may use the npm registry and
writes local evidence.

Paid runs use isolated home/config/temp roots and only explicitly selected authentication. They validate successful tool use, forbidden transports, process/trace integrity, and observed parent-session identity. Task definitions live in `tasks.ts`. The default `baseline-v1` set preserves the original 12 tasks; `--task-set=transfer-v1` selects eight copy/move development tasks without changing that baseline. The runner preserves raw JSONL, stderr, and sanitized session exports under an ignored, write-once result directory.

Both task sets can be inspected without making model calls:

```sh
bun run bench:model
bun run bench:model --task-set=transfer-v1
bun run bench:model --adapter-set=native-aliases-v1 --repeats=1
bun run bench:model --native-alias-pilot
```

The alias trace records native-shaped retries, stable error codes, active alias, and protocol-marker
validity. It rejects completed native-shaped calls, missing or invalid markers when an edit is
required, `hashline_edit`, native `write`, shell/task/web transports, or both aliases appearing in
one route. The retained
[pilot v7 summary](../results/2026-07-21-native-alias-pilot-v7.json) records 48/48 passing sessions
across 12 tasks, two surfaces, and two stable models in 181 observed requests with complete
accounting. It is technical transport evidence without a model-superiority claim; all pilot IDs
through v7 are closed.

`--native-alias-probe` is development evidence only. It accepts the exact focused probe tasks or the full
`baseline-v1` task set, the native-alias-only or paired adapter set, and the two frozen v7 model/variant
pairs, with 1–20 explicit repeats under normal paid approvals,
requires isolated strict auth, and confines raw output to a new direct child of ignored
`benchmarks/results/model/`. Probe output may come from clean or dirty source but is always non-publishable
and never consumes or substitutes for a pilot reservation.

The fail-closed oracle physically confines canonical files to the disposable fixture and uses the
strictly attested export worktree as renderer authority. Trace and export terminal records must
match exactly, complete history must validate, and a per-file mutation ledger must bind every
expected change to the correct executor. The unsanitized export is memory-only; packed preflight
exercises the normalized worktree-topology regression and a one-request retry abort. Superseded
incident details remain available in Git history rather than the current result set.

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
