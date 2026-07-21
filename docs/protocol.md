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

The experimental `toolSurface: "native-aliases"` requires `enforce: true` and an allowlisted exact
OpenCode host, currently only `1.18.3`. It exposes `hashline_read`, create-only `hashline_write`, and
both Better Hashline edit definitions under `edit` and `apply_patch`; OpenCode's model-family filter
retains exactly one alias. It does not register `hashline_edit` and never aliases native `write`.
Unavailable hosts or schemas remain diagnostic and fail closed without changing surfaces.

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
@hashline snapshot=s_<22-base64url> sha256=<12-hex> lines=<count>
<line>|<exact text>
<line>!|<preview>... [preview only; line not issued]
@more offset=<next one-based line>
@eof
```

`N|` lines become editable only after `tool.execute.after` confirms that OpenCode did not generically truncate the custom-tool result. A line is rendered as preview-only `N!|` only when its complete annotated form cannot fit in one configured output page; preview-only lines never become issued. Marker loss, host truncation, or output mutation issues no new refs; previously issued refs on a reused snapshot remain valid. Cache eviction and publication still invalidate affected snapshots rather than guessing what the model received.

## Edit

Tool: `hashline_edit`, or `edit`/`apply_patch` on the explicit native-alias surface

```json
{
  "filePath": "src/example.ts",
  "snapshotId": "s_J7yi7wDyv3j9xQ2zP5kL8A",
  "rebase": "none",
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
| `replace` | `startLine`, `endLine`, `lines` | none | `afterLine`, `finalNewline` |
| `insert` | `afterLine`, `lines` (non-empty) | none | `startLine`, `endLine`, `finalNewline` |
| `replace_file` | `lines` | `finalNewline` | `startLine`, `endLine`, `afterLine` |
| `copy_range` | `startLine`, `endLine`, `afterLine` | none | `lines`, `finalNewline` |
| `move_range` | `startLine`, `endLine`, `afterLine` | none | `lines`, `finalNewline` |

`replace_file` must also be the sole operation and use `rebase: "none"`. Unknown operation fields
are rejected rather than ignored.

At the top level, `rebase` is optional and defaults to `"none"`. `allowHashlinePrefixes` affects only
literal `replace`, `insert`, and `replace_file` payloads; leave it omitted unless an `N|` or
`@hashline`-style prefix is intentional file content.

### Replace

`startLine` and `endLine` are one-based and inclusive. Every line in the range must have been issued from the same snapshot. Range endpoints alone are never sufficient.

### Insert

`afterLine` identifies a boundary. Zero means before the first line. The file line count means after the last line. Both neighboring lines must have been issued; BOF and EOF require their respective provenance. Two insertions at the same boundary are rejected as overlap.

### Copy Range

```json
{
  "op": "copy_range",
  "startLine": 4,
  "endLine": 8,
  "afterLine": 20
}
```

`startLine..endLine` is an inclusive source range and `afterLine` is a destination boundary. All coordinates refer to the supplied immutable snapshot. Copy inserts the retained logical source texts using the same destination-local EOL rule as `insert`; it does not promise to retain the source delimiters or final-newline state. The entire source and the destination boundary must have been issued. A destination inside the copy's own source is valid.

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
- relocated operations do not overlap.

An insertion relocates only when both original neighboring line tokens remain adjacent at the selected base boundary and all successful bounded signatures agree on one boundary. BOF/EOF require a bounded prefix/suffix that occurs only at the corresponding current edge; copied edge evidence is ambiguous. A concurrent insertion at the same boundary invalidates the boundary.

In a transfer-containing batch, every source range, destination boundary, move corridor, replacement range, and insertion boundary is mapped canonically through one cumulative work budget. Copy source and destination anchors relocate independently. Move source, corridor, and destination anchors also relocate independently, then must retain their exact geometric relationship. Pairwise range and boundary relations must remain equal to the base snapshot. Any insertion or change inside a move corridor rejects rather than being incorporated into the move.

This global topology and canonical anchor ordering applies only to batches containing `copy_range` or `move_range`. Transfer-free batches retain the pre-transfer mapper order, work consumption, output bytes, and error behavior for compatibility. Consequently, adding a transfer to an otherwise unchanged legacy batch can expose a global topology ambiguity and return `AMBIGUOUS_RELOCATION`.

There is no fuzzy normalization, whitespace tolerance, nearest candidate, conflict marker, or fallback from strict to unique.

## Native-Alias Session and Metadata Contract

Native aliases use protocol marker `native-aliases/v1`. Completed `edit` metadata contains the exact
unified diff in `diff` and `filediff.patch`; completed `apply_patch` metadata contains one update in
`files[]`. Both include additions/deletions, empty `diagnostics`, and `betterHashline` fields for the
protocol, package version, canonical schema SHA-256, exact host version, active alias, and canonical
path SHA-256. Serialized metadata is measured before permission and publication and may not exceed
1 MiB.

Each plugin instance binds a session to one protocol fingerprint. Before the first edit it reads a
bounded history of at most 200 messages, 2,000 parts, and 1 MiB, then validates every historical
mutator. Message, part, call, session, input path, metadata keys, single-file unified-diff hunks, counts,
and renderer path must agree exactly. Native `write`, `hashline_edit`, unknown fields, malformed hunks,
and anything except the exact known native-shaped `INVALID_ARGUMENT` rejection are incompatible.
Unmarked, malformed, sanitized, conflicting, unreadable, or cross-surface history returns
`SESSION_PROTOCOL_MISMATCH`. Only the exact current running call is excluded. OpenCode can expose that
call before its persisted input has caught up with the parsed before-hook arguments. For the same exact
call ID and tool, the plugin may reread bounded local history five times under one 160 ms stabilization
deadline after the initial bounded read; exclusion still requires exact input equality. A different call ID, tool, path, snapshot, operation, permanently
different input, or more than one active alias remains incompatible. A restart clears snapshots and
process bindings; resume requires compatible unsanitized history plus a fresh `hashline_read`. Changing
surfaces requires a restart and a new session.

Native alias edits are sequential. Models must not issue `edit` or `apply_patch` concurrently or in the
same assistant message. Multi-file edits wait for each tool result before starting the next call.

## Permission and Publication Order

For an existing file:

1. Resolve the lexical path and canonical target.
2. Pin and validate snapshot scope, path, and issued provenance.
3. Request `external_directory` when the canonical target is outside the allowed roots. On POSIX, parents containing literal `*` or `?` can be approved once but are not persisted as wildcard rules; Windows rejects those invalid filename characters before permission.
4. Acquire the process-global canonical-path lock.
5. Reread bytes and file identity; revalidate symlink target and supported metadata.
6. Plan every operation against one immutable current document.
7. Build the exact unified diff.
8. Request standard `edit` permission with `{ filepath, diff }` metadata.
9. Create an exclusive same-directory temporary file, write, flush, and preserve supported metadata.
10. Reread the destination and recheck exact bytes, identity, and alias target after permission wait.
11. Invalidate all snapshots for this session/path immediately before publication.
12. Attempt one rename over the canonical target.
13. Reread and verify the resulting bytes.

No rebase or diff change occurs after permission approval. If state changed while approval was pending, publication rejects.

For a new file, `hashline_write` requests the same path permissions, writes and flushes an exclusive same-directory temporary file, then publishes it with a no-replace hard link. It verifies staged and published identity, link count, exact bytes, and parent identity before returning success. It never overwrites a file, directory, or symlink. Filesystems that cannot provide these local hard-link semantics reject the operation. A failure after the hard link succeeds can leave the new file committed; the plugin reports `RACE_AFTER_WRITE` and does not risk deleting a newer writer's file.

## Batch Semantics

A one-file operation array is validation-atomic: all operations are parsed, issued-provenance checked, mapped against one immutable current document, and overlap/order checked before mutation. Operations are then composed in memory and at most one destination replacement is attempted. In a transfer-containing batch, required ranges are deduplicated and checked in coordinate order before deduplicated destination boundaries are checked in coordinate order, so request-array order cannot change the provenance error class. Transfer-free batches retain their existing request-order provenance behavior.

The array is declarative, not a sequential program, and array order cannot resolve conflicts. Every source is read from the immutable pre-batch document. The batch rejects:

- overlapping destructive spans;
- a copy source intersecting another operation's destructive span or move corridor;
- insertions or copy destinations sharing a boundary;
- any insertion boundary at either end of or inside a destructive span;
- any other operation intersecting a move corridor.

Immediately adjacent, non-intersecting destructive spans are valid. Overlapping copy sources and otherwise independent mixed or multiple transfer operations are valid. Conflict rules are checked both before and after unique relocation.

If a transfer-containing batch has several conflict classes, diagnostics use one global precedence:
transfer read/write dependency, destructive intersection, insertion touching a destructive span, then
duplicate insertion boundary. Request-array order therefore changes neither the error code nor its
diagnostic text. Transfer-free batches retain the released `0.1.1` overlap diagnostics.

An individually byte-identical `move_range` rejects the entire batch with `NO_CHANGE`, including when another member would change the file. This intentionally treats an identity move as a model-addressing error. Legacy no-op `replace` or `insert` members retain aggregate behavior: they are accepted when the final batch changes bytes.

The provider accepts 1 to 100 operations. Each `replace` accepts 0 to 20,000 payload lines; `insert` accepts 1 to 20,000. Each payload item is one logical line and must not contain CR, LF, NUL, or invalid Unicode. Aggregate payload and projected final output must remain within configured byte and logical-line limits. Transfer projection is bounded before final materialization, including copy amplification.

This is not a filesystem transaction. Post-rename verification can detect an immediate overwrite but cannot safely roll it back without risking a newer writer. Multi-file tool calls are independent and can leave an earlier file committed if a later file fails.

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
| `PATH_NOT_FOUND` | Requested source path does not exist |
| `TARGET_EXISTS` | Create-only publication found an existing path |
| `SNAPSHOT_REQUIRED` | No valid issued snapshot is available |
| `SNAPSHOT_UNKNOWN` | ID was not retained for this scope |
| `SNAPSHOT_EXPIRED` | Snapshot exceeded its configured TTL |
| `PATH_MISMATCH` | Snapshot and requested canonical paths differ |
| `REF_NOT_ISSUED` | Required BOF or EOF boundary was not issued |
| `RANGE_NOT_FULLY_ISSUED` | A required range line or internal boundary neighbor was not issued |
| `TARGET_CHANGED` | Strict bytes or exact relocation target changed |
| `BOUNDARY_CHANGED` | Required insertion neighbors no longer match |
| `AMBIGUOUS_RELOCATION` | Exact target/context is ambiguous or reordered, or relocation makes a move EOL layout unrepresentable |
| `OPERATIONS_OVERLAP` | Independent operation effects overlap or share an insertion boundary |
| `DISPLAY_PREFIX_REJECTED` | Payload appears copied with model-facing annotations |
| `PERMISSION_DENIED` | OpenCode rejected a required permission |
| `RACE_BEFORE_WRITE` | Identity or bytes changed before publication |
| `RACE_AFTER_WRITE` | Published bytes, identity, link count, or parent did not remain equal to the plan |
| `UNSUPPORTED_FILE` | File type, metadata, encoding, size, or policy is unsupported |

Consumers should treat all errors as failures. There are no successful-looking error strings.

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
