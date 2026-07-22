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

At the top level, `rebase` is optional and defaults to `"none"`. `allowHashlinePrefixes` is optional and defaults to `false`. Before any path lookup or permission, the executor rejects literal `replace`, `insert`, and `replace_file` lines beginning in column zero with a positive non-zero decimal annotation (`17|` or `17!|`) or the exact markers `@hashline`, `@hashline-edit`, `@more`, `@eof`, and `@note`. Zero, zero-padded numbers, leading whitespace, and names such as `@hashline-style` are not renderer annotations. Set the top-level flag in the initial call only when the matched prefix is intentional file content; it applies to the whole batch and never strips or rewrites bytes.

A rejection identifies the exact `operations[i].lines[j]` coordinate and a bounded prefix kind. On the default surface, no snapshot is consumed and the call throws normally. Native aliases instead return a completed non-mutating terminal result so supported OpenCode hosts persist its exact protocol/package/schema/host/worktree/surface/input marker. The same process can continue from its binding; after restart, continuation requires that exact unsanitized result. Text matching alone never makes a rejected native-looking call compatible.

`readback` is optional and defaults to `false`. Use it for structural verification or a dependent follow-up edit; the attached page begins with unified-diff context near the first changed hunk. Every successful edit begins with `Applied N operations.` followed by one lifecycle line:

```text
@hashline-edit previous=consumed successor=none next=hashline_read
@hashline-edit previous=consumed successor=attached
@hashline-edit previous=consumed successor=unavailable next=hashline_read
```

`none` means no successor was requested. `attached` is immediately followed by a bounded page from a new snapshot near the first changed hunk. The old snapshot remains invalid, and successor refs become editable only after the same output-digest, marker, and truncation checks used by `hashline_read`. If those checks fail, the write remains successful but the after-hook replaces the result with `unavailable`.

A bounded readback that starts after line 1, stops before EOF, or contains a preview-only line is explicitly marked `partial=true` in its header. Its displayed `N|` refs remain usable. Whole-file replacement still requires cumulative issued coverage of all lines plus BOF and EOF; read missing pages for the same unchanged snapshot or perform a fresh complete read.

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

In a transfer-containing batch, every source range, destination boundary, move corridor, replacement range, and insertion boundary is mapped canonically through one cumulative work budget. Copy source and destination anchors relocate independently. Move source, corridor, and destination anchors also relocate independently, then must retain their exact geometric relationship. Pairwise range and boundary relations must remain equal to the base snapshot. A destructive span intersecting a move corridor or an insertion destination strictly inside it rejects rather than being incorporated into the move; a read-only copy source may intersect it.

This global topology and canonical anchor ordering applies only to batches containing `copy_range` or `move_range`. Transfer-free batches retain the pre-transfer mapper order, work consumption, and output bytes for batches that remain valid. Consequently, adding a transfer to an otherwise unchanged legacy batch can expose a global topology ambiguity and return `AMBIGUOUS_RELOCATION`.

There is no fuzzy normalization, whitespace tolerance, nearest candidate, conflict marker, or fallback from strict to unique.

For example, suppose a retained snapshot contains `alpha`, `target`, `omega`, and another process inserts `prefix` at BOF. Strict mode returns `TARGET_CHANGED`; `rebase: "unique"` can use that same retained ID to relocate base line 2 to current line 3 when the exact evidence is unique. If a successful Better Hashline edit already consumed the ID, a later call returns `SNAPSHOT_UNKNOWN` before relocation; use its readback successor or read again.

## Native-Alias Session and Metadata Contract

Native aliases use protocol marker `native-aliases/v1`. Completed `edit` metadata contains the exact unified diff in `diff` and `filediff.patch`; completed `apply_patch` metadata contains one update in `files[]`. Both include additions/deletions, empty `diagnostics`, and `betterHashline` fields for the protocol, package version, canonical schema SHA-256, exact host version, active alias, and canonical path SHA-256. Serialized metadata is measured before permission and publication and may not exceed 1 MiB.

On native aliases, `DISPLAY_PREFIX_REJECTED` is a completed non-mutating terminal result because supported OpenCode hosts persist returned result metadata, but do not persist a lazy metadata update discarded before a throw. Its separate `betterHashlineRejection` marker contains exact protocol/package/schema/host/worktree/surface identity, canonical input SHA-256, payload coordinate, and bounded prefix kind. It attests only that this exact input stopped before path access, permission, and mutation; it is never successful provenance.

