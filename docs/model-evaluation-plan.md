# Model Evaluation Plan

Status: design only. No model result is implied by this document.

Frozen evidence note: when this plan was frozen, the deterministic runner emitted schema v8. That
immutable model-free record retained the 29-case corpus and added wire fixtures for inferred
readback, empty-file newline, and parent-creation defaults:
[`2026-07-23-default-simplification-r2-windows-x64.json`](../benchmarks/results/2026-07-23-default-simplification-r2-windows-x64.json).
The current schema-v9 deterministic record is documented separately and does not revise this frozen
plan. The schema-v5 through schema-v9 and closed pilot-v7 records remain immutable. Neither those
model-free results nor this plan supports a paid or model-quality claim.

| Field | Value |
| --- | --- |
| Plan version | 1.0 draft |
| Plan date | 2026-07-19 |
| Model catalog snapshot | 2026-07-18T22:35:37Z |
| Frozen plan package baseline | `opencode-better-hashline@0.1.1` |
| Frozen plan OpenCode baseline | `1.18.3` |

## Purpose

This plan defines how to determine whether Better Hashline provides practical value when real
models edit real code through stock OpenCode. It is intentionally separate from the deterministic
protocol corpus: mechanical safety, model compatibility, and model-quality effects are different
claims and require different evidence.

The study should answer three questions:

1. Does the production plugin prevent stale, ambiguous, or false-success outcomes in the real
   packaged OpenCode lifecycle?
2. Does installing the production plugin improve, preserve, or reduce task success for named
   current models and task strata?
3. Which observed effects come from line addressing, rather than snapshots, prompts, schemas,
   permissions, native-tool suppression, or filesystem publication?

The immediate product question is the second one: should an OpenCode user install this exact
package? The third question is a mechanism study and must not be inferred from the product A/B.

## Non-Goals

This study will not attempt to prove:

- universal superiority across models, languages, repositories, or future provider revisions;
- semantic conflict detection or filesystem compare-and-swap;
- that a finite run establishes zero probability of an unsafe edit;
- that UTF-8 wire bytes are equivalent to provider tokens or cost;
- that a model alias identifies an immutable backend snapshot;
- that results from toy adapter simulations rank production editing tools;
- that eventual task success makes malformed calls, retries, or unsafe intermediate writes
  irrelevant.

## Evidence Layers

| Layer | Model calls | Primary purpose | Allowed claim |
| --- | ---: | --- | --- |
| Unit and property tests | No | Pure protocol and implementation invariants | Tested invariant |
| Deterministic OpenCode safety gallery | No | Packaged native-versus-plugin lifecycle behavior | Reproduced scenario outcome |
| Transport smoke | Yes | Harness, schema, identity, and trace integrity | Harness compatibility only |
| Statistical pilot | Yes | Estimate variance, discordance, and required sample size | Exploratory effect estimate |
| Public product study | Yes | Practical named-model guidance | Fixed-panel, fixed-corpus result |
| Powered confirmatory study | Yes | Detect a preregistered practical effect | Powered fixed-panel conclusion |
| Mechanism ablation | Yes | Isolate addressing semantics | Mechanism-specific result |

No result may be promoted from one layer to a stronger layer. In particular, the existing 12-task
model harness remains a development smoke and the retained 29-case deterministic corpus remains
mechanical protocol evidence.

## Causal Estimands

### Deployable Bundle Effect

Compare stock OpenCode with the published Better Hashline package exactly as a user would install
them. The treatment includes all intentional product differences:

- custom read/edit/write tools;
- snapshot and issued-provenance requirements;
- Better Hashline system guidance;
- provider-facing schemas;
- native mutator suppression;
- permission and filesystem behavior;
- failure messages and required rereads.

This is the primary product study. Its result must be described as the Better Hashline bundle
effect, not the isolated effect of line references.

### Addressing Mechanism Effect

A later sibling adapter should use the same snapshot authority, permissions, filesystem code,
schema complexity, instruction budget, and native-tool policy, but address edits with exact old
text and exact bounded context instead of line coordinates. This matched comparison can test
whether line addressing itself changes model behavior.

