<p align="center">
  <img src="docs/assets/hero.svg" alt="Better Hashline for OpenCode" width="100%" />
</p>

<h1 align="center">OpenCode Better Hashline</h1>

<p align="center">
  <strong>Exact snapshots. Compact line refs. Edits that fail closed.</strong>
</p>

<p align="center">
  A safety-oriented editing protocol for OpenCode agents that binds every mutation to exact snapshot evidence the agent actually read.
</p>

<p align="center">
  <a href="https://github.com/makcimbx/opencode-better-hashline/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/makcimbx/opencode-better-hashline/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/opencode-better-hashline"><img alt="npm" src="https://img.shields.io/npm/v/opencode-better-hashline?color=72f1b8" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-5ac8fa" /></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-9db2cc" /></a>
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#evidence">Evidence</a> ·
  <a href="#project-docs">Docs</a>
</p>

| Exact evidence | Operation-aware defaults | OpenCode-native controls | Guarded publication |
| :--- | :--- | :--- | :--- |
| Retained file bytes, not tiny per-line checksums | Incremental omission uses exact unique relocation; `replace_file` and lifecycle omissions stay strict | Existing read, edit, and external-directory permissions | Plan once, recheck identity, publish without overwrite |

> [!IMPORTANT]
> Better Hashline is an editing transport, not a filesystem transaction or a security sandbox. Shell commands and hostile external writers remain outside its guarantees. Read the [threat model](docs/threat-model.md) before relying on it in sensitive environments.

## Quick Start

