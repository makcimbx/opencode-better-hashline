<p align="center">
  <img src="docs/assets/hero.svg" alt="Better Hashline for OpenCode" width="100%" />
</p>

<h1 align="center">OpenCode Better Hashline</h1>

<p align="center">
  A fail-closed, snapshot-bound editing protocol for OpenCode agents.
</p>

<p align="center">
  <a href="https://github.com/makcimbx/opencode-better-hashline/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/makcimbx/opencode-better-hashline/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/opencode-better-hashline"><img alt="npm" src="https://img.shields.io/npm/v/opencode-better-hashline?color=72f1b8" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-5ac8fa" /></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-9db2cc" /></a>
</p>

Most line-hash tools put a tiny checksum next to every line, then trust that checksum when writing. Better Hashline takes a different approach: the model gets compact native line numbers, while the plugin retains the exact bytes behind an opaque snapshot ID. Short hashes are display hints in many implementations; here they are never the authority.

| Property | Better Hashline behavior |
| --- | --- |
| Freshness | Exact retained bytes, not an 8/12/16-bit tag |
| Addressing | Familiar `N|content` lines plus a random 128-bit snapshot ID |
| Stale edits | Reject by default; optional exact and unique textual relocation |
| Batches | Parse, validate, relocate, and overlap-check before mutation |
| Permissions | Reuses OpenCode's `read`, `edit`, and `external_directory` permissions |
| Publication | Same-directory temporary file, flush, identity recheck, one rename attempt |
| Native tools | Keeps native `read`; hides and blocks `edit`, `write`, and `apply_patch` by default |

> [!IMPORTANT]
> This is a safety-oriented editing transport, not a filesystem transaction or a security sandbox. Shell commands and hostile external writers remain outside the guarantees. Read the [threat model](docs/threat-model.md) before relying on it in sensitive environments.

## Install

