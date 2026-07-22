# Threat Model

## Protected Outcomes

Better Hashline is designed to prevent these failures during cooperative agent editing:

- applying an edit to bytes different from the approved strict snapshot;
- selecting a wrong duplicate target through fuzzy or nearest matching;
- accepting only range endpoints while an interior line changed;
- composing overlapping or same-boundary operations;
- editing a line that was retained internally but not issued to the model;
- copying retained source text that was not issued to the model;
- moving through unseen corridor content or composing a move from evolving coordinates;
- bypassing normal OpenCode read/edit/external-directory permission decisions;
- silently overwriting an existing path through the create tool;
- following a retargeted symlink without reauthorization;
- returning success when post-publication bytes differ from the plan.
- writing model-facing line annotations that were copied into an edit payload;
- claiming native-alias concurrency before one exact process-local session binding.

## Trusted Components

- The OpenCode process and stable V1 plugin hook implementation.
- Bun and Node-compatible filesystem/crypto primitives used by the plugin.
- The operating system's path, descriptor, flush, and rename semantics.
- The configured OpenCode permission policy and human approval UI.
- Other code loaded into the same OpenCode process.

The model is not trusted to copy annotations correctly, choose unique targets, detect staleness, or honor prose instructions by itself. Those checks are enforced in code.

## Adversaries Outside Scope

### Hostile concurrent writers

The plugin rereads immediately before rename, but ordinary portable filesystems do not expose a universal conditional rename over exact prior bytes. Another process can write in the final check-to-rename interval. Post-write verification can detect some races but cannot safely roll them back over an even newer writer.

### Shell and other plugins

On the default surface, `enforce: true` hides and rejects OpenCode tool IDs `edit`, `write`, and
`apply_patch`. The experimental alias surface intentionally owns `edit` and `apply_patch` while still
hiding and rejecting `write`. Neither mode intercepts shell redirection, scripts, language servers,
formatters, MCP tools, or another plugin's I/O. Use OpenCode permissions and OS isolation for
adversarial workloads.

### Native-alias ownership

OpenCode's V1 plugin API does not expose final executable ownership. A later configured plugin, directory
tool, or MCP tool can replace `edit` or `apply_patch`; a later after-hook can remove or rewrite a
valid result marker. Matching schemas are not proof of matching executors, and historical markers
are evidence only for the persisted completed or exactly attested rejected call. Process-local session binding proves a stable protocol/history identity, not ongoing registry ownership. Alias mode therefore trusts plugin ordering, requires Better Hashline to be the last external collider, and must be reverified after configuration changes. It cannot provide the default unique IDs' collision isolation or continuous-ownership claim.

### Privileged filesystem attacks

An attacker able to change directories, mounts, ACLs, junctions, or files despite process permissions may defeat user-space checks. Network filesystems and Windows reparse/open-handle behavior can differ from local POSIX rename assumptions.

### Process compromise

Snapshot bytes and IDs live in process memory. Code executing in the same process can inspect or mutate state. Snapshot IDs are opaque addressing tokens, not authentication secrets.

## Security Properties

| Property | Scope |
| --- | --- |
| Snapshot freshness | Exact byte equality in strict mode |
| Target identity | Canonical path plus stable file metadata checks |
| Relocation | Exact selected-base evidence, agreement across successful bounded contexts, and ambiguity rejection at copied edges |
| Batch validation | One immutable pre-batch file, declared read/write effects checked before mutation |
| Permission binding | Exact planned unified diff before approval |
| Publication visibility | At most one final replacement attempt where rename supports it |
| New file safety | Staged exclusive temporary file, no-replace hard-link publication, and post-publication identity/byte checks |
| Memory bounds | Global, session, path, byte, and TTL limits |
| Alias history | Bounded completed/rejected-call validation and one exact process-local protocol binding per session |
| Alias concurrency | Sequential before binding; after binding, per-canonical-path locks and independent approval/publication outcomes |
| Alias renderer metadata | Exact contract measured before publication and capped at 1 MiB |

Transfer operations are source-referenced compound edits. Copy requires complete source provenance plus destination-boundary provenance. Move requires complete provenance for the source-to-destination corridor because logical texts are permuted over its positional EOL slots. Exact-unique relocation maps every source, corridor, and destination anchor through one cumulative budget, then rejects changed topology. Copy amplification is projected against configured output limits before materializing the final document. Projection composes CRLF across segment boundaries, and move rendering is reparsed against its expected logical texts and EOL slots. This prevents empty-text moves from merging a lone CR with a relocated LF or changing the no-phantom EOF model.

## Metadata

The plugin attempts to preserve executable mode and ownership where supported. It does not claim preservation of every ACL, xattr, alternate stream, creation time, hardlink relationship, or directory durability property. Existing hardlinks and read-only files are rejected to avoid pretending those semantics are preserved.

## Sensitive Data

Snapshots retain complete file bytes in memory for up to the configured TTL and cache limits. Tool output is subject to OpenCode's own transcript/history handling. Native alias completion metadata contains the canonical path, relative path, exact unified diff, and a canonical-path digest because stock renderers require those fields. A completed non-mutating `DISPLAY_PREFIX_REJECTED` result contains no file payload or diff, but records protocol identity, canonical input and worktree digests, payload coordinate, and a bounded prefix kind.

Ordinary exports retain this metadata; OpenCode's sanitized export removes the tool metadata but retains a safe root-relative session locator. Review even sanitized exports before disclosure. Removing a completion or rejection marker makes that history unusable for alias continuation. Benchmark model traces may contain fixture or model output and are ignored by Git by default under `benchmarks/results/model/`; review and redact them before publication.

Do not benchmark proprietary repositories or secrets without an explicit data-handling policy.

## Reporting

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](../SECURITY.md) and use GitHub private vulnerability reporting.
