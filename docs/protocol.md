# Protocol Specification

Status: experimental `0.x` protocol. Breaking changes may occur before `1.0.0` and are recorded in [CHANGELOG.md](../CHANGELOG.md).

## Goals

Better Hashline provides compact model-facing line addressing while keeping edit authority on exact server-side state. The protocol is designed to:

- reject stale, ambiguous, malformed, overlapping, or unauthorized edits;
- preserve supported UTF-8 byte structure, BOM state, and existing line delimiters;
- keep read, planning, permission, and publication as distinct phases;
- report stable machine-readable error prefixes;
- avoid fuzzy matching, nearest-match selection, source repair, and conflict markers.

It does not attempt semantic merge, multi-file transactions, hostile-writer CAS, or general filesystem sandboxing.

## Tool Surfaces

`toolSurface: "hashline"` is the default and exposes `hashline_read`, `hashline_edit`, and
create-only `hashline_write`. With enforcement enabled, native `edit`, `write`, and `apply_patch`
are hidden and tripwired.

The experimental `toolSurface: "native-aliases"` requires `enforce: true` and a compatible OpenCode
host. It exposes `hashline_read`, create-only `hashline_write`, and
both Better Hashline edit definitions under `edit` and `apply_patch`; OpenCode's model-family filter
retains exactly one alias. It does not register `hashline_edit` and never aliases native `write`.
Host versions are recorded in protocol identity rather than allowlisted. Missing or incompatible
transport, health, schema, or session-history capabilities remain diagnostic and fail closed without
changing surfaces.

All three edit IDs use the same strict schema and snapshot-bound executor. Alias executors parse a
second time, so native `oldString`/`newString` and `patchText` shapes reject with `INVALID_ARGUMENT`
before history, permission, or filesystem work.

## Snapshot Scope

`hashline_read` produces a snapshot with:

| Field | Meaning |
| --- | --- |
| Snapshot ID | Random 128-bit value encoded as `s_` plus 22 Base64url characters |
| Session | Exact OpenCode `sessionID` |
| Worktree | Exact OpenCode `worktree` |
| Path | Canonical resolved file target |
| Content | Exact original bytes and decoded text document |
| Digest | Full SHA-256 of exact bytes |
| Line table | Text, delimiter, and UTF-16 offsets for every logical line |
| Provenance | Ranges and BOF/EOF boundaries successfully issued to the model |
| Lifetime | Creation/access time, TTL, pin state, and cache accounting |

Snapshots cannot cross sessions, worktrees, or canonical paths. An ID is not accepted merely because its digest or visible text matches.

The header exposes only a 12-hex SHA-256 preview for diagnostics. Freshness never depends on that preview.

## Text Model

Files must decode as complete, fatal UTF-8. One leading UTF-8 BOM is recognized and preserved. NUL, control-heavy binary content, malformed UTF-8, lone surrogate payloads, and unsupported file types are rejected.

Every logical line stores its exact delimiter: LF, CRLF, lone CR, or empty at EOF. There is no phantom line after a final newline. New replacement payloads are arrays of logical lines:

| Payload | Meaning |
| --- | --- |
| `[]` on `replace` | Delete the selected range |
| `[""]` | One empty logical-line value; the resulting byte layout depends on the selected EOL slot |
| `["a", "b"]` | Two logical lines using the local selected delimiter |

Payload strings cannot contain CR, LF, NUL, or invalid Unicode scalar sequences.

## Read

Tool: `hashline_read`

```json
{
  "filePath": "src/example.ts",
  "offset": 1,
  "limit": 1000
}
```

`filePath` resolves from `ToolContext.directory`, never process `cwd`. Existing symlinks resolve to their canonical target. External targets require OpenCode's `external_directory` permission, followed by standard `read` permission.

Output grammar:

```text
@hashline snapshot=s_<22-base64url> sha256=<12-hex> lines=<count>[ partial=true]
<line>|<exact text>
<line>!|<preview>... [preview only; line not issued]
@more offset=<next one-based line>
@eof
```

`lines` is the file's total logical-line count, not the number rendered in this result. The optional `partial=true` token means this rendered page does not itself cover complete editable BOF-to-EOF evidence; pagination, preview-only lines, and bounded edit readback can all produce it. A header without the token means this one page covers the complete file. Multiple attested partial pages for the same unchanged snapshot may cumulatively issue complete coverage.

`N|` lines become editable only after `tool.execute.after` confirms that OpenCode did not generically truncate the custom-tool result. A line is rendered as preview-only `N!|` only when its complete annotated form cannot fit in one configured output page; preview-only lines never become issued. Marker loss, host truncation, or output mutation issues no new refs; previously issued refs on a reused snapshot remain valid. Cache eviction and publication still invalidate affected snapshots rather than guessing what the model received.

## Edit

