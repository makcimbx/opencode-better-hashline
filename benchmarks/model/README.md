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
validity. It rejects completed native-shaped calls, missing/invalid markers, `hashline_edit`, native
`write`, shell/task/web transports, or both aliases appearing in one route. Pilot v4 freezes 12 tasks x
2 surfaces x 3 proven models, 72 sessions, 864 maximum requests, and exact
timeout/output/trace/cost/auth evidence behind a new null anchor. Pilot v3 executed one Luna session,
stopped fail-closed on current-call history correlation, consumed its reservation, and may never resume
or retry. The
[sanitized incident](../results/2026-07-21-native-alias-pilot-v3-incident.json) records five requests,
USD 0 reported cost, no file mutation, and incomplete conservative accounting.

`--native-alias-probe` is development evidence only. It fixes the task and adapter to one exact
single-file native-alias edit, accepts the three frozen v4 model/variant pairs, permits 1–20 explicit
repeats under normal paid approvals,
requires isolated strict auth, and confines raw output to a new direct child of ignored
`benchmarks/results/model/`. Probe output is dirty-source, non-publishable evidence and never consumes
or substitutes for a pilot reservation.

Pilot v1 stopped after session 1 because its oracle used the fixture root where OpenCode reported a
drive-root worktree. It produced no comparison result and cannot be resumed or retried. The
[sanitized incident record](../results/2026-07-20-native-alias-pilot-v1-incident.json) preserves the
gate outcome without publishing raw session data. Any corrected pilot needs a new ID, committed
runner hash, preflight, and explicit approval.

The corrected v3 oracle physically confines canonical files to the disposable fixture and uses the one
strictly attested export worktree as renderer authority. Trace and export terminal records must match
exactly, complete history must validate, and a per-file mutation ledger must bind every expected change
to the correct executor. The unsanitized export is memory-only; persisted evidence is sanitized. Packed
preflight executes this same oracle against a normalized v1 topology and proves one-request retry abort.
Pilot v4 starts from a new ID and null anchor. Candidate A must produce exact schema-v6 receipt,
tarball, package-tree, and staged-runner bytes. External bundle B must bind them to auth, endpoint,
hard-budget, user approval, toolchain, schedule, and a new broker reservation. Direct-child commit C may
change only that anchor and must reuse A's runner bytes. The broker and durable reservation must remain
outside every repository/worktree and be consumed once before any model process.

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