Each plugin instance binds a session to one protocol fingerprint. Before the first edit it reads a bounded history of at most 200 messages, 2,000 parts, and 1 MiB, then validates every historical mutator. Message, part, call, session, input path, metadata keys, single-file unified-diff hunks, counts, and renderer path must agree exactly. Native `write`, `hashline_edit`, unknown fields, malformed hunks, and any terminal rejection except exact native-shaped `INVALID_ARGUMENT` errors or an exact completed `DISPLAY_PREFIX_REJECTED` result are incompatible. Unmarked, malformed, sanitized, conflicting, unreadable, cross-worktree, or cross-surface history returns `SESSION_PROTOCOL_MISMATCH`.

Only the exact current running call is excluded. OpenCode can expose that call before its persisted input has caught up with parsed before-hook arguments. For the same exact call ID and tool, the plugin may reread bounded local history five times under one 160 ms stabilization deadline after the initial bounded read; exclusion still requires exact input equality. A different call ID, tool, path, snapshot, operation, permanently different input, or more than one active alias remains incompatible before binding.

System guidance reports the process-local state as `native-alias-session=unbound`, `bound`, or `mismatch`. Unbound sessions must serialize calls until one exact before-hook attestation binds the session. Once bound to the current package/schema/host/worktree fingerprint, independent single-file calls for different canonical paths may run concurrently. The filesystem still serializes calls targeting one canonical path, and each file retains a separate plan, approval, reread, rename, verification, and success/failure outcome. This is not a multi-file transaction.

A restart clears snapshots and process bindings. Resume requires compatible unsanitized history plus a fresh `hashline_read`, and calls remain serialized until the new process binds. Binding eviction has the same effect. A mismatched binding fails closed and requires a new session. Changing surfaces or configuration requires a restart and a new session.

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
14. When `readback: true`, retain those verified bytes as a new snapshot and render a bounded page.
15. Issue the successor refs only after `tool.execute.after` attests the delivered output.

No rebase or diff change occurs after permission approval. If state changed while approval was pending, publication rejects.

For a new file, `hashline_write` requests the same path permissions, writes and flushes an exclusive same-directory temporary file, then publishes it with a no-replace hard link. It verifies staged and published identity, link count, exact bytes, and parent identity before returning success. It never overwrites a file, directory, or symlink. Filesystems that cannot provide these local hard-link semantics reject the operation. A failure after the hard link succeeds can leave the new file committed; the plugin reports `RACE_AFTER_WRITE` and does not risk deleting a newer writer's file.

## Batch Semantics

A one-file operation array is validation-atomic: all operations are parsed, issued-provenance checked, mapped against one immutable current document, and overlap/order checked before mutation. Operations are then composed in memory and at most one destination replacement is attempted. In a transfer-containing batch, required ranges are deduplicated and checked in coordinate order before deduplicated destination boundaries are checked in coordinate order, so request-array order cannot change the provenance error class. Transfer-free batches retain their existing request-order provenance behavior.

The array is declarative, not a sequential program, and array order cannot resolve conflicts. Every source is read from the immutable pre-batch document. The batch rejects:

- overlapping destructive spans;
- insertions or copy destinations sharing a boundary;
- any insertion or copy destination strictly inside a destructive span.

Immediately adjacent, non-intersecting destructive spans are valid. An insertion-like destination may touch either destructive endpoint. Copy sources may overlap other reads or writes because they always read the immutable pre-batch document. Conflict rules are checked both before and after unique relocation.

If a transfer-containing batch has several conflict classes, diagnostics use one global precedence:
destructive intersection, insertion strictly inside a destructive span, then duplicate insertion
boundary. Request-array order therefore changes neither the error code nor its diagnostic text.
Diagnostics include a repair hint to merge overlapping destructive payloads, fold an internal
insertion into its replacement, or combine same-boundary insertions in the intended order.

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
| `OPERATIONS_OVERLAP` | Destructive effects intersect, or an insertion-like destination lies strictly inside a destructive span |
| `INSERTION_BOUNDARY_CONFLICT` | Multiple insertion-like effects share one destination boundary |
| `DISPLAY_PREFIX_REJECTED` | A payload begins with a model-facing annotation; native aliases persist this failure as a completed non-mutating terminal result |
| `PERMISSION_DENIED` | OpenCode rejected a required permission |
| `RACE_BEFORE_WRITE` | Identity or bytes changed before publication |
| `RACE_AFTER_WRITE` | Published bytes, identity, link count, or parent did not remain equal to the plan |
| `UNSUPPORTED_FILE` | File type, metadata, encoding, size, or policy is unsupported |

Consumers must treat every `CODE: message` as failure. The native-alias `DISPLAY_PREFIX_REJECTED` result is completed only at the host transport layer so its attestation persists; it never reports `Applied`, requests permission, or changes a file.

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
