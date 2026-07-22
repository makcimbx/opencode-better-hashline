# Threat Model

## Protected Outcomes

Better Hashline is designed to prevent these failures during cooperative agent editing:

- applying an edit, delete, or move to bytes different from the approved strict snapshot;
- selecting a wrong duplicate target through fuzzy or nearest matching;
- accepting only range endpoints while an interior line changed;
- composing overlapping or same-boundary text operations;
- mutating content that was retained internally but not issued to the model;
- copying retained source text that was not issued to the model;
- moving through unseen corridor content or composing a range move from evolving coordinates;
- deleting or moving a file without complete issued BOF-to-EOF source coverage;
- deleting or moving through a terminal symlink or a changed direct source/parent binding;
- overwriting any existing move destination, including a symlink, or creating its parent;
- moving across filesystems or publishing without authorizing both canonical paths;
- bypassing normal OpenCode read/edit/external-directory permission decisions;
- silently overwriting an existing path through the create tool;
- following a retargeted text-edit symlink without reauthorization;
- returning success when post-publication bytes or path state differ from the plan;
- rolling back a partially published move in a way that could delete a newer writer's entry;
- writing model-facing line annotations that were copied into an edit payload;
- claiming native-alias concurrency before exact binding or across overlapping path sets;
- continuing a bound alias session after `PARTIAL_PUBLICATION`.

## Trusted Components

- The OpenCode process and stable V1 plugin hook implementation.
- Bun and Node-compatible filesystem/crypto primitives used by the plugin.
- The operating system's path, descriptor, flush, rename, hard-link, unlink, and identity semantics.
- The configured OpenCode permission policy and human approval UI.
- Other code loaded into the same OpenCode process.

The model is not trusted to copy annotations correctly, choose unique targets, detect staleness, or honor prose instructions by itself. Those checks are enforced in code.

## Adversaries Outside Scope

### Hostile concurrent writers

For text replacement, the plugin rereads immediately before rename, but ordinary portable
filesystems do not expose a universal conditional rename over exact prior bytes. Another process can
write in the final check-to-rename interval. Lifecycle operations similarly revalidate direct names,
parents, and destination absence before publication, but a hostile writer can replace a leaf or parent
during the final check-to-`link`/`unlink` syscall interval, and portable Node/Bun APIs provide no
descriptor-relative conditional unlink. Such a race can affect the replacement entry. Hard-link
creation plus source unlink is also not transactional; post-publication verification can detect some
races and partial states but cannot safely roll them back over an even newer writer. Use OS isolation
when uncoordinated writers are in scope.

### Shell and other plugins

On the default surface, `enforce: true` hides and rejects OpenCode tool IDs `edit`, `write`, and
`apply_patch`. The experimental alias surface intentionally owns `edit` and `apply_patch` while still
hiding and rejecting `write`. Neither mode intercepts shell redirection, scripts, language servers,
formatters, MCP tools, or another plugin's I/O. Use OpenCode permissions and OS isolation for
adversarial workloads.

### Native-alias ownership

OpenCode's V1 plugin API does not expose final executable ownership. A later configured plugin,
directory tool, or MCP tool can replace `edit` or `apply_patch`; a later after-hook can remove or
rewrite a valid result marker. Matching schemas are not proof of matching executors, and historical
`native-aliases/v2` markers are evidence only for the exact persisted completed or attested rejected
call. Process-local session binding proves a stable protocol/history identity, including lifecycle
operation and source/destination correlation, not ongoing registry ownership. Alias mode therefore
trusts plugin ordering, requires Better Hashline to be the last external collider, and must be
reverified after configuration changes. It cannot provide the default unique IDs' collision
isolation or continuous-ownership claim. V1 history is incompatible and cannot bind a v2 session.

### Privileged filesystem attacks

An attacker able to change directories, mounts, ACLs, junctions, links, or files despite process
permissions may defeat user-space checks. Network filesystems and Windows reparse/open-handle
behavior can differ from the local hard-link, unlink, and rename assumptions required here.

### Process compromise