Tool: `hashline_edit`, or `edit`/`apply_patch` on the explicit native-alias surface

```json
{
  "filePath": "src/example.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "rebase": "none",
  "readback": true,
  "readbackOffset": 4,
  "readbackLimit": 100,
  "operations": [
    { "op": "replace", "startLine": 4, "endLine": 6, "lines": ["replacement"] },
    { "op": "insert", "afterLine": 9, "lines": ["inserted"] }
  ]
}
```

The provider schema stays flat for broad provider compatibility, so operation-specific fields other
than `op` are optional at the JSON Schema level. Optional does not mean valid for every operation:
runtime validation accepts only these exact combinations and rejects every unlisted field:

| `op` | Required fields | Optional fields | Forbidden fields |
| --- | --- | --- | --- |
| `replace` | `startLine`, `endLine`, `lines` | none | `afterLine`, `finalNewline`, `destinationPath` |
| `insert` | `afterLine`, `lines` (non-empty) | none | `startLine`, `endLine`, `finalNewline`, `destinationPath` |
| `replace_file` | `lines` | `finalNewline` | `startLine`, `endLine`, `afterLine`, `destinationPath` |
| `copy_range` | `startLine`, `endLine`, `afterLine` | none | `lines`, `finalNewline`, `destinationPath` |
| `move_range` | `startLine`, `endLine`, `afterLine` | none | `lines`, `finalNewline`, `destinationPath` |
| `delete_file` | none | none | `startLine`, `endLine`, `afterLine`, `lines`, `finalNewline`, `destinationPath` |
| `move_file` | `destinationPath` | none | `startLine`, `endLine`, `afterLine`, `lines`, `finalNewline` |

`replace_file`, `delete_file`, and `move_file` must each be the sole operation and use
`rebase: "none"`. Unknown operation fields are rejected rather than ignored.

At the top level, the source remains `filePath` plus `snapshotId`; `destinationPath` belongs only to
the sole `move_file` operation. `rebase` is optional and defaults to `"none"`.
`readbackOffset` is an optional one-based post-edit text line and `readbackLimit` is an optional
integer from 1 through 1,000. Both require `readback:true`; neither is valid for a lifecycle
operation. The offset defaults to the first new-file hunk line and the limit defaults to 1,000.
`allowHashlinePrefixes` is optional and defaults to `false`. Before any path lookup or permission,
the executor rejects literal `replace`, `insert`, and `replace_file` lines beginning in column zero
with a positive non-zero decimal annotation (`17|` or `17!|`) or the exact markers `@hashline`,
`@hashline-edit`, `@more`, `@eof`, and `@note`. Zero, zero-padded numbers, leading whitespace, and
names such as `@hashline-style` are not renderer annotations. Set the top-level flag in the initial
call only when the matched prefix is intentional file content; it applies to the whole batch and
never strips or rewrites bytes.

A rejection identifies the exact `operations[i].lines[j]` coordinate and a bounded prefix kind. On
the default surface, no snapshot is consumed and the call throws normally. Native aliases instead
return a completed non-mutating terminal result so supported OpenCode hosts persist its exact
protocol/package/schema/host/worktree/surface/input marker. The same process can continue from its
binding; after restart, continuation requires that exact unsanitized result. Text matching alone
never makes a rejected native-looking call compatible.

`readback` is optional and defaults to `false` for text edits. Use it for structural verification or
a dependent follow-up edit. It renders exactly one contiguous successor page using the explicit
offset/limit or the first-hunk/1,000-line defaults. File lifecycle operations reject
`readback:true`, `readbackOffset`, and `readbackLimit`, and never attach a successor. A
successful text edit begins with `Applied N operations.`; lifecycle success begins with `Deleted
<source>.` or `Moved <source> to <destination>.`. Every successful mutation then includes one
snapshot lifecycle receipt:

```text
@hashline-edit previous=consumed successor=none next=hashline_read
@hashline-edit previous=consumed successor=attached
@hashline-edit previous=consumed successor=unavailable next=hashline_read
```

`none` means no successor was requested or the operation does not support one. `attached` is
immediately followed by the one bounded page from a new snapshot. The old snapshot remains invalid,
and only refs in that delivered page become editable after the same output-digest, marker, and
truncation checks used by `hashline_read`. The protocol never returns a successor snapshot ID
without its page. If delivery checks fail, the write remains successful but the after-hook replaces
the result with `unavailable`; the pending successor issues nothing and is not exposed by ID.

A bounded readback that starts after line 1, stops before EOF, or contains a preview-only line is
explicitly marked `partial=true` in its header. Its displayed `N|` refs remain usable. Whole-file
replacement still requires cumulative issued coverage of all lines plus BOF and EOF; read missing
pages for the same unchanged snapshot or perform a fresh complete read.
For `replace_file`, `delete_file`, or `move_file`, incomplete coverage reports concise recovery:
`Read the file from offset=1 through @eof with the same snapshotId, then retry.`