**Requirements:** [OpenCode](https://opencode.ai/) `>=1.18.3 <2` and Bun `>=1.3.0`.

```sh
opencode plugin opencode-better-hashline
```

Or add the package to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-better-hashline"]
}
```

Restart OpenCode after changing plugin configuration. Operation-aware defaults are enabled automatically; no options are required.

Verify that the package loaded before relying on enforcement:

```sh
opencode debug agent build --tool hashline_read --params '{"filePath":"README.md","limit":1}'
```

The output must start with `@hashline snapshot=`. OpenCode may continue without the plugin if the package itself cannot be imported, in which case native mutators remain available. Diagnostic fail-closed behavior begins only after the plugin module has loaded.

## Why Exact Snapshots?

Most line-hash tools place a tiny checksum next to every line and trust it when writing. Better Hashline keeps model-facing addresses compact while retaining the exact file bytes behind an opaque snapshot ID. Short hashes may be useful display hints; here they are never freshness authority.

| Property | Better Hashline behavior |
| --- | --- |
| Freshness | Exact retained bytes, not an 8/12/16-bit tag |
| Addressing | Familiar `N|content` lines plus a random 128-bit snapshot ID |
| Stale edits | Omitted incremental batches use exact unique textual relocation; explicit `none` requires full-byte freshness |
| Batches | Parse, validate, relocate, and overlap-check before mutation |
| Permissions | Reuses OpenCode's `read`, `edit`, and `external_directory` permissions |
| Publication | Same-directory temporary file, flush, identity recheck, one rename attempt |
| Native tools | Keeps native `read`; hides and blocks `edit`, `write`, and `apply_patch` by default |

## How It Works

### 1. Read an editable snapshot

The agent calls `hashline_read` instead of native `read` for a UTF-8 text file it plans to modify:

```text
@hashline snapshot=s_J7yi7wDyv3j9xQ2zP5kL8A sha256=6d09c2db9f10 lines=3 coverage=complete
1|export const retries = 2;
2|await connect();
3|return client;
@eof
```

The prefixes are annotations, not file content. A line shown as `N!|... [preview only; line not issued]` is too large for one configured output page and cannot be edited by line reference. Pagination cannot issue that line; raise `maxOutputBytes` within its configured cap when safe, or stop and restructure the file manually without treating the preview as source content.

The header's `lines=<count>` value is the file's total logical-line count. Every `@hashline` header also reports `coverage=partial|complete`, computed from evidence already issued when that page is rendered plus the candidate page itself. `coverage=complete` means those inputs are sufficient for cumulative editable BOF-to-EOF coverage; if the candidate remains valid and that exact page is delivered and attested, completeness is monotonic as other pages issue. `coverage=partial` means those inputs were not sufficient at render time, but another page delivered and attested later or out of order may complete the snapshot and make the prediction conservative. Rendering and pending output issue nothing, and an invalidated candidate issues nothing.

`partial=true` remains page-local: it means this rendered page alone does not contain complete editable BOF-to-EOF evidence. It can therefore coexist with `coverage=complete` when evidence issued at render time plus this candidate page is sufficient for cumulative coverage. Displayed `N|` refs become editable only after delivery attestation; `N!|` previews never do.

`offset` is one-based and defaults to 1. Requested `limit` accepts `1..100,000` and defaults to 1,000. The configured `maxOutputBytes` is authoritative (40 KiB by default, with a 45 KiB maximum), so a page can stop before the requested line count. `@more` means rendering stopped before EOF; `@eof` means the cursor reached EOF, and `partial=true` may accompany either.
Coverage diagnostics may suggest following `@more` with calls capped at a conservative 1,000 lines; that recovery chunk is not the public requested-limit ceiling.

### 2. Submit logical line operations

```json
{
  "filePath": "src/client.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "readbackLimit": 100,
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

`replace` removes the exact one-based inclusive `startLine..endLine` range, and `lines` is the complete replacement; neighboring lines outside the range remain, so do not repeat retained context unless intentional. `lines: []` deletes the range. `lines: [""]` supplies one empty logical-line value; at an unterminated EOF this can add only the final delimiter rather than a phantom line. Payload lines may not contain embedded CR or LF characters.

Because this example omits `rebase` and contains only incremental operations, it resolves to exact, ambiguity-rejecting `unique` relocation. Send `"rebase": "none"` when the call must require the complete current file bytes to equal the snapshot.

For a sole `replace_file`, omitted `rebase` resolves to strict `none`. It is a text operation, requires complete issued coverage, and supports explicitly requested readback; it never requests readback automatically. Omitting `finalNewline` preserves the snapshot state when `lines` is non-empty. `lines: []` alone writes an empty file by inferring `finalNewline:false`; explicit `true` with an empty payload remains invalid.

Column-zero positive decimal annotations such as `17|`, `17!|`, `@hashline`, `@more`, `@eof`, `@note`, and `@hashline-edit` are rejected in model-supplied payload lines. Set top-level `allowHashlinePrefixes: true` in the initial call only when that exact prefix is intentional source content. Numeric diagnostics are bounded to `N|` or `N!|`; the renderer never emits `0|` or zero-padded numbers. Native aliases persist this failure as a completed non-mutating terminal result for offline verifier and model-trace evidence. That persisted result does not establish live edit authority; after a restart, continuation requires a fresh delivered and attested `hashline_read`.

Batch every known change to one file in the same call. A successful edit starts with `Applied N operations.`; when current bytes differed and exact unique rebase succeeded, it starts with `Applied N operations. Exact unique rebase occurred.` instead. This reports stale-byte recovery, not necessarily a coordinate shift. The next line is `@hashline-edit previous=consumed successor=<state>`. `successor=none` or `unavailable` includes `next=hashline_read`; `successor=attached` is immediately followed by the new snapshot page.

For any text edit, including sole `replace_file`, set `readback:true` to request structural verification or a dependent follow-up edit with the default window. Supplying `readbackOffset` or `readbackLimit` also requests the same one contiguous successor page, so no separate flag is needed; explicit `readback:false` with either window is invalid. No text operation requests readback automatically. The page starts at the first post-edit hunk and requests 1,000 lines by default; `readbackOffset` selects a one-based start and `readbackLimit` accepts `1..100,000`. A successful mutation may report `successor=unavailable` instead of attaching it. The authoritative `maxOutputBytes` budget can stop rendering early: `@more` means before EOF, `@eof` means EOF was reached, and `partial=true` may accompany either. Every attached header preserves its render-time cumulative `coverage` prediction, but only a page attested as delivered issues refs; an invalidated candidate issues nothing. There is no ID-only successor: if OpenCode truncates or changes the continuation, the edit remains applied, the receipt changes to `successor=unavailable`, and a normal `hashline_read` is required.

Issued source ranges can also be transferred without echoing their contents:

```json
{
  "operations": [
    { "op": "copy_range", "startLine": 4, "endLine": 8, "afterLine": 20 },
    { "op": "move_range", "startLine": 30, "endLine": 34, "afterLine": 10 }
  ]
}
```

Every batch coordinate refers to the original immutable snapshot, never an intermediate result or a line created by another operation; do not shift later coordinates to account for earlier array entries. Copy always reads pre-edit source and uses destination-local delimiters like `insert`, so its source may overlap another operation's write. Move preserves the positional EOL layout and requires the complete source-to-destination corridor to have been issued. One `move_range` may compose with pairwise-disjoint `replace` operations wholly inside its intervening corridor and outside its source; the replacement payloads are applied to immutable pre-batch corridor content before the move permutation. If empty texts and adjacent CR/LF bytes cannot be serialized without changing that logical layout, the move fails closed instead of normalizing delimiters. Every other destructive conflict stays conservative. Insertion-like destinations may touch destructive endpoints but may not lie strictly inside them or share one boundary.

Whole-file deletion and rename/move use the same issued snapshot without echoing file contents:

```json
{ "operations": [{ "op": "delete_file" }] }
{ "operations": [{ "op": "move_file", "destinationPath": "src/renamed.ts" }] }
```

Only `delete_file` and `move_file` are lifecycle operations. Each must be the sole operation, uses omitted or explicit `rebase: "none"` for strict full-byte freshness, requires complete BOF-to-EOF issued coverage, and forbids `unique`. They never return successor readback and reject `readback:true`, `readbackOffset`, and `readbackLimit`. The source must be a direct regular single-link file. `move_file` requires an absent destination under an existing stable parent on the same filesystem; it never overwrites or creates directories. After a move, read the destination before editing it. Move publication uses an exclusive hard link followed by source unlink, so an unlink failure can leave both exact names and returns `PARTIAL_PUBLICATION` instead of risking an automatic rollback. Inspect and reconcile both paths before any retry.

`hashline_write` remains create-only; call its strict schema with only `filePath` and `content`. Every call freezes a plan from the deepest existing ancestor and automatically creates at most 64 missing directories. Every planned directory and the target are authorized and locked, missing directories are created exclusively from root to leaf, and the file uses staged no-clobber publication. With zero missing directories, the same path simply publishes the file without running `mkdir`.

Once the first directory exists, or a failed `mkdir` leaves its outcome ambiguous, any later failure returns `PARTIAL_PUBLICATION` and performs no rollback; created directories and the target file may remain. The result invalidates affected snapshots and unbinds a native-alias live epoch. Inspect and reconcile the tree and target before retrying, then use a fresh delivered `hashline_read` before further alias mutation; old snapshot IDs remain unusable. `move_file` still requires an existing parent and never creates directories.

### 3. Validate and publish

The plugin resolves and authorizes every canonical source and destination path, checks snapshot scope and issued provenance, acquires deterministic path locks, rereads the file, and plans the exact mutation before approval. Text edits stage a same-directory temporary file and attempt one rename. Lifecycle deletion unlinks only after a final direct-entry check; move publishes without overwrite and verifies the exact destination before unlinking the source. No operation is replanned after approval.

<p align="center">
  <img src="docs/assets/protocol.svg" alt="Better Hashline protocol lifecycle" width="100%" />
</p>

## Edit Modes

Omitted `rebase` resolves by operation:

| Batch | Omitted mode |
| --- | --- |
| Only `replace`, `insert`, `copy_range`, and `move_range` | `unique` |
| Sole `replace_file`, `delete_file`, or `move_file` | `none` |

For an incremental batch, omission requests exact, ambiguity-rejecting textual relocation. `rebase: "unique"` selects the same behavior explicitly and retains the same supported-operation constraints. It relocates only when exact non-normalized evidence identifies the selected base occurrence and every successful bounded context agrees. Insertion requires the original adjacent boundary to remain intact; copied BOF/EOF evidence is ambiguous. Transfer sources and destinations relocate independently through one bounded mapper, then must retain their complete original topology.

`rebase: "none"` explicitly requests full-byte freshness for any supported operation. Any byte change since `hashline_read` returns strict `TARGET_CHANGED`. Use it when the caller requires the protocol's exact-byte compare-before-plan behavior; publication still is not a kernel-level conditional CAS.

When exact unique range relocation fails and the selected coordinates still contain the same line texts with changed LF, CRLF, lone-CR, or final-delimiter bytes, the existing `TARGET_CHANGED` error adds a delimiter-specific reread explanation. This is diagnostic only: delimiters are not normalized, the range is not accepted, and no fuzzy fallback is attempted.

Unique rebase proves textual identity and relocation only. It never chooses a nearest match, strips prefixes, repairs indentation, or inserts conflict markers. It does not prove semantic independence or edit-history causality.

A concrete `unique` case is an external writer prepending a line after your read: a still-retained snapshot can relocate its unchanged, uniquely identified target from old line 2 to current line 3. It cannot revive an ID consumed by an earlier Better Hashline edit; that fails as `SNAPSHOT_UNKNOWN` before relocation and requires the readback successor or another read.

### Migration From 0.7.0

Version 0.7.0 resolved every omitted `rebase` to strict `none`. The operation-aware omission above is therefore a semantic breaking change: an omitted incremental batch may now apply after unrelated external changes when its exact textual evidence relocates uniquely. Existing callers that require full-file byte equality must add `"rebase": "none"` explicitly.

On changed bytes, an omitted incremental call can now succeed or return exact-relocation diagnostics such as `TARGET_CHANGED`, `BOUNDARY_CHANGED`, or `AMBIGUOUS_RELOCATION` instead of the strict mode's unconditional full-file `TARGET_CHANGED`. A successful changed-byte unique rebase reports `Exact unique rebase occurred.` whether or not coordinates moved; explicit `none` preserves the strict diagnostic path. Exact `unique` behavior remains textual, does not establish semantic independence or edit-history causality, and never normalizes or fuzzy-matches.

Every current `@hashline` header now requires `coverage=partial|complete`; parsers must accept `partial=true coverage=complete` and must not treat predicted pending output as issued. Sole strict `replace_file` now supports explicitly requested text readback, while only `delete_file` and `move_file` reject readback controls; omission still requests no successor.

The changed provider contract also changes native-alias schema/package identity while retaining the `native-aliases/v2` marker. Restart the plugin or host as applicable after upgrading, then obtain a fresh delivered and attested `hashline_read` before native-alias mutation; 0.7.0 snapshot IDs cannot be reused. See the normative [protocol migration](docs/protocol.md#migration-from-070) for details.

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
| `toolSurface` | `"hashline"` | Tool-ID surface; `"native-aliases"` is an experimental capability-checked preview |
| `maxFileBytes` | 8 MiB | Maximum editable or creatable text file |
| `maxLines` | 100,000 | Maximum logical lines per editable file |
| `maxCacheBytes` | 64 MiB | Approximate retained snapshot memory budget |
| `maxSnapshots` | 64 | Process-wide retained snapshot count |
| `maxSnapshotsPerPath` | 4 | Retained revisions per session and canonical path |
| `maxSnapshotsPerSession` | 32 | Retained snapshots per OpenCode session |
| `snapshotTtlMs` | 30 minutes | Snapshot lifetime |
| `maxOutputBytes` | 40 KiB | Authoritative model-visible read/readback budget; configurable up to 45 KiB |
| `maxContextLines` | 4 | Exact context on each side for `unique` rebase |

Unknown or inconsistent options put the plugin into a diagnostic fail-closed mode: native mutators remain hidden and every Better Hashline tool returns `CONFIG_INVALID`. Fix the configuration and restart OpenCode. `maxCacheBytes` must be at least three times `maxFileBytes`.

Set `enforce: false` only for migration or A/B evaluation. It leaves native mutators enabled and exposes two separate workflows: use `hashline_read` only with `hashline_edit`; for native mutation of an existing file, use native `read` followed by native `edit`, `write`, or `apply_patch`. Native `write` or `apply_patch` may create an absent target without a preceding read. Never pass hashline annotations or snapshot IDs to native mutators.

### Experimental native aliases

`toolSurface: "native-aliases"` keeps the Better Hashline snapshot executor but publishes it as
`edit` on non-GPT routes and `apply_patch` on GPT-5-like patch routes so stock OpenCode can use its
native diff renderers. It requires `enforce: true`, a compatible OpenCode host, a plugin or host restart as applicable after
configuration, schema, host, or surface changes, and a delivered and attested `hashline_read` in the same session:

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
native `write`. Alias mutation is restricted to source and destination paths inside the current worktree; authorized external mutation requires explicitly switching to the unique hashline surface and restarting. Better Hashline aliases require top-level `filePath`, `snapshotId`, and `operations`, accept only the documented optional controls, and reject native `oldString`/`newString` or `patchText` shapes with `INVALID_ARGUMENT`. Transport, schema, or
session incompatibility fails closed without falling back to a builtin or to `hashline_edit`.
The protocol marker name remains `native-aliases/v2`, but package version, canonical schema SHA-256,
and protocol fingerprint are exact identity. A change invalidates the process-local live epoch.
Restart the plugin as required and use a fresh delivered same-session read; earlier snapshot IDs
remain unusable.

Live alias admission never fetches persisted session history. Bounded history validation and transport
retry and size limits remain for offline verifier, model-trace, and evidence paths. Invalid or oversized
history invalidates that evidence, but it neither establishes nor repairs the process-local live epoch.

Native-alias `edit` and `apply_patch` calls are rejected while system guidance reports `native-alias-session=unbound` or `mismatch`. A delivered and attested `hashline_read` establishes or replaces the process-local live epoch for the current session, worktree, and protocol fingerprint. Once guidance reports `bound`, alias calls with disjoint complete source/destination path sets may run concurrently; overlapping path sets serialize, and every call has an independent approval and publication outcome. A partial move or parent publication invalidates affected snapshots and unbinds the epoch. After inspecting and repairing the paths, a fresh delivered `hashline_read` can rebind in the same session; old snapshot IDs remain unusable. The default `hashline` surface does not need native-session attestation.

Reads prepared for the same fingerprint and canonical worktree may reuse the current candidate authority. Preparing a differing identity retires active authority immediately; only the current candidate delivered and attested by `tool.execute.after` can commit. A snapshot's authority token must match the active authority, so stale, reordered, or ABA completions cannot bind or revive old IDs.

No Better Hashline failure or Better Hashline resource limit requires abandoning the OpenCode transcript or task ID. Recover in the same task using the action named by the error: retry only when it is explicitly safe, obtain a fresh delivered `hashline_read`, inspect and reconcile partially published paths before retrying, repair paths or configuration, restart the plugin or host as applicable and reread, or explicitly configure `enforce:true` with `toolSurface: "hashline"` and restart. That switch is explicit, never a silent fallback, and old snapshot IDs are not reused. This invariant is scoped to Better Hashline and does not cover loss of OpenCode's own session database.

Run the credential-free clean-room verifier after installation and after every plugin-order or
configuration change:

```sh
bunx opencode-better-hashline verify --surface all
```

The verifier checks both model routes, schemas, malformed-call confinement, hooks, exact text edits,
strict file deletion and no-overwrite moves, resumed, forked, and imported edits, sanitized export
behavior, stock terminal rendering, pinned GPT-4/GPT-OSS/GPT-5 routing, wildcard/path edit permissions,
protocol fingerprints, and rollback to unique IDs in an isolated configuration. It is a package self-test, not
an audit of your merged
OpenCode configuration. It cannot prove continuous executor ownership: a later plugin or MCP tool can
replace an alias, and a later after-hook can mutate persisted output. Keep Better Hashline last among
plugins that define `edit` or `apply_patch`.

Native-looking IDs persist in session history. Removing the plugin or changing surfaces can leave old
native-looking cards while new calls resolve to OpenCode builtins; verify the active surface and obtain a
fresh delivered `hashline_read` before alias editing. Persisted history never restores the live epoch.
Rejected native-shaped calls may consume an extra model retry. Unsanitized exports and shares contain
paths and diffs. Sanitized exports remove tool paths, diffs, and protocol markers but OpenCode 1.18.3
retains a safe root-relative session locator; review it before disclosure. Removing the marker makes
offline history and evidence validation fail closed; it does not provide or restore live edit authority.
ACP can classify the alias as an edit but cannot reconstruct the native structured diff from Better
Hashline metadata. The unique `hashline` surface remains the production default and recommendation.

The retained [privacy-safe pilot v7 summary](benchmarks/results/2026-07-21-native-alias-pilot-v7.json)
records 48/48 passing Luna/Sol sessions across the unique and native-alias surfaces, complete
accounting, zero retries/failures/timeouts, and USD 0 reported cost. It is technical transport
evidence for the earlier text-operation surface, not lifecycle-operation evidence or a
model-superiority claim. The maintainer approved only an opt-in experimental release; all pilot IDs
through v7 are closed and may not be resumed or retried.

## Why No Per-Line Hash?

A short per-line hash can help a model copy an address, but it cannot safely establish freshness:

- A fixed changed target passes an 8-bit check with probability `1/256` and a 16-bit check with probability `1/65,536`.
- Among 1,000 identities, the probability of at least one 16-bit collision is about `99.95%`.
- Endpoint-only checks do not detect changes inside a multiline range.
- Wider hashes add prompt bytes without solving permission, overlap, race, or publication problems.

Better Hashline therefore separates model-facing addressing from server-side authority. The public format stays compact; freshness uses exact retained bytes and full SHA-256 internally. Per-line hashes remain a benchmark arm, not a production dependency.

## Evidence

The current deterministic runner uses schema v10. Its write-once retained result is
[the schema-v10 coverage/readback UX record](benchmarks/results/2026-07-24-coverage-readback-ux-windows-x64.json). Schema v10 keeps the unchanged 29-case corpus and operation-aware omitted/default adapter, then adds wire evidence for cumulative header coverage and explicit `replace_file` readback. Strict-only defaults remain covered by runtime tests rather than this corpus.
The immutable schema-v9 operation-aware record, schema-v5 through schema-v8 records, and pilot-v7
evidence retain their original scope and bytes. Comparison arms are deliberately small protocol
simulations, not complete implementations of third-party tools. The unchanged corpus classifications are:

| Adapter | Unsafe accepts | False rejects |
| --- | ---: | ---: |
| Better Hashline, explicit `none` | 0 | 5 |
| Better Hashline, explicit `unique` | 0 | 0 |
| Better Hashline, omitted/default | 0 | 0 |
| Target-only exact search/replace | 5 | 1 |
| Line numbers only | 21 | 0 |
| 8-bit endpoint hashes | 6 | 4 |
| 16-bit endpoint hashes | 5 | 4 |

The full four-outcome counts are strict `6/18/5/0`, explicit unique `11/18/0/0`, omitted/default `11/18/0/0`, exact search `10/13/1/5`, line numbers `7/1/0/21`, 8-bit endpoints `7/12/4/6`, and 16-bit endpoints `7/13/4/5` (`exact_apply/safe_reject/false_reject/unsafe_accept`). This corpus tests in-memory textual protocol mechanics only; it does not exercise semantic intent, OpenCode hooks, permissions, or filesystem publication. The target-only exact search arm's single false reject is the duplicate-target case that equivalent exact context can resolve; its unsafe accepts are stale selected-target and boundary cases that a stronger revision/context protocol could reject. The table does not establish an addressing-format advantage. It is intentionally not evidence that one format makes a language model better at software engineering. The opt-in paired model harness defaults to a dry run and requires explicit cost acknowledgement; schema-v10 deterministic output is not a paid/model-quality claim. The full chart is kept with the [benchmark methodology](docs/benchmarks.md), not as a headline product claim.

```sh
bun run bench
bun run bench:model
```

See [benchmark methodology and raw results](docs/benchmarks.md), [prior-art audit](docs/research.md), and the [reproducibility guide](benchmarks/README.md).

## Compatibility

| Component | Status |
| --- | --- |
| OpenCode `>=1.18.3 <2` stable V1 plugin API | Supported; verifier pinned to 1.18.4 |
| Experimental native aliases | Capability-checked at startup; explicit opt-in |
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
- Create-only `hashline_write` requires same-directory hard-link support for no-replace publication. Automatically created directories or even the final file may remain after `PARTIAL_PUBLICATION`; no rollback is attempted. A detected race after the file link can leave the new file committed, but returns failure and never deletes a possibly newer writer's path.
- Executable mode and ownership are preserved where supported; all metadata preservation is not promised.
- `enforce` blocks OpenCode's native mutator tool IDs, but it does not sandbox shell commands or other plugins.
- Native aliases cannot attest final registry ownership or prevent later hooks from mutating renderer metadata.
- Snapshot caches are in memory and disappear on restart, expiry, or eviction. An approved publication invalidates every affected path when it reaches the consume boundary, including partial outcomes; invalidation is not limited to successful publication.

Full boundaries and trust assumptions are in [docs/threat-model.md](docs/threat-model.md).

## Project Docs

- [Protocol specification](docs/protocol.md)
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Research and prior art](docs/research.md)
- [Benchmarks](docs/benchmarks.md)
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
