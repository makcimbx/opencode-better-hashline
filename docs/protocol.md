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
| `[""]` | One blank logical line |
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

Tool: `hashline_edit`

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

### Replace

`startLine` and `endLine` are one-based and inclusive. Every line in the range must have been issued from the same snapshot. Range endpoints alone are never sufficient.

### Insert

`afterLine` identifies a boundary. Zero means before the first line. The file line count means after the last line. Both neighboring lines must have been issued; BOF and EOF require their respective provenance. Two insertions at the same boundary are rejected as overlap.

### Replace File

```json
{
  "op": "replace_file",
  "lines": ["complete", "content"],
  "finalNewline": true
}
```

`replace_file` must be the sole operation, requires `rebase: "none"`, exact current bytes, and a completely issued snapshot including BOF and EOF.

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

There is no fuzzy normalization, whitespace tolerance, nearest candidate, conflict marker, or fallback from strict to unique.

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

A one-file operation array is validation-atomic: all operations are parsed, issued-provenance checked, mapped against one immutable current document, and overlap/order checked before mutation. Operations are then composed in memory and at most one destination replacement is attempted.

This is not a filesystem transaction. Post-rename verification can detect an immediate overwrite but cannot safely roll it back without risking a newer writer. Multi-file tool calls are independent and can leave an earlier file committed if a later file fails.

## Stable Errors

Errors are rendered as `CODE: message`. Current codes include:

| Code | Meaning |
| --- | --- |
| `SNAPSHOT_REQUIRED` | No valid issued snapshot is available |
| `SNAPSHOT_UNKNOWN` | ID was not retained for this scope |
| `SNAPSHOT_EXPIRED` | Snapshot exceeded its configured TTL |
| `PATH_MISMATCH` | Snapshot and requested canonical paths differ |
| `REF_NOT_ISSUED` | Requested line or boundary was not shown as editable |
| `RANGE_NOT_FULLY_ISSUED` | At least one interior range line was not issued |
| `TARGET_CHANGED` | Strict bytes or exact relocation target changed |
| `BOUNDARY_CHANGED` | Required insertion neighbors no longer match |
| `AMBIGUOUS_RELOCATION` | Exact target/context has multiple candidates or reordered |
| `OPERATIONS_OVERLAP` | Operations overlap or share an insertion boundary |
| `DISPLAY_PREFIX_REJECTED` | Payload appears copied with model-facing annotations |
| `PERMISSION_DENIED` | OpenCode rejected a required permission |
| `RACE_BEFORE_WRITE` | Identity or bytes changed before publication |
| `RACE_AFTER_WRITE` | Published bytes, identity, link count, or parent did not remain equal to the plan |
| `UNSUPPORTED_FILE` | File type, metadata, encoding, size, or policy is unsupported |

Consumers should treat all errors as failures. There are no successful-looking error strings.

## Versioning

The npm package version is the protocol version until a separate wire format is needed. `0.x` releases can change tool schemas. A future `1.0.0` requires a frozen grammar, compatibility fixtures, migration notes, and paired provider-schema tests.
