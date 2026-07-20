# Benchmark Reproducibility

## Deterministic Runner

```sh
bun install --frozen-lockfile
bun run bench --output=benchmarks/results/local/reproduction.json
```

The runner uses generated fixtures and Node SHA-256. No network, model, repository corpus, or random collision seed is required. Collision pairs are found deterministically by enumerating candidate strings.

When comparing results, use the raw JSON environment fields and source commit. Timing values are expected to vary; protocol classifications should not.

Result paths are write-once unless `--force` is supplied explicitly. Never use `--force` on published evidence.

## Model Runner

`bun run bench:model` is a dry run of the frozen `baseline-v1` task set. The separately versioned
transfer development set is also dry-run by default:

```sh
bun run bench:model --task-set=transfer-v1
bun run bench:model --adapter-set=native-aliases-v1 --repeats=1
bun run bench:model --native-alias-pilot
```

A model-free adapter/package check is available separately:

```sh
bun run bench:model --preflight --output=benchmarks/results/local/preflight
```

Preflight performs builds, package installation, registry access when needed, OpenCode subprocesses, and local writes, but no model request. Its output directory must be new.

`--adapter-set=native-aliases-v1` pairs the unique and experimental alias surfaces. Its preflight
also runs the credential-free packed verifier through unique `hashline_edit`, non-GPT `edit`, and
GPT-like `apply_patch`. The corrected v3 proposal freezes four candidate models, one repeat, and 96
sessions behind `--native-alias-pilot`, but paid v3 execution is currently hard-disabled. The earlier
v2 proposal is retired without execution.

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

The corrected native-alias pilot v3 is not approved. Its committed approval anchor is null, so no paid
command is valid. Candidate commit A must retain that null anchor and produce one clean schema-v6
preflight, tarball, package-tree manifest, and staged runner. External bundle B binds those exact hashes
to the auth identity, endpoint, hard-budget, user-approval, toolchain, schedule, and external reservation
broker. A reviewed direct-child commit C may change only the anchor to the hash of B and must reuse A's
runner bytes. Paid output is fixed at `benchmarks/results/model/native-alias-pilot-v3`; the approved
external broker must atomically consume the global v3 identity before any model process and never release
it for resume or retry.

Raw outputs are written under `benchmarks/results/model/` and ignored by Git. Review them before moving a result into a publishable location.

## Publishing Results

Include:

- repository commit and dirty-worktree status;
- OpenCode, plugin, Bun, OS, and architecture versions;
- tarball, installed dependency lock, runner, task, root lockfile, and OpenCode executable hashes;
- exact provider/model snapshot and relevant reasoning variant;
- requested and observed parent-session model and agent identity;
- task manifest revision and evaluator;
- adapter order, repetitions, timeouts, and retry policy;
- complete redacted traces or a reason they cannot be shared;
- first-attempt and eventual exact success;
- malformed calls, unintended files, retries, tokens, latency, and cost;
- confidence intervals for aggregate paired claims.

Never overwrite a dated result. Add a new file and explain protocol or corpus changes in the changelog. Usage and cost are scoped to the validated parent OpenCode session and must not be described as complete provider billing without independent evidence.