The mechanism adapter must not silently use fuzzy, normalized, first-match, or nearest-match
application. It must retain the same fail-closed safety contract.

### Deterministic Safety Effect

Use a scripted local provider to drive the actual pinned OpenCode session lifecycle. Compare
observable native and plugin outcomes under controlled stale, ambiguous, permission, encoding,
and publication scenarios. This establishes reproducible behavior but does not estimate an LLM
success rate.

## Frozen Plan Harness Baseline

The existing runner already provides strong transport controls:

- explicit execution and cost acknowledgement gates;
- hashed build, tarball, install lock, task, runner, and OpenCode executable provenance;
- clean-installed production package with lifecycle scripts disabled;
- isolated home, profile, application data, temporary, configuration, and XDG roots;
- explicit auth-file copy or allowlisted provider environment;
- fresh fixture directory for every adapter, task, and repetition;
- native-versus-plugin adapter identity probes;
- denied shell, task, web, and external-directory transports;
- raw JSONL, stderr, sanitized session export, and exact-file evaluation;
- observed parent-session model identity and exact token-category extraction;
- write-once output directories and nonzero exit for invalid trials.

Its present limitations are material:

- 12 small exact-output tasks;
- one requested model per invocation;
- two adapters and two repeats;
- no real-repository hidden-test tasks;
- no stale/concurrency injection during a model session;
- no cross-model scheduler or blocked randomization manifest;
- no cluster-aware statistical analysis;
- no mechanism-matched adapter;
- no static trace viewer or failure gallery.

With only 12 task clusters and two repeats, the current harness can detect only very large adapter
effects. It must not support a compatibility or superiority statement.

## Protocol Freeze

Before the first scored inference request, commit a versioned preregistration containing:

- package tarball and SHA-256;
- source commit and clean/dirty state;
- OpenCode executable version and SHA-256;
- dependency lock and container hashes;
- task manifest, source revisions, licenses, graders, and corpus split;
- exact model IDs, requested variants, and endpoint eligibility rules;
- observed provider metadata requirements;
- complete prompts, system guidance, tool schemas, and tool order;
- exact native-alias marker, canonical schema SHA, and protocol fingerprint;
- agent, step, timeout, retry, token, and file-scope budgets;
- adapter order seed and scheduling algorithm;
- primary and secondary outcomes;
- intention-to-treat and provider-outage rules;
- exclusion, invalidation, and rerun rules;
- statistical model, bootstrap unit, multiplicity correction, and confidence level;
- noninferiority margin, if one is claimed;
- stopping or extension rule;
- claims that each planned sample size may support.

After outcome inspection, protocol changes require a new version and untouched tasks. Pilot tasks
must never migrate into the confirmatory set.

## Task Program

### Transport Tasks

Retain the existing 12 exact-output tasks for development and preflight. They cover constants,
duplicates, batches, boundaries, deletion, EOL preservation, structured data, creation, whole-file
replacement, and paired files.

These tasks are not part of confirmatory inference because they have already influenced harness
design.

### Transfer Development Tasks

Transfer evaluation uses the separately versioned `transfer-v1` development task set rather than
changing the 12-task transport baseline. Its eight checked-in exact-output tasks cover long-block
copy, upward and downward moves, multiple independent transfers, a 5,000-line corridor, conflict
recovery, duplicate source content, and a legacy-operation control. Deterministic mechanism scenarios
separately cover source/destination shifts, relocation ambiguity, pre-edit copy semantics when a write intersects its source,
changed move corridors, and the sole allowed composition: one move plus pairwise-disjoint
replacements wholly inside its intervening corridor and outside its source.

Report `copy_range` and `move_range` independently. Copy can avoid retransmitting any sufficiently
large issued source, while move requires issuance of its complete source-to-destination corridor and
may be uneconomical over long distances. Record rereads, issued bytes, malformed calls, safe rejects,
recovery rounds, tokens, latency, and unintended changes. Treat `transfer-v1` as development evidence,
not confirmation, and do not execute or publish it without the controls below.

### Deterministic Safety Gallery