### Replace

`startLine` and `endLine` are one-based and inclusive. Every line in the range must have been issued from the same snapshot. Range endpoints alone are never sufficient.

### Insert

`afterLine` identifies a boundary. Zero means before the first line. The file line count means after the last line. Both neighboring lines must have been issued; BOF and EOF require their respective provenance. Two insertions at the same boundary return `INSERTION_BOUNDARY_CONFLICT`.

### Copy Range

```json
{
  "op": "copy_range",
  "startLine": 4,
  "endLine": 8,
  "afterLine": 20
}
```

`startLine..endLine` is an inclusive source range and `afterLine` is a destination boundary. All coordinates refer to the supplied immutable snapshot. Copy inserts the retained pre-edit logical source texts using the same destination-local EOL rule as `insert`; it does not promise to retain the source delimiters or final-newline state. The entire source and the destination boundary must have been issued. A destination inside the copy's own source is valid. A replacement or move may also write across the copy source; the copied payload still comes from the immutable pre-batch document.

### Move Range

```json
{
  "op": "move_range",
  "startLine": 4,
  "endLine": 8,
  "afterLine": 20
}
```

Move reorders retained logical texts over the existing positional EOL slots in the inclusive corridor between the source and destination. It preserves the file BOM, exact EOL-slot sequence, final-newline state, logical-line count, and byte count. The complete corridor and destination boundary must have been issued. A destination strictly inside the source is `INVALID_ARGUMENT`. The immediately-before and immediately-after identity destinations return `NO_CHANGE` for the entire batch.

One batch may compose exactly one `move_range` with one or more pairwise-disjoint `replace`
operations when every replacement lies wholly in the intervening part of that move corridor and
outside the move source. Every payload is read and applied against immutable pre-batch corridor
content before the move permutation. The whole corridor still requires issued provenance and exact
freshness, and the output must preserve its positional EOL-slot sequence. Under `rebase:"unique"`,
each replacement must remain wholly inside the relocated intervening corridor. A second move, a
replacement touching the source or outside that intervening span, overlapping replacements, or any
other destructive composition rejects conservatively.

The logical-line parser treats adjacent CR and LF bytes as one CRLF delimiter and does not create a phantom line after a terminal delimiter. Some moves involving empty logical texts therefore have no byte serialization that preserves the promised text/EOL-slot sequence. Such a move is rejected with `INVALID_ARGUMENT` against an unchanged target, or `AMBIGUOUS_RELOCATION` when the incompatibility appears in an exact-unique relocated layout. The planner never normalizes delimiters or silently weakens the move invariants.

Transfer operations never accept `lines` or `finalNewline`; their source is exact retained snapshot content. They are same-file operations and do not create, delete, rename, or copy filesystem paths.

### Replace File

```json
{
  "op": "replace_file",
  "lines": ["complete", "content"],
  "finalNewline": true
}
```

`replace_file` must be the sole operation, requires `rebase: "none"`, exact current bytes, and a completely issued snapshot including BOF and EOF. `finalNewline` is optional only for `replace_file`; omitting it preserves the snapshot's final-newline state. To write an empty file regardless of that state, pass `lines: []` and `finalNewline: false`. An empty array with inherited or explicit `true` is invalid; use `lines: [""]` to represent a file containing one newline.

### Delete File

```json
{
  "filePath": "src/obsolete.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "rebase": "none",
  "operations": [{ "op": "delete_file" }]
}
```

`delete_file` is the sole operation. It accepts no line coordinates, `lines`, `finalNewline`, or
`destinationPath`; it requires strict mode, complete issued BOF-to-EOF coverage, and no readback.
The source named by top-level `filePath` must be a direct terminal directory entry, not a terminal
symlink, and must still identify the exact regular, single-link UTF-8 file retained by the snapshot.
After approval, the executor revalidates the source parent and direct terminal binding, invalidates
the source snapshots at publication, unlinks that exact entry, and verifies that the name is absent.

### Move File

```json
{
  "filePath": "src/old-name.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "rebase": "none",
  "operations": [{ "op": "move_file", "destinationPath": "src/new-name.ts" }]
}
```

`move_file` has the same strict source and issued-coverage requirements as `delete_file`. Its sole
operation requires only `destinationPath`; line coordinates, `lines`, and `finalNewline` are
forbidden, and `readback: true` rejects. Relative destinations resolve from
`ToolContext.directory`; absolute destinations require external-directory authorization. The destination
must differ from the source and must be absent even when the terminal entry is a symlink. Its
existing parent must remain the same directory; the tool neither overwrites nor creates parents.
Source and destination must be on one filesystem, and external-directory plus edit authorization
covers both canonical paths.
Lifecycle source and destination renderer paths containing CR or LF are rejected before
authorization or publication so unified-diff history remains unambiguous.

