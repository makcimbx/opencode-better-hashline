# Threat Model

## Protected Outcomes

Better Hashline is designed to prevent these failures during cooperative agent editing:

- applying an edit to bytes different from the approved strict snapshot;
- selecting a wrong duplicate target through fuzzy or nearest matching;
- accepting only range endpoints while an interior line changed;
- composing overlapping or same-boundary operations;
- editing a line that was retained internally but not issued to the model;
- bypassing normal OpenCode read/edit/external-directory permission decisions;
- silently overwriting an existing path through the create tool;
- following a retargeted symlink without reauthorization;
- returning success when post-publication bytes differ from the plan.

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

`enforce: true` hides and rejects OpenCode tool IDs `edit`, `write`, and `apply_patch`. It does not intercept shell redirection, scripts, language servers, formatters, MCP tools, or another plugin's I/O. Use OpenCode permissions and OS isolation for adversarial workloads.

### Privileged filesystem attacks

An attacker able to change directories, mounts, ACLs, junctions, or files despite process permissions may defeat user-space checks. Network filesystems and Windows reparse/open-handle behavior can differ from local POSIX rename assumptions.

### Process compromise

Snapshot bytes and IDs live in process memory. Code executing in the same process can inspect or mutate state. Snapshot IDs are opaque addressing tokens, not authentication secrets.

## Security Properties

| Property | Scope |
| --- | --- |
| Snapshot freshness | Exact byte equality in strict mode |
| Target identity | Canonical path plus stable file metadata checks |
| Relocation | Exact non-normalized text/EOL and unique bounded context |
| Batch validation | One file, all operations before mutation |
| Permission binding | Exact planned unified diff before approval |
| Publication visibility | At most one final replacement attempt where rename supports it |
| New file safety | Staged exclusive temporary file plus no-replace hard-link publication |
| Memory bounds | Global, session, path, byte, and TTL limits |

## Metadata

The plugin attempts to preserve executable mode and ownership where supported. It does not claim preservation of every ACL, xattr, alternate stream, creation time, hardlink relationship, or directory durability property. Existing hardlinks and read-only files are rejected to avoid pretending those semantics are preserved.

## Sensitive Data

Snapshots retain complete file bytes in memory for up to the configured TTL and cache limits. Tool output is subject to OpenCode's own transcript/history handling. Benchmark model traces may contain fixture or model output and are ignored by Git by default under `benchmarks/results/model/`; review and redact them before publication.

Do not benchmark proprietary repositories or secrets without an explicit data-handling policy.

## Reporting

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](../SECURITY.md) and use GitHub private vulnerability reporting.
