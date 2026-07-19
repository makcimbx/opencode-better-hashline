# Paired Model Harness

The harness compares native OpenCode editing with Better Hashline on exact-output fixtures. It is cost-gated and performs no model calls unless `--execute`, a model ID, and `BENCHMARK_ACK_COSTS=yes` are all present.

Use `--preflight --output=<new-directory>` to build, pack, install, and verify both adapters without a model request. Preflight may use the npm registry and writes local evidence.

Paid runs use isolated home/config/temp roots and only explicitly selected authentication. They validate successful tool use, forbidden transports, process/trace integrity, and observed parent-session identity. Task definitions live in `tasks.ts`. The default `baseline-v1` set preserves the original 12 tasks; `--task-set=transfer-v1` selects eight copy/move development tasks without changing that baseline. The runner preserves raw JSONL, stderr, and sanitized session exports under an ignored, write-once result directory.

Both task sets can be inspected without making model calls:

```sh
bun run bench:model
bun run bench:model --task-set=transfer-v1
```

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