Extend the local scripted-provider session smoke into a scenario runner over the real packed
plugin and stock OpenCode. Initial scenarios should include:

| Scenario | Native question | Better Hashline question |
| --- | --- | --- |
| File changes after read | Can stale output overwrite new bytes? | Is stale publication rejected? |
| Duplicate target | Can a matcher select the wrong duplicate? | Is ambiguity rejected? |
| Copied insertion boundary | Can an insertion move to a copy? | Is the copied boundary rejected? |
| Permission-wait mutation | Is the approved plan still current? | Does the fixed plan fail closed? |
| EOL-only mutation | Is newline drift detected? | Does exact text/EOL authority reject it? |
| Output truncation/mutation | Can undelivered refs be used? | Does one attested readback page issue only delivered refs, with no ID-only successor? |
| Long complete line | Is it editable within output budget? | Is complete byte-budget issuance usable? |
| Create race | Can a destination be overwritten? | Does no-replace publication hold? |
| Parent-chain race | Can approval drift change created paths? | Does a fixed, fully authorized plan fail closed without rollback? |
| Post-publication interference | Can success be false? | Is post-write mismatch reported? |
| Native win | Does strict safety impose a false reject? | Can the model recover by rereading? |

Publish both favorable and unfavorable examples. The gallery is a reproducible product safety
demonstration, not a model benchmark.

### Statistical Pilot Corpus

Create 30 to 50 new development tasks excluded from later confirmation. Include exact edits,
hidden-test bug fixes, multi-hunk work, multi-file work, and injected stale interactions.

Use two development model conditions, two adapters, and three repetitions. The pilot estimates:

- paired discordance between adapters;
- within-task repetition correlation;
- transport invalidity and provider-outage rates;
- malformed-call and adapter-compliance rates;
- token, latency, retry, and tool-round distributions;
- the practical effect size worth confirming.

### Held-Out Product Corpus

The first public study should use at least 100 untouched tasks. A stronger confirmatory corpus
should contain 200 exact-edit and 200 hidden-test functional tasks.

Recommended category allocation:

| Category | Public-study target | Confirmatory target |
| --- | ---: | ---: |
| Surgical exact edits | 25 | 100 |
| Hidden-test bug fixes | 25 | 100 |
| Multi-hunk/refactor | 15 | 60 |
| Multi-file feature/fix | 15 | 60 |
| Stale/concurrency interaction | 15 | 60 |
| Config/text/encoding | 5 | 20 |

Recommended language allocation:

| Language family | Share |
| --- | ---: |
| TypeScript/JavaScript | 35% |
| Python | 25% |
| Rust | 15% |
| Go | 15% |
| JSON/YAML/config/text | 10% |

Every task must record repository URL, pinned revision, license, setup hash, visible prompt, hidden
grader, allowed paths, time budget, expected outcome class, and contamination notes. Prefer fresh
mutations over famous public fixes. Keep public tests visible and acceptance tests hidden from the
model.

Functional tasks must accept alternate correct patches. Exact-byte equality is appropriate only
when exact preservation is the task contract.

### Task Schema Extensions

The task manifest should support:

- stable task and repository IDs;
- task layer, category, language, and difficulty metadata;
- setup artifact or container image;
- visible and hidden test commands;
- allowed, expected, and forbidden paths;
- exact expected bytes when applicable;
- protected fixture hashes;
- deterministic stale-event trigger and mutation;
- maximum model steps, tool calls, wall time, and output size;
- public-test feedback policy;
- scorer version and hash;
- corpus split and preregistration version.

## Model Matrix

The IDs below were observed in the local OpenCode catalog and current provider metadata at the
catalog snapshot time. They are time-bounded candidates, not promises of future availability.

### OpenAI Family Ladder

| Capability role | Model ID | Requested variant |
| --- | --- | --- |
| Lighter/repeatable | `openai/gpt-5.6-luna` | `medium` |
| Balanced | `openai/gpt-5.6-terra` | `medium` |
| Strong/open-ended | `openai/gpt-5.6-sol` | `medium` |