Requirements: [OpenCode](https://opencode.ai/) `>=1.18.3 <2` and Bun `>=1.3.0`.

```sh
opencode plugin opencode-better-hashline
```

Or add the package to `opencode.json`:

```json
{
  "plugin": ["opencode-better-hashline"]
}
```

Restart OpenCode after changing plugin configuration. Better Hashline is enabled with conservative defaults and no required options.

Verify the loaded package before relying on enforcement:

```sh
opencode debug agent build --tool hashline_read --params '{"filePath":"README.md","limit":1}'
```

The output must start with `@hashline snapshot=`. OpenCode may continue without this plugin if the package itself cannot be imported, in which case native mutators remain available. Diagnostic fail-closed behavior begins only after the plugin module has loaded.

## How It Works

### 1. Read an editable snapshot

The agent calls `hashline_read` instead of native `read` for a UTF-8 text file it plans to modify:

```text
@hashline snapshot=s_J7yi7wDyv3j9xQ2zP5kL8A sha256=6d09c2db9f10 lines=3
1|export const retries = 2;
2|await connect();
3|return client;
@eof
```

The prefixes are annotations, not file content. A line shown as `N!|... [preview only; line not issued]` is too large for one configured output page and cannot be edited by line reference.

### 2. Submit logical line operations

```json
{
  "filePath": "src/client.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "operations": [
    {
      "op": "replace",
      "startLine": 1,
      "endLine": 1,
      "lines": ["export const retries = 5;"]
    },
    {
      "op": "insert",
      "afterLine": 2,
      "lines": ["await audit();"]
    }
  ]
}
```

`lines: []` deletes a replacement range. `lines: [""]` supplies one empty logical-line value; at an unterminated EOF this can add only the final delimiter rather than a phantom line. Payload lines may not contain embedded CR or LF characters.

Retained source ranges can also be transferred without echoing their contents:

```json
{
  "operations": [
    { "op": "copy_range", "startLine": 4, "endLine": 8, "afterLine": 20 },
    { "op": "move_range", "startLine": 30, "endLine": 34, "afterLine": 10 }
  ]
}
```

All coordinates describe the original snapshot, never an intermediate edit. Copy uses destination-local delimiters like `insert`. Move preserves the positional EOL layout and requires the complete source-to-destination corridor to have been issued. If empty texts and adjacent CR/LF bytes cannot be serialized without changing that logical layout, the move fails closed instead of normalizing delimiters. Mixed and multiple transfer batches are accepted only when all read and write effects are independent.

### 3. Validate and publish

The plugin resolves the canonical path, checks snapshot scope and issued ranges, rereads the file, plans every operation in memory, rejects overlap, asks OpenCode to approve the exact unified diff, rereads again, stages a same-directory temporary file, consumes the snapshot, and attempts one rename.

<p align="center">
  <img src="docs/assets/protocol.svg" alt="Better Hashline protocol lifecycle" width="100%" />
</p>

## Edit Modes

`rebase: "none"` is the default. Any byte change since `hashline_read` returns `TARGET_CHANGED` and requires a reread.

`rebase: "unique"` is explicit recovery for cooperative concurrent changes. It relocates only when exact non-normalized evidence identifies the selected base occurrence and every successful bounded context agrees. Insertion requires the original adjacent boundary to remain intact; copied BOF/EOF evidence is ambiguous. Transfer sources and destinations relocate independently through one bounded mapper, then must retain their complete original topology. It never chooses a nearest match, strips prefixes, repairs indentation, or inserts conflict markers.

Unique rebase proves textual relocation only. It does not prove semantic independence or edit-history causality.

## Configuration

OpenCode accepts plugin options as the second tuple element:

```json
{
  "plugin": [
    [
      "opencode-better-hashline",
      {
        "enforce": true,
        "toolSurface": "hashline",
        "maxFileBytes": 8388608,
        "maxLines": 100000,
        "maxCacheBytes": 67108864,
        "maxSnapshots": 64,
        "maxSnapshotsPerPath": 4,
        "maxSnapshotsPerSession": 32,
        "snapshotTtlMs": 1800000,
        "maxOutputBytes": 40960,
        "maxContextLines": 4
      }
    ]
  ]
}
```

| Option | Default | Purpose |
| --- | ---: | --- |
| `enforce` | `true` | Hide and reject native `edit`, `write`, and `apply_patch` |
| `toolSurface` | `"hashline"` | Tool-ID surface; `"native-aliases"` is an experimental OpenCode 1.18.3-only preview |
| `maxFileBytes` | 8 MiB | Maximum editable or creatable text file |
| `maxLines` | 100,000 | Maximum logical lines per editable file |
| `maxCacheBytes` | 64 MiB | Approximate retained snapshot memory budget |
| `maxSnapshots` | 64 | Process-wide retained snapshot count |
| `maxSnapshotsPerPath` | 4 | Retained revisions per session and canonical path |
| `maxSnapshotsPerSession` | 32 | Retained snapshots per OpenCode session |
| `snapshotTtlMs` | 30 minutes | Snapshot lifetime |
| `maxOutputBytes` | 40 KiB | Model-visible `hashline_read` output budget |
| `maxContextLines` | 4 | Exact context on each side for `unique` rebase |

Unknown or inconsistent options put the plugin into a diagnostic fail-closed mode: native mutators remain hidden and every Better Hashline tool returns `CONFIG_INVALID`. Fix the configuration and restart OpenCode. `maxCacheBytes` must be at least three times `maxFileBytes`.

Set `enforce: false` only for migration or A/B evaluation. It leaves native mutators enabled and changes the system instruction from required to preferred usage.

### Experimental native aliases

`toolSurface: "native-aliases"` keeps the Better Hashline snapshot executor but publishes it as
`edit` on non-GPT routes and `apply_patch` on GPT-5-like patch routes so stock OpenCode can use its
native diff renderers. It requires `enforce: true`, exact OpenCode `1.18.3`, a restart, and a new
session:

```json
{
  "plugin": [
    [
      "opencode-better-hashline",
      { "enforce": true, "toolSurface": "native-aliases" }
    ]
  ]
}
```

The mode still exposes unique `hashline_read` and create-only `hashline_write`; it never aliases
native `write`. Native-shaped edit or patch calls reject with `INVALID_ARGUMENT`. Host, schema, or
session incompatibility fails closed without falling back to a builtin or to `hashline_edit`.

Run the credential-free clean-room verifier after installation and after every plugin-order or
configuration change:

```sh
bunx opencode-better-hashline verify --surface all
```

The verifier checks both model routes, schemas, malformed-call confinement, hooks, exact bytes,
resumed, forked, and imported edits, sanitized export behavior, stock terminal rendering, pinned
GPT-4/GPT-OSS/GPT-5 routing, wildcard/path edit permissions, protocol fingerprints, and rollback to
unique IDs in an isolated configuration. It is a package self-test, not
an audit of your merged
OpenCode configuration. It cannot prove continuous executor ownership: a later plugin or MCP tool can
replace an alias, and a later after-hook can mutate persisted output. Keep Better Hashline last among
plugins that define `edit` or `apply_patch`.

Native-looking IDs persist in session history. Removing the plugin or changing surfaces can leave old
native-looking cards while new calls resolve to OpenCode builtins; do not continue or import that
session for editing. Rejected native-shaped calls may consume an extra model retry. Unsanitized exports
and shares contain paths and diffs. Sanitized exports remove tool paths, diffs, and protocol markers but
OpenCode 1.18.3 retains a safe root-relative session locator; review it before disclosure. The removed
marker makes alias continuation fail closed. ACP can classify the alias as an edit but cannot reconstruct the
native structured diff from Better Hashline metadata. The unique `hashline` surface remains the
production recommendation until the completed paid pilot evidence passes the remaining release review in the
[preview plan](docs/native-alias-preview-plan.md).

Native-alias pilots v1, v3, v4, v5, and v6 stopped fail-closed on terminal benchmark incidents and cannot
resume or retry. Their privacy-safe incident records are tracked under `benchmarks/results/`. Pilot v7
completed all 48 Luna/Sol sessions across the unique and native-alias surfaces with complete accounting,
zero retries/failures/timeouts, and USD 0 reported cost. The privacy-safe summary is tracked under
`benchmarks/results/`; native aliases remain unreleased pending explicit release review.

## Why No Per-Line Hash?

A short per-line hash can help a model copy an address, but it cannot safely establish freshness:

- A fixed changed target passes an 8-bit check with probability `1/256` and a 16-bit check with probability `1/65,536`.
- Among 1,000 identities, the probability of at least one 16-bit collision is about `99.95%`.
- Endpoint-only checks do not detect changes inside a multiline range.
- Wider hashes add prompt bytes without solving permission, overlap, race, or publication problems.

Better Hashline therefore separates model-facing addressing from server-side authority. The public format stays compact; freshness uses exact retained bytes and full SHA-256 internally. Per-line hashes remain a benchmark arm, not a production dependency.

## Evidence

The latest checked-in transfer corpus has 28 exact, stale, collision, ambiguity, boundary,
overlap, encoding, and transfer scenarios. The earlier 15-case and 21-case results remain immutable
historical evidence. Comparison arms are deliberately small protocol simulations, not complete
implementations of third-party tools. On the latest recorded Windows x64 run:

| Adapter | Unsafe accepts | False rejects |
| --- | ---: | ---: |
| Better Hashline, strict | 0 | 5 |
| Better Hashline, explicit unique rebase | 0 | 0 |
| Target-only exact search/replace | 5 | 1 |
| Line numbers only | 21 | 0 |
| 8-bit endpoint hashes | 6 | 4 |
| 16-bit endpoint hashes | 5 | 4 |

This corpus tests in-memory protocol mechanics only; it does not exercise OpenCode hooks, permissions, or filesystem publication. The target-only exact search arm's single false reject is the duplicate-target case that equivalent exact context can resolve; its unsafe accepts are stale selected-target and boundary cases that a stronger revision/context protocol could reject. The table does not establish an addressing-format advantage. It is intentionally not evidence that one format makes a language model better at software engineering. The opt-in paired model harness defaults to a dry run and requires explicit cost acknowledgement; no model-comparison result is claimed yet. The full chart is kept with the [benchmark methodology](docs/benchmarks.md), not as a headline product claim.

```sh
bun run bench
bun run bench:model
```

See [benchmark methodology and raw results](docs/benchmarks.md), [prior-art audit](docs/research.md), and the [reproducibility guide](benchmarks/README.md).

## Compatibility

| Component | Status |
| --- | --- |
| OpenCode 1.18.3 stable V1 plugin API | Tested |
| Experimental native aliases | OpenCode 1.18.3 only; explicit opt-in |
| Windows, Linux, macOS | CI and filesystem tests |
| UTF-8, optional BOM, LF, CRLF, mixed EOL, lone CR | Supported |
| Directories, images, PDFs, binary files | Use native `read`; not editable here |
| Hardlinks, special files, read-only targets | Rejected |
| OpenCode V2 plugin API | Not supported |

The custom read tool intentionally does not imitate OpenCode's native media attachments, directory listing, instruction tracking, LSP warmup, or specialized UI rendering. Native `read` remains available for those jobs.

## Limitations

- The process-local path lock coordinates this plugin instance, not other processes.
- There is an unavoidable check-to-rename window against hostile external writers; this is not kernel CAS.
- A one-file batch is validation-atomic, but there is no multi-file transaction.
- Rename atomicity, directory durability, ACLs, xattrs, hardlinks, network filesystems, and Windows open-handle behavior vary by platform.
- Create-only `hashline_write` requires same-directory hard-link support for no-replace publication. A detected race after the link can leave the new file committed, but returns failure and never deletes a possibly newer writer's path.
- Executable mode and ownership are preserved where supported; all metadata preservation is not promised.
- `enforce` blocks OpenCode's native mutator tool IDs, but it does not sandbox shell commands or other plugins.
- Native aliases cannot attest final registry ownership or prevent later hooks from mutating renderer metadata.
- Snapshot caches are in memory and disappear on restart, expiry, eviction, or successful publication.

Full boundaries and trust assumptions are in [docs/threat-model.md](docs/threat-model.md).

## Project Docs

- [Protocol specification](docs/protocol.md)
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Research and prior art](docs/research.md)
- [Benchmarks](docs/benchmarks.md)
- [Experimental native-alias preview plan](docs/native-alias-preview-plan.md)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Citation metadata](CITATION.cff)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun run build
bun run pack:check
```

The suite currently covers protocol logic, snapshot provenance and eviction, output truncation, permission flow, symlinks and hardlinks, filesystem races, create-only concurrency, OpenCode hooks, tool suppression, BOM/EOL behavior, and package loading.

## License

[MIT](LICENSE) Copyright (c) 2026 Maksim Ivanov.