Snapshot bytes and IDs live in process memory. Code executing in the same process can inspect or mutate state. Snapshot IDs are opaque addressing tokens, not authentication secrets.

## Security Properties

| Property | Scope |
| --- | --- |
| Snapshot freshness | Exact byte equality in strict mode |
| Issued authority | Required text ranges/boundaries, or complete lifecycle BOF-to-EOF source coverage |
| Target identity | Canonical path plus stable metadata; lifecycle also requires direct terminal and parent binding |
| Relocation | Exact selected-base evidence, agreement across successful bounded contexts, and ambiguity rejection at copied edges |
| Text-batch validation | One immutable pre-batch file, declared read/write effects checked before mutation |
| Permission binding | Exact planned patch and complete source/destination path set before approval |
| New file safety | Staged exclusive temporary file, no-replace hard-link publication, and post-publication identity/byte checks |
| Delete safety | Direct regular single-link source revalidated before exact unlink and absence verification |
| Move safety | Existing stable parents, same filesystem, absent destination, no-clobber hard link, exact inode/byte/link-count verification, then source unlink |
| Partial move safety | No destructive rollback; affected snapshots invalidated, explicit `PARTIAL_PUBLICATION`, and bound alias session poisoned |
| Memory bounds | Global, session, path, byte, and TTL limits |
| Alias history | Bounded v2 completed/rejected-call validation with exact operation and source/destination metadata correlation |
| Alias concurrency | Sequential before binding; after binding, deterministic locks serialize overlapping canonical path sets |
| Alias renderer metadata | Exact contract measured before publication and capped at 1 MiB |

Transfer operations are source-referenced compound text edits. Copy requires complete source
provenance plus destination-boundary provenance. Move requires complete provenance for the
source-to-destination corridor because logical texts are permuted over its positional EOL slots.
Exact-unique relocation maps every source, corridor, and destination anchor through one cumulative
budget, then rejects changed topology. Copy amplification is projected against configured output
limits before materializing the final document. Projection composes CRLF across segment boundaries,
and move rendering is reparsed against its expected logical texts and EOL slots. This prevents
empty-text moves from merging a lone CR with a relocated LF or changing the no-phantom EOF model.

File lifecycle operations are not text transfers. They are sole, strict operations planned outside
`planEdits`; line fields, readback, unique relocation, overwrite, parent creation, and cross-filesystem
movement are unavailable. Their exact delete/move patch and v2 metadata are immutable across
approval. Delete revalidates the direct terminal binding before unlink. Move publishes destination
first with a verified hard link and can therefore truthfully report a nontransactional state in
which both names remain.

## Metadata

The plugin attempts to preserve executable mode and ownership for text replacement where supported.
It does not claim preservation of every ACL, xattr, alternate stream, creation time, hardlink
relationship, or directory durability property. Existing hardlinks and unsupported metadata states
are rejected rather than pretending those semantics are preserved. Lifecycle operations preserve
the source inode rather than recreating file content, but do not claim transactional rename or
directory durability.

## Sensitive Data

Snapshots retain complete file bytes in memory for up to the configured TTL and cache limits. Tool
output is subject to OpenCode's own transcript/history handling. Native alias completion metadata
contains source and destination paths as applicable, relative paths, exact unified diff, operation,
canonical source digest, and move destination digest because stock renderers and v2 history
validation require those fields. Delete diffs can contain the complete deleted fixture; path-only
moves can be zero-hunk. A completed non-mutating `DISPLAY_PREFIX_REJECTED` result contains no file
payload or diff, but records protocol identity, canonical input and worktree digests, payload
coordinate, and a bounded prefix kind.

Ordinary exports retain this metadata; OpenCode's sanitized export removes the tool metadata but
retains a safe root-relative session locator. Review even sanitized exports before disclosure.
Removing a completion or rejection marker makes that history unusable for alias continuation.
Benchmark model traces may contain fixture or model output and are ignored by Git by default under
`benchmarks/results/model/`; review and redact them before publication.

Do not benchmark proprietary repositories or secrets without an explicit data-handling policy.

## Reporting

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](../SECURITY.md) and use GitHub private vulnerability reporting.