Do not mix standard aliases with `-fast`, `pro`, or other service tiers in one causal comparison.
Do not request the hidden OAuth alias `openai/gpt-5.6`. The three names above are not immutable
dated snapshots, so every report must be date-bound and record observed session identity.

### OpenRouter Free Quantile Sample

| Sampling stratum | Exact model ID | Endpoint at catalog snapshot |
| --- | --- | --- |
| Minimum | `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` | Nvidia |
| Lower quartile | `openrouter/openai/gpt-oss-20b:free` | Darkbloom |
| Median | `openrouter/cohere/north-mini-code:free` | Cohere |
| Upper quartile | `openrouter/google/gemma-4-31b-it:free` | Google AI Studio |
| Maximum | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | Nvidia |

The selection rule is fixed before outcomes:

1. Query the live Models API for zero-price tool-capable text models.
2. Require an exact ID ending in `:free`, tool choice, no listed expiration, and a numeric coding
   index used only for sampling.
3. Require one live tool-capable endpoint at the cutoff.
4. Sort by coding index and choose minimum, 25th, 50th, 75th, and maximum ranks.

Do not use `openrouter/free`. Do not replace an unavailable model with a favorable alternative.
Artificial Analysis indices select strata only and must not explain away observed outcomes.

### Initial Transport Pilot

Use four endpoint conditions:

- `openai/gpt-5.6-luna`, `medium`;
- `openai/gpt-5.6-sol`, `medium`;
- `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`;
- `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`.

With 12 tasks, two adapters, and one repetition, the pilot contains 96 sessions. It is a harness
validation wave and must not contribute to confirmatory statistics.

### Proposed Public Fixed Panel

Freeze the final panel only after identity and endpoint preflight, but before scored outcomes. A
proposed four-condition panel is:

- OpenAI Luna for the lighter closed-model tier;
- OpenAI Sol for the stronger closed-model tier;
- OpenRouter Nemotron Nano for the minimum sampled free tier;
- OpenRouter Gemma 4 31B for a stronger non-Nvidia free endpoint.

This covers weak/strong capability and OpenAI/Nvidia/Google endpoints. The full eight-condition
matrix may be reported as exploratory external-validity evidence, not silently pooled into one
headline score.

## Provider Controls

### OpenRouter

Immediately before and after every model block, save and hash:

- model metadata response;
- endpoint metadata response;
- provider name and tag;
- canonical model identity when disclosed;
- context limit and quantization;
- supported parameters;
- prompt/completion price and expiration;
- routing configuration;
- response provider/model/request identifiers.

Set provider selection to an eligible exact endpoint, disable fallbacks, require requested
parameters, and enable router metadata when the OpenCode provider interface supports those fields.
If exact routing cannot be enforced, retain only single-endpoint free variants and invalidate a
block whose endpoint topology changes.

Record `429`, `Retry-After`, and upstream availability failures. Never substitute another model or
selectively rerun one adapter.

Documented free-account limits are volatile. At the catalog snapshot they included 20 requests per
minute and either 50 or 1,000 requests per day depending on lifetime purchased credits. A session
usually consumes multiple inference requests, so even the transport pilot may span UTC days.

### OpenAI Subscription And API

Working ChatGPT OAuth is not by itself authorization for a high-volume automated benchmark.
OpenAI individual terms and usage guidance restrict automated output extraction and rate-limit
circumvention. Before using subscription OAuth, verify current terms and account eligibility for
the planned workload.

Use subscription access only for an explicitly approved small pilot when permitted. Use official
metered API access for a large confirmatory run. Never parallelize to evade a subscription quota,
rotate accounts/keys to multiply limits, or silently treat quota failures as model failures.

## Trial Scheduling

Generate the complete schedule before execution with a published seed.

Use blocked AB/BA ordering within each task, model, and repetition. Keep paired adapter trials
temporally close, but randomize model block order so provider drift is not confounded with model
strength. Do not always run weak models first or native first.

One trial consists of:

1. Verify source, package, OpenCode, model, endpoint, task, grader, and schedule hashes.
2. Create fresh process, workspace, home, config, cache, and temporary roots.
3. Materialize a pristine task fixture.
4. Apply only the selected adapter configuration.
5. Start trace capture before model execution.
6. Inject any preregistered stale event at its exact lifecycle trigger.
7. Run within fixed step, tool, time, and output budgets.
8. Preserve every process, transport, tool, and provider outcome.
9. Run exact or hidden-test graders outside model control.
10. Record unexpected files, complete patch, usage, retries, and final state.
11. Write immutable trial evidence and checksums.

Run adapters sequentially unless independence under concurrency has been established. Never share
workspace, OpenCode cache, session state, or plugin snapshot state between trials.

## Failure And Rerun Policy

Every assigned trial belongs to the intention-to-treat result. Count these outcomes rather than
dropping them:

- malformed tool arguments;
- provider rejection;
- timeout;
- process crash;
- tool noncompliance;
- forbidden transport use;
- adapter initialization failure;
- wrong model/provider identity;
- grader failure caused by the patch;
- model refusal;
- exhausted step/tool budget.

Reruns are allowed only for a preregistered verified infrastructure/provider outage that affects a
paired block independently of adapter outcome. Preserve the failed attempt, reason, evidence, and
rerun linkage. If only one adapter is rerun, report and justify it; the default is to rerun or
invalidate the paired block according to the frozen rule.

Do not retry 429s selectively until the desired result appears. Resume through predeclared blocks
after the documented cooldown.

## Outcomes And Metrics

### Primary Outcomes

Analyze exact and functional strata separately.

| Stratum | Primary outcome |
| --- | --- |
| Exact edits | Single-run exact task success within budget |
| Functional edits | Hidden fail-to-pass plus regression success within budget |
| Stale/safety | No wrong target, stale clobber, false success, or collateral file change |

The primary effect is the marginal paired risk difference between Better Hashline and native
OpenCode for each preregistered model and stratum.

### Secondary Outcomes

- first accepted edit success;
- eventual task success;
- parse and tool-call validity;
- adapter compliance;
- safe rejection and false rejection;
- wrong-target and stale-clobber outcome;
- unexpected lines, files, or metadata changes;
- public-test and hidden-test transitions;
- model turns, tool rounds, tool errors, and retries;
- rereads and recovery after rejection;
- input, output, reasoning, and cache tokens;
- model wall time and total trial time;
- provider-reported cost or credit consumption;
- process, transport, provider, and grader failure taxonomy.

OpenAI subscription sessions may report zero monetary cost. Do not interpret zero as economic cost;
report token usage and quota context separately.

### Reliability Outcomes

Report both pass@k and pass^k-style reliability summaries where meaningful. A format that succeeds
once but rarely succeeds repeatedly is different from a consistently successful format.

Prompt-paraphrase or metamorphic reliability must use a separate preregistered subset so that
prompt variants do not inflate the primary sample size.

## Statistical Analysis

Repetitions of one task are correlated and are not independent samples.

Primary analysis:

- paired within-task/model adapter comparison;
- stratified cluster bootstrap over repository/task units;
- marginal risk difference and 95% interval;
- separate exact and functional estimates;
- separate estimates for every fixed model condition.

Corroborating analysis:

- hierarchical logistic model;
- fixed adapter, model, stratum, and adapter-by-model terms;
- random task and repository effects;
- marginal predicted risk differences rather than odds ratios alone.

Use Holm correction for preregistered per-model confirmatory contrasts. Exploratory interactions
must remain labeled exploratory. Do not infer equivalence from a nonsignificant difference.

Any noninferiority claim requires a preregistered practical margin and enough power for that
margin. A 5-point margin is expensive and must not be claimed from a 100-task study.

## Power And Scale

Pilot data must estimate paired discordance and within-task repetition correlation. The following
planning values assume 30% discordance, three repetitions, and correlation 0.5:

| Detectable absolute effect | Unique tasks per stratum/model | Sessions per model |
| ---: | ---: | ---: |
| 15 percentage points | about 70 | about 420 |
| 10 percentage points | about 157 | about 942 |
| 7.5 percentage points | about 280 | about 1,680 |
| 5 percentage points | about 628 | about 3,768 |

