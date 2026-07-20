# Paired Model Harness

The harness compares selected editing adapters on exact-output fixtures. The default
`native-vs-unique-v1` set preserves the native OpenCode versus unique Better Hashline study. The
separate `native-aliases-v1` set compares unique Better Hashline with its experimental native-alias
surface. It is cost-gated and performs no model calls unless `--execute`, a model ID, the exact
session/request approvals, a reported-cost ceiling, exactly one auth source, and
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
validity. It rejects completed native-shaped calls, missing/invalid markers, `hashline_edit`, native
`write`, shell/task/web transports, or both aliases appearing in one route. The planned pilot is 12
tasks x 2 surfaces x 4 approved models x 1 repeat = 96 paid sessions. `--native-alias-pilot`
freezes the four models and variants, all 96 sessions, 1,152 maximum requests, USD 4 stop threshold,
auth-file-only isolation, and the approved task/adapter SHA-256 manifests. Dirty source overrides are
forbidden. Each model is capped at USD 1 of reported cost. It writes an atomic journal after every
session and stops on the first process, identity, retry, protocol, request, cost, or exact-file failure.
Paid execution additionally requires the exact committed HEAD and runner SHA-256 printed by the dry
run. Output is confined to ignored `benchmarks/results/model/`, and approved authentication bytes are
snapshotted once before execution.

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
