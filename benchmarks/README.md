# Benchmark Reproducibility

## Deterministic Runner

```sh
bun install --frozen-lockfile
bun run bench --output=benchmarks/results/local/reproduction.json
```

The runner uses generated fixtures and Node SHA-256. No network, model, repository corpus, or random collision seed is required. Collision pairs are found deterministically by enumerating candidate strings.

When comparing results, use the raw JSON environment fields and source commit. Timing values are expected to vary; protocol classifications should not.

The current runner emits schema v6 and includes lifecycle operation-schema and call-wire fixtures.
The retained [`2026-07-22-file-lifecycle-windows-x64.json`](results/2026-07-22-file-lifecycle-windows-x64.json)
records that model-free evidence. The schema-v5 result predates lifecycle operations and remains
immutable.

Result paths are write-once unless `--force` is supplied explicitly. Never use `--force` on published evidence.

## Model Runner

`bun run bench:model` is a dry run of the frozen `baseline-v1` task set. Separately versioned
transfer and file-lifecycle development sets are also dry-run by default:

```sh
bun run bench:model --task-set=transfer-v1
bun run bench:model --task-set=file-ops-v1 --adapter-set=native-aliases-v2 --repeats=1
bun run bench:model --native-alias-pilot
```

`file-ops-v1` contains two exact-output delete/move tasks. `native-aliases-v2` is the current adapter
identity for the v2 operation and source/destination metadata contract. Neither identity has a paid
model result.

A model-free adapter/package check is available separately:

```sh
bun run bench:model --preflight --output=benchmarks/results/local/preflight
bun run bench:model --preflight --task-set=file-ops-v1 --adapter-set=native-aliases-v2 \
  --output=benchmarks/results/local/file-ops-preflight
```

Preflight performs builds, package installation, registry access when needed, OpenCode subprocesses,
local writes, and the credential-free packed verifier, but no model request. Its output directory
must be new. The v2 route checks include lifecycle operation and source/destination correlation;
this remains deterministic model-free evidence.

`native-aliases-v1` is retained only for the frozen pilot-v7 identity. The retained
[pilot v7 summary](results/2026-07-21-native-alias-pilot-v7.json) records 48/48 passing Luna/Sol
sessions in 181 observed requests with complete accounting and no retry, timeout, process,
transport, or trace failures. It covered the earlier text-operation contract, not `delete_file`,
`move_file`, `file-ops-v1`, `native-aliases/v2`, or lifecycle metadata. It is technical transport
evidence, not a model-superiority claim; all pilot IDs through v7 are closed.

Paid execution requires the exact immutable session/request schedule, a reported-cost stop threshold
(not a provider billing cap), cost
acknowledgement, and exactly one authentication source:

```sh
BENCHMARK_MODEL=provider/model \
BENCHMARK_AUTH_FILE=/path/to/opencode-auth.json \
BENCHMARK_ACK_COSTS=yes \
bun run bench:model --execute --task-set=baseline-v1 --repeats=2 \
  --approved-sessions=48 --approved-max-requests=576 --approved-max-cost-usd=10
```

On PowerShell:

```powershell
$env:BENCHMARK_MODEL = "provider/model"
$env:BENCHMARK_AUTH_FILE = "C:\path\to\opencode-auth.json"
$env:BENCHMARK_ACK_COSTS = "yes"
bun run bench:model --execute --repeats=2 --approved-sessions=48 `
  --approved-max-requests=576 --approved-max-cost-usd=10
```

Instead of an auth file, provider variables can be allowlisted explicitly with `--pass-env=KEY_ONE,KEY_TWO` or `BENCHMARK_PASS_ENV`. The runner refuses OpenCode, home, XDG, configuration, and temporary-directory passthrough variables.

Raw outputs are written under `benchmarks/results/model/` and ignored by Git. Review them before moving a result into a publishable location.

No paid execution or model-quality claim currently exists for `file-ops-v1` or
`native-aliases-v2`. Do not promote dry runs, preflights, verifier output, frozen schema-v5 results,
or pilot-v7 evidence into such a claim.

## Publishing Results

Include:

- repository commit and dirty-worktree status;
- OpenCode, plugin, Bun, OS, and architecture versions;
- tarball, installed dependency lock, runner, task, root lockfile, and OpenCode executable hashes;
- exact task-set and adapter-set identities, including protocol marker version;
- exact provider/model snapshot and relevant reasoning variant;
- requested and observed parent-session model and agent identity;
- task manifest revision and evaluator;
- adapter order, repetitions, timeouts, and retry policy;
- complete redacted traces or a reason they cannot be shared;
- first-attempt and eventual exact success;
- malformed calls, unintended files, retries, tokens, latency, and cost;
- confidence intervals for aggregate paired claims;
- an explicit statement when frozen evidence predates the operation under discussion.

Never overwrite a dated result. Add a new file and explain protocol or corpus changes in the changelog. Usage and cost are scoped to the validated parent OpenCode session and must not be described as complete provider billing without independent evidence.