These are planning approximations, not a substitute for simulation using pilot estimates.

Suggested stages:

| Stage | Design | Sessions | Claim ceiling |
| --- | --- | ---: | --- |
| Transport smoke | 12 tasks, 4 conditions, 2 arms, 1 repeat | 96 | Harness works |
| Statistical pilot | 30-50 tasks, 2 models, 2 arms, 3 repeats | 360-600 | Exploratory |
| Public product study | 100 tasks, 4 models, 2 arms, 2 repeats | 1,600 | Large fixed-panel effects |
| Confirmatory target | 400 tasks, 4 models, 2 arms, 3 repeats | 9,600 | Roughly 10-point stratum effects |

Use a preregistered sequential extension only if the initial confidence interval remains too wide.
The extension rule must depend on uncertainty, not which adapter is winning.

## Harness Integration Plan

Preserve the current dry-run, preflight, cost gate, identity validation, and immutable result
behavior. Add the following components in reviewable increments:

### Study Manifest

Add a versioned machine-readable manifest containing protocol version, corpus split, model matrix,
endpoint rules, adapter definitions, repetitions, seed, budgets, metrics, and analysis plan.

### Multi-Model Scheduler

Add a resumable orchestrator that expands the frozen manifest into a complete seeded schedule,
runs one immutable trial at a time, records block state, and never silently changes model or task.

### Provider Snapshot

Capture and hash OpenCode model catalogs plus OpenRouter model/endpoint metadata. Verify provider
topology before and after each block and record drift.

### Real-Repository Fixtures

Materialize pinned, licensed fixtures outside the source workspace. Run setup and graders in
isolated containers or equivalent immutable environments. Keep hidden tests outside model-visible
paths.

### Restricted Test Tool

Expose only a task-specific test command instead of a general shell. Keep native and plugin arms
identical except for the edit treatment.

### Stale Event Controller

Observe the preregistered lifecycle event, mutate exact fixture bytes from outside the model, and
record injection time/hash. Apply the same event rule in both adapters.

### Analysis Command

Produce machine-readable paired outcomes, confidence intervals, cluster bootstrap samples,
hierarchical-model inputs, failure tables, and provenance validation. Analysis must consume only
frozen raw evidence and never rewrite it.

### Replay And Trace Viewer

Generate a static viewer from sanitized evidence. It should show prompts, tool schemas, tool calls,
errors, retries, patches, graders, provider identity, and usage without credentials or hidden-test
content.

## Repository And Artifact Layout

Proposed layout:

```text
benchmarks/model/
  protocols/
    v1.yaml
  corpora/
    pilot-v1.json
    confirmatory-v1.json
  models/
    2026-07-18.json
  adapters.ts
  schedule.ts
  study.ts
  analyze.ts
  replay.ts
  tasks/
  graders/
docs/
  model-evaluation-plan.md
  benchmark-card.md
```

Raw model results remain ignored by Git. Publish sanitized immutable evidence and checksums as
GitHub release artifacts or a dedicated evidence repository. Do not add raw traces to the npm
package.

## Publication Package

Publish enough material for an independent rerun:

- protocol and preregistration;
- exact package, OpenCode, container, corpus, evaluator, and analysis hashes;
- model and endpoint snapshots;
- prompts, tool schemas/order, budgets, and randomization seed;
- every assigned trial and outcome;
- sanitized JSONL/session exports and checksums;
- complete patches and unexpected-file reports;
- graders and analysis code;
- confidence intervals and model/category interactions;
- provider outages, reruns, exclusions, and deviations;
- measured token, latency, retry, and cost scope;
- a benchmark card with claims, non-claims, limitations, and supersession policy;
- a failure gallery containing plugin wins, native wins, both-pass, and both-fail examples;
- instructions for independent replication.

Select qualitative examples by a frozen rule, not by visual appeal. Include all safety failures,
largest paired disagreements in both directions, and a median both-pass case.

## Claims Decision Table