Publication creates an exclusive no-clobber hard link at the destination, verifies exact inode,
bytes, and a link count of two, then unlinks the source and verifies the destination with a link
count of one. This is intentionally nontransactional. Once the destination link exists, any source
unlink or final-verification failure returns `PARTIAL_PUBLICATION`; both exact names may remain.
The plugin invalidates source and destination snapshots, does not attempt an unsafe rollback, and
poisons the bound native-alias session. Inspect both paths and begin a new session before any retry.
After a successful move, read the destination to obtain a snapshot for that path.

## Rebase Modes

### None

Default. The current bytes must equal the snapshot bytes. Any byte change returns `TARGET_CHANGED`.

### Unique

Explicit recovery for cooperative edits. A replacement range relocates only when:

- the exact target line tokens, including delimiters, remain unchanged;
- the exact target alone is decisive only when it occurs once at the selected base range and once in the current file;
- every successful bounded exact left/right signature selects the same candidate in the current file;
- contradictory unique signatures reject as `AMBIGUOUS_RELOCATION`, regardless of search order or context size;
- all relocated operations preserve their original order;
- relocated operations do not overlap, except for the exact move/replacement composition described
  above.

An insertion relocates only when both original neighboring line tokens remain adjacent at the selected base boundary and all successful bounded signatures agree on one boundary. BOF/EOF require a bounded prefix/suffix that occurs only at the corresponding current edge; copied edge evidence is ambiguous. A concurrent insertion at the same boundary invalidates the boundary.

In a transfer-containing batch, every source range, destination boundary, move corridor, replacement range, and insertion boundary is mapped canonically through one cumulative work budget. Copy source and destination anchors relocate independently. Move source, corridor, and destination anchors also relocate independently, then must retain their exact geometric relationship. Pairwise range and boundary relations must remain equal to the base snapshot. Only qualifying pairwise-disjoint replacements inside one move's intervening corridor are incorporated into that move. Every other destructive intersection, and every insertion destination strictly inside a destructive span, rejects; a read-only copy source may intersect it.

This global topology and canonical anchor ordering applies only to batches containing `copy_range` or `move_range`. Transfer-free batches retain the pre-transfer mapper order, work consumption, and output bytes for batches that remain valid. Consequently, adding a transfer to an otherwise unchanged legacy batch can expose a global topology ambiguity and return `AMBIGUOUS_RELOCATION`.

There is no fuzzy normalization, whitespace tolerance, nearest candidate, conflict marker, or fallback from strict to unique. If an exact range has no relocation candidate but its original selected coordinates retain identical line texts with changed delimiters, `TARGET_CHANGED` adds `Exact line delimiters changed; reread the file before retrying.` This diagnostic does not make the target eligible, normalize EOLs, or invoke a fallback. Content changes, shifted/missing ranges, and boundary failures keep their existing generic diagnostics.

For example, suppose a retained snapshot contains `alpha`, `target`, `omega`, and another process inserts `prefix` at BOF. Strict mode returns `TARGET_CHANGED`; `rebase: "unique"` can use that same retained ID to relocate base line 2 to current line 3 when the exact evidence is unique. If a successful Better Hashline edit already consumed the ID, a later call returns `SNAPSHOT_UNKNOWN` before relocation; use its readback successor or read again.

## Native-Alias Session and Metadata Contract

Native aliases use protocol marker `native-aliases/v2`. The marker records `operation` as `update`,
`delete_file`, or `move_file`; a move also records the destination canonical-path SHA-256. Exact
persisted `native-aliases/v1` history is deliberately incompatible and fails closed with
`SESSION_PROTOCOL_MISMATCH` rather than being interpreted under v2.
The marker string does not imply schema compatibility. Every canonical schema SHA-256 and protocol
fingerprint is exact identity; the current expanded contracts change both while retaining the v2
marker name. A session carrying an older v2 identity therefore fails closed and requires a plugin
restart plus a new session.

Completed `edit` metadata contains the exact unified diff in both `diff` and `filediff.patch`.
Completed `apply_patch` metadata contains exactly one source-correlated entry whose type is
`update`, `delete`, or `move`; move metadata also carries the exact destination and destination
relative path. Both forms include additions/deletions, empty `diagnostics`, and `betterHashline`
fields for the protocol, package version, canonical schema SHA-256, exact host version, active
alias, operation, source canonical-path SHA-256, and, for moves, destination canonical-path SHA-256.
The patch validator accepts the exact zero-hunk lifecycle forms needed for an empty-file delete or a
path-only move while still correlating source and destination headers. Serialized metadata is
measured before permission and publication and may not exceed 1 MiB.

