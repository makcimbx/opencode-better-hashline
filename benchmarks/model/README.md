# Paired Model Harness

The harness compares selected editing adapters on exact-output fixtures. The default
`native-vs-unique-v1` set preserves the native OpenCode versus unique Better Hashline study.
`native-aliases-v1` is retained only as the frozen pilot-v7 adapter identity and is rejected for
new ordinary or development-probe execution. The current `native-aliases-v2` set compares unique
Better Hashline with its experimental v2 native-alias
surface, including `update`/`delete_file`/`move_file` markers and exact source/destination
correlation. It is cost-gated and performs no model calls unless `--execute`, a model ID, exact
session/request approvals, a reported-cost stop threshold (not a provider billing cap), exactly one
auth source, and `BENCHMARK_ACK_COSTS=yes` are all present. Every isolated agent is capped at 12
steps.

The marker name remains `native-aliases/v2`, but the current edit-schema expansion changes the
canonical schema SHA and protocol fingerprint. For live plugin use, restart the plugin or host as
applicable and obtain a fresh delivered `hashline_read` in the same OpenCode session/task; old
snapshot IDs cannot revive. Marker-name equality alone does not make the identities compatible.
This does not reopen or extend the immutable pilot-v7 schedule.

Use `--preflight --output=<new-directory>` to build, pack, install, probe adapter isolation, and run
the stock-host verifier without a model request. Preflight may use the npm registry and writes local
evidence. The v2 verifier route checks lifecycle operations separately from paid model execution.

Paid runs use isolated home/config/temp roots and only explicitly selected authentication. They
validate successful tool use, forbidden transports, process/trace integrity, and observed
parent-session identity. Task definitions live in `tasks.ts`. The default `baseline-v1` set
preserves the original 12 tasks; `transfer-v1` selects eight copy/move development tasks;
`file-ops-v1` selects two exact-output source-delete and no-clobber source-move tasks. Each identity
is independent, and the runner preserves raw JSONL, stderr, and sanitized session exports under an
ignored, write-once result directory.

All task sets can be inspected without making model calls:

```sh
bun run bench:model
bun run bench:model --task-set=transfer-v1
bun run bench:model --task-set=file-ops-v1 --adapter-set=native-aliases-v2 --repeats=1
bun run bench:model --native-alias-pilot
```

The v2 alias trace records native-shaped retries, stable error codes, active alias, operation, exact
source/destination correlation, and `native-aliases/v2` marker validity. It rejects completed
native-shaped calls, missing or invalid markers when an edit is required, `hashline_edit`, native
`write`, shell/task/web transports, or both aliases appearing in one route. The retained
[pilot v7 summary](../results/2026-07-21-native-alias-pilot-v7.json) records 48/48 passing sessions
across the frozen `baseline-v1` and `native-aliases-v1` schedule in 181 observed requests with
complete accounting. It covered the earlier text-operation contract and provides no evidence for
`delete_file`, `move_file`, `file-ops-v1`, `native-aliases/v2`, or lifecycle metadata. It is
technical transport evidence without a model-superiority claim; all pilot IDs through v7 are
closed. There is no paid model result or model-quality claim for the new task or adapter identity.
The retained schema-v7 and schema-v8 deterministic results are likewise model-free mechanical
evidence, not continuations of pilot v7 or paid model-quality results.

`--native-alias-probe` is development evidence only. It accepts the exact focused probe tasks or the
full `baseline-v1` task set, the native-alias-only probe adapter set or current paired
`native-aliases-v2` adapter set, and the two frozen v7 model/variant pairs, with 1–20 explicit repeats
under normal paid approvals. Frozen `native-aliases-v1` is not executable for new probes. Probe runs
require isolated strict auth and confine raw output to a new direct child of ignored
`benchmarks/results/model/`. Output may come from clean or dirty source but is always non-publishable
and never consumes or substitutes for a pilot reservation. Probe mode does not accept `file-ops-v1`.

The fail-closed oracle physically confines canonical files to the disposable fixture and uses the
strictly attested export worktree as renderer authority. Trace and export terminal records must
match exactly, complete v2 history must validate operation and source/destination metadata, and a
per-file mutation ledger must bind every expected change to the correct executor. The unsanitized
export is memory-only; packed preflight exercises normalized worktree topology, lifecycle routes,
and a one-request retry abort. Superseded incident details and frozen v1 evidence remain available
in Git history rather than being rewritten as v2 lifecycle evidence.

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