| Result pattern | Defensible message |
| --- | --- |
| Better success and no safety regression | Named models/tasks improved with measured effect |
| Similar success and safer stale outcomes | Added safety without a detectable completion penalty |
| Weak models improve, strong models are neutral | Model-tier-specific benefit, not universal superiority |
| Strong models regress | Compatibility warning and model-specific recommendation |
| Wide interval around zero | Inconclusive; report uncertainty, not equivalence |
| Any plugin wrong-target/false-success event | Safety investigation before promotional claim |
| Provider identity/topology invalid | Block invalid; no model substitution |

Do not publish one pooled win rate as the headline. Report per model and task stratum with absolute
effect and interval. A useful final summary should look like:

```text
Model A: functional success +N points, retries -M%, interval [...].
Model B: result inconclusive at the planned sample size.
Model C: safer stale handling but completion -K points.
```

## Approval And Cost Gates

Repository rules remain authoritative:

- no model execution without explicit user approval;
- require an exact model/auth source and `BENCHMARK_ACK_COSTS=yes`;
- perform dry run and model-free preflight first;
- show the complete immutable schedule and maximum session/request count before approval;
- show API/subscription/free-tier assumptions and a worst-case spend/quota estimate;
- stop when the preregistered budget, quota, identity, or endpoint gate fails;
- never convert a failed paid run into an unrecorded retry.

Implementation should land separately from model evidence. Run studies from a clean merged commit,
then add immutable results in a separate evidence pull request so every recorded source SHA remains
reachable.

## Implementation Checklist

### Phase 0: No Model Calls

- [ ] Add versioned study-manifest schema.
- [ ] Refactor current session runner into reusable trial execution without weakening controls.
- [ ] Add deterministic seeded multi-model scheduler and resume journal.
- [ ] Add model/endpoint snapshot capture and drift validation.
- [ ] Add real-repository task and grader schema.
- [ ] Add restricted task-test tool.
- [ ] Add stale/concurrency event controller.
- [ ] Add paired outcome and cluster-aware analysis command.
- [ ] Add deterministic packaged native-versus-plugin safety gallery.
- [ ] Add sanitized static trace viewer.
- [ ] Add unit, integration, package-smoke, and no-call preflight tests.
- [ ] Document protocol version and benchmark card template.

### Phase 1: Transport Pilot

- [ ] Freeze pilot manifest and catalog snapshots.
- [ ] Verify current terms, auth, rate limits, and endpoint eligibility.
- [ ] Present the 96-session schedule and request explicit execution approval.
- [ ] Run in recorded blocks without substitutions.
- [ ] Validate every trace and identity before reading adapter scores.
- [ ] Publish only harness findings.

### Phase 2: Statistical Pilot

- [ ] Freeze 30-50 development tasks excluded from confirmation.
- [ ] Run two model conditions, two adapters, and three repetitions.
- [ ] Estimate discordance, clustering, invalidity, latency, and usage.
- [ ] Simulate confirmatory power before outcome-based design discussion.
- [ ] Freeze untouched public/confirmatory corpus and analysis plan.

### Phase 3: Public Product Study

- [ ] Freeze at least 100 held-out tasks and four fixed model conditions.
- [ ] Run the preregistered paired schedule.
- [ ] Analyze intention-to-treat outcomes and confidence intervals.
- [ ] Produce benchmark card, complete failure table, and trace gallery.
- [ ] Publish immutable evidence and reproduction instructions.

### Phase 4: Confirmatory And Mechanism Work

- [ ] Extend to the pilot-powered sample size using the frozen rule.
- [ ] Replicate on fresh tasks and at least one held-out model.
- [ ] Implement the matched exact-context sibling adapter.
- [ ] Run mechanism ablation separately from the product study.
- [ ] Request an independent external replication.

## Research Basis

- [On Randomness in Agentic Evals](https://arxiv.org/abs/2602.07150)
- [SWE-bench](https://www.swebench.com/)
- [Aider benchmarks](https://aider.chat/docs/benchmarks.html)
- [Diff-XYZ v2](https://arxiv.org/abs/2510.12487)
- [Independent Hashline replication](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html)
- [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
- [OpenCode models](https://opencode.ai/docs/models/)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [OpenRouter free variants](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