On native aliases, `DISPLAY_PREFIX_REJECTED` is a completed non-mutating terminal result because
supported OpenCode hosts persist returned result metadata, but do not persist a lazy metadata update
discarded before a throw. Its separate `betterHashlineRejection` marker contains exact
protocol/package/schema/host/worktree/surface identity, canonical input SHA-256, payload coordinate,
and bounded prefix kind. It attests only that this exact input stopped before path access,
permission, and mutation; it is never successful provenance.

Each plugin instance binds a session to one v2 protocol fingerprint. Before the first edit it reads
a bounded history of at most 200 messages, 2,000 parts, and 1 MiB, then validates every historical
mutator. Message, part, call, session, input path, lifecycle operation, move destination, metadata
keys, unified-diff path headers and hunks, counts, renderer path, and source/destination digests must
agree exactly. Every ordinary call identity is unique. OpenCode 1.18.4 can persist one cleanup
shadow beside a settled tool part with the same message and call IDs; only an exact second part with
`tool: "unknown"`, empty input, no part metadata, error `Tool execution aborted`, and exact
`interrupted: true` metadata is accepted as that host artifact. A second ordinary part, a second
shadow, an altered shadow field, or a shadow beside a pending/running call remains incompatible.

Native `write`, `hashline_edit`, unknown fields, malformed or v1 markers, and unproven completed
results remain incompatible. Exact completed `DISPLAY_PREFIX_REJECTED` results are known
non-mutating terminals. Historical `edit` and `apply_patch` error states issue no provenance and do
not poison the session, even when their input is incomplete or their structurally valid metadata
records uncertainty. Every later mutation still requires exact snapshot evidence. Bytes changed by
an uncertain call therefore produce `TARGET_CHANGED` and require a fresh `hashline_read` of that path
rather than a new session. Structurally malformed error states, unmarked completions, conflicting or
unreadable history, cross-worktree history, and cross-surface history return
`SESSION_PROTOCOL_MISMATCH`.

The history transport admits at most 1,114,112 response bytes so the protocol validator can enforce
the stricter 1 MiB persisted-history limit without accepting an unbounded envelope. The initial
history read has one 2,000 ms total deadline, at most four attempts, a 500 ms per-attempt cap, and
10/25/50 ms backoff. Only timeout/network failures and HTTP 408, 425, 429, 500, 502, 503, or 504 are
retried. Unavailable or unexpected transport, other HTTP statuses, an oversized response, invalid
JSON, and an invalid top-level shape fail immediately. Diagnostics retain only that safe category,
HTTP status/class, and bounded attempt/deadline facts; they never include the request URL, headers,
response body, credentials, private paths, or raw transport error text. Exhausted transient failures
can be retried in the same session after restoring the host. History beyond either bounded inspection
window requires a genuinely new session; resuming the same task ID cannot reduce persisted history.

Only the exact current running call is excluded. OpenCode can expose that call before its persisted
input has caught up with parsed before-hook arguments. For the same exact call ID and tool, the
plugin may reread bounded local history five times under one 160 ms stabilization deadline after
the initial bounded read. Each reread gives transport retries only the time remaining on that same
160 ms deadline; it does not receive another 2 seconds. Exclusion still requires exact input
equality. A different call ID, tool, path, snapshot, operation, destination, permanently different
input, or more than one active alias remains incompatible before binding.

System guidance reports the process-local state as `native-alias-session=unbound`, `bound`, or
`mismatch`. Unbound sessions must serialize calls until one exact before-hook attestation binds the
session. Once bound to the current package/schema/host/worktree fingerprint, calls may overlap only
when their complete canonical source/destination path sets are disjoint. Any shared source or
destination path serializes through deterministic path locks; each call still has an independent
approval/publication outcome. This is not a multi-file transaction. A `PARTIAL_PUBLICATION` move
poisons that binding and reports `mismatch` for the rest of the session.

A restart clears snapshots and process bindings. Resume requires compatible unsanitized v2 history
plus a fresh `hashline_read`, and calls remain serialized until the new process binds. Binding
eviction has the same effect. A mismatched or poisoned binding fails closed and requires a new
session. Changing surfaces or configuration requires a restart and a new session.

## Permission and Publication Order

Text edits and file lifecycle operations share strict snapshot authority but use separate planners.
`planEdits` remains the pure text planner; it does not plan deletion or movement of filesystem
entries.

For a text edit:

1. Resolve the lexical path and canonical target.
2. Pin and validate snapshot scope, path, and operation-specific issued provenance.
3. Request `external_directory` when the canonical target is outside the allowed roots. On POSIX, parents containing literal `*` or `?` can be approved once but are not persisted as wildcard rules; Windows rejects those invalid filename characters before permission.
4. Acquire the process-global canonical-path lock.
5. Reread bytes and file identity; revalidate symlink target and supported metadata.
6. Plan every text operation against one immutable current document.
7. Build the exact unified diff and native-alias metadata, if applicable.
8. Request standard `edit` permission with that exact approved patch.
9. Create an exclusive same-directory temporary file, write, flush, and preserve supported metadata.
10. Reread the destination and recheck exact bytes, identity, and alias target after the permission wait.
11. Invalidate all snapshots for this session/path immediately before publication.
12. Attempt one rename over the canonical target.
13. Reread and verify the resulting bytes.
14. When `readback: true`, retain those verified bytes as a pending snapshot and render the one
    requested/default contiguous page.
15. Issue only that page's refs after `tool.execute.after` attests the delivered output; otherwise
    expose no successor ID and report `successor=unavailable`.

For a file lifecycle operation:

1. Validate the sole operation, strict rebase, no-readback shape, snapshot scope, canonical source path, and complete issued BOF-to-EOF provenance.
2. Resolve a direct mutable source and, for move, an absent destination under an existing canonical parent; authorize every external source or destination path.
3. Acquire deterministic process-global locks sequentially for the sorted canonical source/destination path set; cancellation while queued releases acquired locks before later paths are reserved.
4. Reread the source as the exact regular, single-link UTF-8 snapshot file; revalidate direct terminal and parent identity, and for move verify destination absence and same-filesystem identity.
5. Freeze one immutable lifecycle plan containing the operation, canonical paths, stable source and parent identities, and exact delete/move patch and metadata.
6. Request standard `edit` permission for the complete source/destination path set and that exact patch.
7. Reread and revalidate the approved source, terminal binding, parent identities, destination absence, and same-filesystem constraint without replanning or changing metadata.
8. Invalidate relevant snapshots immediately before publication.
9. Delete revalidates the direct terminal binding, unlinks the exact source, and verifies absence.
10. Move publishes a no-clobber destination hard link, verifies exact inode/bytes/link count, unlinks the source, and verifies the final destination.

No rebase, destination substitution, patch change, metadata change, or lifecycle replan occurs after
permission approval. If approved state changed while permission was pending, publication rejects.
Lifecycle operations never create a readback successor.

For a new file, `hashline_write` is create-only and accepts optional `createParents`, defaulting to
`false`. With omission or `false`, the parent must already exist and the strict behavior is
unchanged. The tool requests the same path permissions, writes and flushes an exclusive
same-directory temporary file, then publishes it with a no-replace hard link. It verifies staged
and published identity, link count, exact bytes, and parent identity before returning success. It
never overwrites a file, directory, or symlink. Filesystems that cannot provide these local
hard-link semantics reject the operation. A failure after the hard link succeeds can leave the new
file committed; the plugin reports `RACE_AFTER_WRITE` and does not risk deleting a newer writer's
file.

With explicit `createParents:true`, the plugin locates and pins the deepest existing requested and
canonical directory ancestor, rejects more than 64 missing directories, and freezes one root-to-leaf
directory chain plus the target. It authorizes every planned directory and target, acquires
deterministic locks for all of them, revalidates the exact absence/identity plan without replanning,
and requests one edit permission for the complete diff and directory list. Publication creates each
directory with exclusive non-recursive `mkdir`, verifies each directory and immediate parent, then
delegates file creation to the same staged no-clobber path above. Failures before the first `mkdir`
attempt retain their ordinary prepublication code and leave no created state. If an attempted
`mkdir` reports failure but either planned name appeared, publication is conservatively ambiguous.
From that point, every cancellation, race, staging, linking, readback, or final verification failure
returns `PARTIAL_PUBLICATION`; created directories and any committed file are intentionally retained
and never rolled back. Partial errors omit canonical host paths, and native-alias sessions are
poisoned. `move_file` does not use this path and never creates parents.

## Batch Semantics

A text operation array is validation-atomic: all operations are parsed, issued-provenance checked,
mapped against one immutable current document, and overlap/order checked before mutation.
Operations are composed in memory and at most one destination replacement is attempted. In a
transfer-containing batch, required ranges are deduplicated and checked in coordinate order before
deduplicated destination boundaries are checked in coordinate order, so request-array order cannot
change the provenance error class. Transfer-free batches retain their existing request-order
provenance behavior.

The text array is declarative, not a sequential program, and array order cannot resolve conflicts.
Every source is read from the immutable pre-batch document. Except for the one qualified
move/replacement composition, the batch rejects:

- overlapping destructive spans;
- insertions or copy destinations sharing a boundary;
- any insertion or copy destination strictly inside a destructive span.

Immediately adjacent, non-intersecting destructive spans are valid. An insertion-like destination
may touch either destructive endpoint. Copy sources may overlap other reads or writes because they
always read the immutable pre-batch document. Conflict rules are checked both before and after
unique relocation.

