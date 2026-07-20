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
`write`, shell/task/web transports, or both aliases appearing in one route. The proposed v3 pilot is
12 tasks x 2 surfaces x 4 candidate models x 1 repeat = 96 sessions. `--native-alias-pilot`
freezes the four models and variants, all 96 sessions, 1,152 maximum requests, a 300-second timeout,
2,048 requested host output tokens per request, an 8 MiB trace limit, USD 4 total and USD 1/model reported-cost stop
thresholds, auth-file-only isolation, and frozen task/adapter SHA-256 manifests. Dirty source overrides
are forbidden. It writes an atomic journal after every
session and stops on the first process, identity, retry, protocol, request, cost, or exact-file failure.
Paid v3 execution is hard-disabled. The v2 proposal is retired without execution. A separate approval commit must enable v3 before exact committed
HEAD, runner SHA-256, and authentication controls can be used. Output is confined to ignored
`benchmarks/results/model/`, and authentication bytes are snapshotted once before execution.

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
Paid execution must consume the exact schema-v6 preflight receipt, tarball, package-tree manifest, and
staged runner bytes. Candidate commit A retains the null approval anchor and produces those artifacts.
An external canonical bundle B binds their hashes to the exact auth identity, endpoint, hard-budget,
user-approval, toolchain, schedule, and reservation broker evidence. A reviewed direct-child commit C
may change only the anchor from null to the hash of B; it must execute A's retained runner bytes without
rebuilding. The approved external broker must then atomically consume the global v3 reservation exactly
once before any model process. The broker and its durable state must remain outside every repository and
worktree. The checked-in anchor is null, so paid v3 remains hard-disabled.

See [the benchmark guide](../README.md), [methodology](../../docs/benchmarks.md), and the
[staged model evaluation plan](../../docs/model-evaluation-plan.md).
