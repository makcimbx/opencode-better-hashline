# Architecture

Better Hashline is intentionally split into pure protocol logic, bounded state, filesystem publication, and a thin OpenCode adapter.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/text.ts` | Fatal UTF-8 decoding, BOM/EOL model, byte-preserving encode, payload validation |
| `src/snapshots.ts` | Opaque IDs, exact bytes/SHA-256, scope, issued provenance, TTL/LRU limits |
| `src/render.ts` | Byte-bounded `N|content` pages and preview-only oversized lines |
| `src/presentation.ts` | Experimental native-alias metadata, canonical fingerprints, and serialized-size measurement |
| `src/native-alias.ts` | Bounded exact-host detection through OpenCode's configured SDK transport |
| `src/session-protocol.ts` | Bounded persisted-history validation and instance-local alias session binding |
| `src/rebase.ts` | Exact unique range/boundary relocation with a cumulative comparison budget |
| `src/edits.ts` | Operation validation, transfer effect analysis, immutable planning, bounded projection, final bytes |
| `src/filesystem.ts` | Canonicalization, OpenCode permissions, stable reads, locks, publication |
| `src/plugin.ts` | Tool schemas, hooks, native-mutator enforcement, lifecycle integration |
| `src/index.ts` | Public library exports and OpenCode `PluginModule` |
| `src/server.ts` | Modern OpenCode `./server` package entrypoint |
| `src/verify.ts`, `src/cli.ts` | Credential-free packed OpenCode route, schema, hook, export/import, and renderer verification |

## Design Boundaries

### Addressing is not authority

The model addresses logical lines by ordinary one-based numbers. Authority comes from a random snapshot ID bound to exact retained bytes, session, worktree, and canonical path. This makes display width independent of collision resistance.

### Read provenance is explicit

The snapshot store distinguishes bytes retained by the process from line references actually issued to a model. A range cannot be edited when an interior line was omitted or rendered preview-only. Issuance occurs after the host's generic truncation layer, not when the tool initially constructs output.

### Planning is pure

`planEdits` receives base and current immutable text documents and returns final text/bytes or a stable rejection. It performs no I/O and asks no permission. This makes exhaustive and property testing possible without weakening the filesystem path.

Transfer-containing batches are one simultaneous transformation over the pre-batch document. Copy reads retained logical texts and inserts them with destination-local EOL rules. Move rewrites one source-to-destination corridor by permuting texts over fixed positional EOL slots. A declarative read/write effect graph rejects dependencies instead of giving operation array order sequential meaning. Projected text statistics compose CRLF across planned segment boundaries; after bounded projection, every move is rendered lazily and reparsed to prove that its expected logical texts and positional EOL slots remain representable.

### Permissions approve a fixed plan

The exact diff is created before `context.ask({ permission: "edit" })`. After approval, current bytes and identity are checked again. The plugin does not silently rebase and ask approval for one diff while writing another.

### Publication is separate from conflict detection

Conflict detection uses exact bytes and identity. Same-directory temp plus rename improves visibility and crash behavior where the filesystem supports it, but does not create conditional compare-and-swap. The distinction is explicit in API errors and documentation.

## OpenCode Integration

The npm package default-exports a modern `PluginModule` and exposes both root and `./server` exports. OpenCode's stable V1 loader prefers the server entrypoint.

The default unique tool IDs avoid three OpenCode hazards:

- later registry collisions silently replacing a builtin;
- model-dependent filtering of exact IDs such as `edit` and `apply_patch`;
- inability to call a displaced builtin for media or directory reads.

The plugin keeps native `read` and adds `hashline_read`, `hashline_edit`, and `hashline_write`. With `enforce: true`, `chat.message` disables native mutator IDs on every user turn and `tool.execute.before` is a second tripwire. This is defense in depth, not a shell sandbox.

The explicit native-alias preview instead registers Better Hashline's shared executor as `edit` and
`apply_patch`, lets OpenCode 1.18.3 retain one by model route, and preserves unique read/create tools.
Activation uses the host-configured SDK transport, exact host and schema fingerprints, bounded
session-history validation, double argument parsing, and native renderer metadata. Registry ownership
still cannot be attested, so this surface does not replace the unique-ID recommendation.

## State and Eviction

Snapshots are process-memory objects. Retained weight accounts for raw bytes plus decoded UTF-16 text. Limits apply globally, per session, and per session/path. LRU and TTL eviction skip pinned edits. If all eligible entries are pinned or one file cannot fit the configured budget, the operation rejects rather than exceeding the budget silently.

A successful or attempted publication transition invalidates prior snapshots for the path. The agent must reread before another edit. Multiple exact reads can reuse one retained snapshot only when digest and bytes both match.

## Filesystem Model

Existing files resolve through symlinks to a canonical target. The canonical target is authorized, locked, reread, and published. Alias stability is checked around reads and before publication. New files resolve a canonical existing parent and reject pre-existing terminal symlinks.

Supported existing targets are regular, single-link, writable files within the size limit. Hardlinks are rejected because replacing one directory entry breaks alias expectations. Special files and unsupported metadata states reject.

The process-global lock key is the canonical physical path, case-folded on Windows. It serializes cooperating plugin calls in one process. It cannot coordinate another OpenCode process, formatter, editor, daemon, or network client.

## Testing Strategy

The test suite has separate layers:

- pure text, relocation, and edit planner tests;
- snapshot provenance, TTL, pinning, and byte-budget tests;
- renderer truncation and UTF-8 budget tests;
- real temporary-filesystem tests for symlinks, hardlinks, races, modes, and no-replace creation;
- plugin contract tests with fake OpenCode contexts and real tool/hook definitions;
- packed-tarball installation, root/server/CLI entrypoint checks, and deterministic stock OpenCode sessions for unique, non-GPT alias, and GPT-like alias routes;
- collision fixtures for registration order, same-schema replacement, namespaced MCP controls, and later output mutation;
- deterministic non-gating benchmarks and an opt-in model harness.

Timing benchmarks never gate shared CI. Safety regressions do.

## Future-Compatible Seams

Potential extensions should stay behind explicit protocol fields:

- provider-specific or task-adaptive display formats;
- stronger platform-specific conditional replacement primitives;
- OpenCode-native UI metadata when a public API exists;
- an experimental per-line tag A/B arm, never promoted to authority;
- multi-file plans with truthful partial-result reporting or a real transaction primitive.

Do not add silent compatibility fallbacks. A format change should fail clearly and ship with fixtures and benchmark evidence.