If a batch has several conflict classes, diagnostics use one global precedence: destructive
intersection, insertion strictly inside a destructive span, then duplicate insertion boundary.
Within the selected class, the lexicographically smallest pair of zero-based original operation
indexes is reported, independent of traversal order. Existing `OPERATIONS_OVERLAP` and
`INSERTION_BOUNDARY_CONFLICT` codes remain stable. Their message appends the deterministic suffix
`Conflict: operations[i] (kind) and operations[j] (kind).` Diagnostics also retain the repair hint
to merge overlapping destructive payloads, fold an internal insertion into its replacement, or
combine same-boundary insertions in the intended order.

An individually byte-identical `move_range` rejects the entire batch with `NO_CHANGE`, including
when another member would change the file. This intentionally treats an identity move as a
model-addressing error. Legacy no-op `replace` or `insert` members retain aggregate behavior: they
are accepted when the final batch changes bytes.

The provider accepts 1 to 100 operations, but `replace_file`, `delete_file`, and `move_file` require
an array of exactly one. Each `replace` accepts 0 to 20,000 payload lines; `insert` accepts 1 to
20,000. Each payload item is one logical line and must not contain CR, LF, NUL, or invalid Unicode.
Aggregate payload and projected final output must remain within configured byte and logical-line
limits. Transfer projection is bounded before final materialization, including copy amplification.

A lifecycle operation bypasses text batch composition and `planEdits`; its immutable filesystem plan
is approved and published separately. This is not a filesystem transaction. Post-rename text
verification can detect an immediate overwrite but cannot safely roll it back over a newer writer.
A move can leave both exact names after destination-link publication, as reported by
`PARTIAL_PUBLICATION`. Independent tool calls can leave an earlier mutation committed if a later
call fails.

## Stable Errors

Errors are rendered as `CODE: message`. Current codes include:

| Code | Meaning |
| --- | --- |
| `CONFIG_INVALID` | Plugin configuration is invalid; tools remain fail-closed |
| `INVALID_ARGUMENT` | Tool shape, fields, coordinates, intrinsic geometry, or the snapshot's move EOL layout is invalid |
| `NO_CHANGE` | The final result, or an individually invalid identity move, changes no bytes |
| `NATIVE_TOOL_DISABLED` | Enforcement rejected a hidden native mutator |
| `TOOL_SURFACE_UNAVAILABLE` | The requested alias surface cannot be safely activated on this host |
| `SESSION_PROTOCOL_MISMATCH` | Session history or its bound protocol is missing, unreadable, or incompatible |
| `PATH_NOT_FOUND` | Requested source path or a parent required under strict creation/move behavior does not exist |
| `TARGET_EXISTS` | Create-only or move publication found an existing destination, including a symlink |
| `SNAPSHOT_REQUIRED` | No valid issued snapshot is available |
| `SNAPSHOT_UNKNOWN` | ID was not retained for this scope |
| `SNAPSHOT_EXPIRED` | Snapshot exceeded its configured TTL |
| `PATH_MISMATCH` | Snapshot/request paths differ, or a direct terminal/parent binding changed |
| `REF_NOT_ISSUED` | Required BOF or EOF boundary was not issued |
| `RANGE_NOT_FULLY_ISSUED` | A required range, internal boundary neighbor, or complete lifecycle source was not issued |
| `TARGET_CHANGED` | Strict bytes or exact relocation target changed |
| `BOUNDARY_CHANGED` | Required insertion neighbors no longer match |
| `AMBIGUOUS_RELOCATION` | Exact target/context is ambiguous or reordered, or relocation makes a move EOL layout unrepresentable |
| `OPERATIONS_OVERLAP` | Destructive effects intersect, or an insertion-like destination lies strictly inside a destructive span |
| `INSERTION_BOUNDARY_CONFLICT` | Multiple insertion-like effects share one destination boundary |
| `DISPLAY_PREFIX_REJECTED` | A payload begins with a model-facing annotation; native aliases persist this failure as a completed non-mutating terminal result |
| `PERMISSION_DENIED` | OpenCode rejected a required permission |
| `RACE_BEFORE_WRITE` | Approved identity, bytes, direct binding, parent, or destination state changed before publication |
| `RACE_AFTER_WRITE` | Published bytes, identity, link count, parent, or final path state did not remain equal to the plan |
| `PARTIAL_PUBLICATION` | A move published its destination link, or parent creation created or may have created a directory, but publication could not safely complete or verify |
| `UNSUPPORTED_FILE` | File type, metadata, encoding, size, filesystem relation, or policy is unsupported |

Consumers must treat every `CODE: message` as failure. The native-alias `DISPLAY_PREFIX_REJECTED` result is completed only at the host transport layer so its attestation persists; it never reports `Applied`, requests permission, or changes a file.

## Migration From 0.5.0

The flat operation enum adds `delete_file` and `move_file`, and the shared operation object adds the
schema-optional `destinationPath` field. Runtime validation still requires the exact sole shapes
documented above; generated clients must not populate line fields for lifecycle operations. Older
plugin versions reject the new enum values and must not receive these calls.

Native-alias protocol identity changes from `native-aliases/v1` to `native-aliases/v2`. The v2
marker adds operation identity and, for moves, a destination-path digest; renderer metadata also
adds exact delete/move source and destination correlation. Existing v1 history is not migrated or
silently accepted. Restart the plugin and begin a new session with a fresh `hashline_read` after
upgrading.

The text-edit top level adds `readbackOffset` and `readbackLimit`, both conditional on
`readback:true`; generated clients must not send them to lifecycle operations. `hashline_write` adds
optional `createParents`, whose omitted/false behavior remains strict. A successful readback has one
delivered page rather than an ID-only continuation, and complete-snapshot failures now give the
short full-reread instruction documented above.

One move may now compose with qualifying intervening-corridor replacements. Other overlap and
boundary classifications keep their codes, but their human-readable diagnostics now end in the
deterministic zero-based operation-pair suffix. Exact EOL-only unique-relocation failures retain
`TARGET_CHANGED` and only add diagnostic guidance.

The v2 marker name remains unchanged across these schema additions, but the canonical schema SHA and
protocol fingerprint do not. Sessions created by an earlier v2 development build are incompatible,
fail closed, and require a restart plus a new session. The retained deterministic
[schema-v7 result](../benchmarks/results/2026-07-22-edit-protocol-ux-windows-x64.json) records:
`hashline_edit` schema `3686 -> 5033`
(+1347, 36.54%), `hashline_write` schema `282 -> 548` (+266, 94.33%), readback call `181 -> 218`
(+37), and parent-create call `50 -> 81` (+31). This is retained model-free mechanical evidence, not
a paid/model-quality claim.

## Migration From 0.4.0

Snapshot headers can now append `partial=true`. Parsers must accept this optional trailing token and should not infer cumulative issued coverage from `lines=<count>` or one page alone. On a fixed three-line fixture, partial-page output grows from 84 to 97 UTF-8 bytes (+13); complete-page output remains 88 bytes.

Successful edit output now includes the `@hashline-edit` lifecycle line. On the fixed fixture, no-readback output grows from 49 to 87 bytes and unavailable-readback output from 92 to 94 bytes. The attached prefix, measured through its trailing separator before the snapshot header, grows from 21 to 73 bytes.

Provider-contract evidence now measures the actual OpenCode-projected schema separately for each description. After removing duplicated guidance, the hashline contract shrinks from 3,646 to 3,326 UTF-8 bytes (-320, 8.8%); the native-alias contract shrinks from 3,812 to 3,496 bytes (-316, 8.3%). The schema and native protocol fingerprints change, so experimental native-alias users must restart the plugin and begin a new session after upgrading.

The display-prefix guard now gives exact payload coordinates, recognizes `@hashline-edit`, ignores renderer-impossible zero/zero-padded line numbers, bounds arbitrary decimal annotations to `N|` or `N!|`, and returns an exact worktree-bound native-alias rejection that compatible history can resume. Models must set `allowHashlinePrefixes:true` in the initial call when matched text is intentional.
`pack:check` verifies this path through two pinned OpenCode processes sharing one persisted session: reject without mutation, restart, reread, and retry successfully.

Native-alias calls remain sequential while session guidance reports `unbound`. After exact process-local binding, guidance reports `bound` and permits concurrent calls only for independent files; same-path calls remain serialized and outcomes are not transactional.

Mixed `replace_file` batches now return `INVALID_ARGUMENT`, while duplicate insert/copy destinations return the new `INSERTION_BOUNDARY_CONFLICT`. Genuine spatial intersections retain `OPERATIONS_OVERLAP`. Consumers that branched on the previous broad overlap code should accept the new classification.

## Migration From 0.1.1

Existing `replace`, `insert`, and `replace_file` calls retain their previous runtime requirements,
bytes, relocation order, error codes, and base-overlap diagnostic text. The provider-level `lines`
field is now optional only so the
payload-free transfer operations can share the same flat object schema; runtime validation still
requires it for all three existing operations.

Generated clients must accept `copy_range` and `move_range` without `lines`. Older plugin versions
reject those enum values, so callers must not send transfers until the installed plugin advertises
them. No sequential-coordinate compatibility mode was added: every transfer coordinate belongs to
the immutable pre-batch snapshot.

## Versioning

The npm package version is the protocol version until a separate wire format is needed. `0.x` releases can change tool schemas. A future `1.0.0` requires a frozen grammar, compatibility fixtures, migration notes, and paired provider-schema tests.
