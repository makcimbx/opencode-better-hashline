# Copy And Move Range Integration Plan

Status: implemented and deterministically verified on 2026-07-19. No paid model-quality result is
implied by this document.

| Field | Value |
| --- | --- |
| Plan version | 1.0 implemented |
| Plan date | 2026-07-19 |
| Source baseline | `1f408c0c30e355fd5a2aeff814cbabdf0e6c6f1f` |
| Package baseline | `opencode-better-hashline@0.1.1` |
| OpenCode baseline | `1.18.3` |

## Purpose

This plan defines a fail-closed integration of two same-file line operations:

- `copy_range`: copy retained source line text to a retained destination boundary;
- `move_range`: move retained source line text to a retained destination boundary.

The operations address a concrete opportunity that the current protocol cannot express compactly.
Today a model must echo every copied line through `insert`, and a move requires echoed content plus a
deletion. Server-side transfer can reduce output size and prevent transcription drift while retaining
snapshot, provenance, approval, race, and publication guarantees.

The target is the full protocol mode in the first public release of the feature:

- both `rebase: "none"` and `rebase: "unique"`;
- mixed batches with existing operations;
- multiple non-conflicting copy and move operations;
- one immutable result, one exact approval diff, and one publication.

Full mode does not mean that operations execute sequentially or that every combination is accepted.
It means that every accepted combination has deterministic pre-edit semantics and a non-conflicting
effect graph. Ambiguous combinations reject before permission.

## Goals

- Keep all coordinates relative to one immutable snapshot/current document.
- Never require the model to resend copied or moved source text.
- Require issued provenance for a copy source and destination, and for a move's complete write
  corridor and destination boundary.
- Preserve existing strict and exact-unique freshness behavior.
- Make successful batch results independent of operation-array order.
- Keep existing `replace`, `insert`, and `replace_file` behavior unchanged.
- Preserve BOM, and preserve exact EOL slots and final-newline state for moves.
- Bound relocation work, projected output, and peak materialization before permission.
- Reuse the existing filesystem authorization and publication path unchanged.

## Non-Goals

- Cross-file copy, move, rename, or deletion.
- Raw byte-span transfer or byte-offset addressing.
- Sequential operations that address output created earlier in the same batch.
- Fuzzy, normalized, nearest, first-match, or source-repair behavior.
- Copying preview-only or otherwise unissued source lines.
- A multi-file transaction or hostile-writer kernel compare-and-swap guarantee.
- Treating file-level `move` implementations as precedent for line-level semantics.

## Research Basis

No surveyed Hashline implementation exposes arbitrary line-range copy or move. Current oh-my-pi
`MV` is a whole-file operation, not a line operation. The closest mature line and transaction models
are below.

| Source | Relevant behavior | Adopted lesson |
| --- | --- | --- |
| [Vim `:copy` and `:move`](https://github.com/vim/vim/blob/6f02e5cd7c27fc098d0b8dfec99542c7663a807e/src/ex_cmds.c#L872-L1076) and [tests](https://github.com/vim/vim/blob/6f02e5cd7c27fc098d0b8dfec99542c7663a807e/src/testdir/test_move.vim#L1-L64) | Inclusive one-based source and destination below line `d`; copy may target inside its source; move rejects an interior destination | Reuse `startLine`, `endLine`, and `afterLine`; allow self-copy; reject an interior move |
| [CodeMirror changes](https://codemirror.net/docs/guide/#changes-and-transactions) and [line commands](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/commands.ts#L700-L771) | One transaction is atomic and ordinary change coordinates refer to the start document | Use immutable pre-edit coordinates and compose once |
| [LSP 3.18 `TextEdit[]`](https://github.com/microsoft/language-server-protocol/blob/b7f5132c95261c0898ae5124e7a91707abc48fcd/_specifications/lsp/3.18/types/textEditArray.md) | All edits address the same initial state; overlapping text edits are invalid | Keep simultaneous coordinates and reject conflicting write footprints |
| [JSON Patch move/copy](https://www.rfc-editor.org/rfc/rfc6902#section-4.4) | Operations are sequential; move is remove followed by add, so array indexes are post-removal | Do not copy its evolving-index semantics; callers must never adjust a downward destination |
| [oh-my-pi file operations](https://github.com/can1357/oh-my-pi/blob/9fd6e97113f5ed3a847e66d346970efdf8afcad9/packages/hashline/src/types.ts) | `MV` is file-level and publication is not a same-file line transaction | Keep file lifecycle outside `operations[].op` |
| [VS Code line operations](https://github.com/microsoft/vscode/blob/86f5a62f058e3905f74a9fa65d04b2f3b533408e/src/vs/editor/contrib/linesOperations/browser/moveLinesCommand.ts) | Line text is edited under a document-level EOL model | Treat transfers as logical line text rather than raw delimiter-bearing spans |

The useful common ground is limited: immutable coordinates, complete-line values, explicit overlap
rules, and one transaction. Freshness, issued provenance, exact relocation, and approval binding are
specific requirements of this project.

## Public Protocol

### Operation Shapes

```ts
type CopyRangeOperation = {
  op: "copy_range";
  startLine: number;
  endLine: number;
  afterLine: number;
};

type MoveRangeOperation = {
  op: "move_range";
  startLine: number;
  endLine: number;
  afterLine: number;
};
```

Example calls:

```json
{
  "op": "copy_range",
  "startLine": 3,
  "endLine": 7,
  "afterLine": 20
}
```

```json
{
  "op": "move_range",
  "startLine": 3,
  "endLine": 7,
  "afterLine": 20
}
```

Both operations:

- use a one-based inclusive source range;
- use the existing boundary convention, where `afterLine: 0` is BOF and `lineCount` is EOF;
- refer to coordinates in the supplied snapshot, never an intermediate result;
- require `startLine`, `endLine`, and `afterLine`;
- forbid `lines` and `finalNewline`;
- remain same-file by using the existing top-level `filePath` and `snapshotId`.

The provider-facing operation object remains flat and strict. Its `lines` field must become optional
at the provider-schema level because transfer operations have no model-supplied payload. Runtime
validation must continue to require `lines` for `replace`, `insert`, and `replace_file` and forbid it
for both transfer operations. Existing valid calls remain valid.

Do not require `lines: []` as a sentinel. It wastes wire space, conflicts with the existing deletion
meaning, and weakens operation-specific diagnostics.

### Immutable Coordinates

Given snapshot lines `A B C D E`:

```text
move_range startLine=2 endLine=3 afterLine=5
result: A D E B C
```

The caller does not subtract the two removed lines. The planner adjusts the insertion position from
the original snapshot internally.

All model-supplied payloads and all transfer sources are read from the immutable current document
before any operation in the batch is applied. A read footprint may not intersect another operation's
destructive write footprint, so accepted batches never need an old-versus-new ordering decision. A
model that needs newly generated text copied must use explicit payloads or a later edit call.

### Copy Geometry

`copy_range` allows every valid destination boundary, including:

- immediately before the source (`afterLine = startLine - 1`);
- immediately after the source (`afterLine = endLine`);
- strictly inside a multi-line source;
- before or after a disjoint source.

This is deterministic because the source is read from the immutable pre-edit document and copy has
no destructive source effect.

### Move Geometry

For source `[s, e]` and destination `d`:

- `s <= d < e` rejects with `INVALID_ARGUMENT` because a destination strictly inside the source is
  invalid intrinsic move geometry, not a conflict between operations;
- `d = s - 1` or `d = e` rejects with `NO_CHANGE` because the block is already at that boundary;
- `d < s - 1` is an upward move;
- `d > e` is a downward move.

A whole-file move cannot change line order and therefore rejects with `NO_CHANGE`. A non-adjacent
move across byte-identical lines must also reject if its own rendered write span is byte-identical.

### Logical Line And EOL Semantics

The transferred value is the exact Unicode text of each selected logical line without its EOL.
Unicode normalization is never performed.

`copy_range` is normatively equivalent to an `insert` at the same mapped boundary whose `lines`
are the selected pre-edit line texts. It therefore uses the existing destination-local insertion EOL
rules and preserves all unaffected existing bytes. It also inherits the document model's no-phantom
final-line behavior: copying one empty logical line to an unterminated EOF may only add the final
delimiter, rather than increase parsed `lineCount`. Copy does not add a separate final-newline
promise beyond existing `insert` semantics.

`move_range` reorders logical line texts while retaining the current document's EOL slot at every
output line position. Therefore a move preserves:

- the BOM exactly once at byte zero;
- the exact ordered sequence of LF, CRLF, lone-CR, and empty EOL slots;
- line count;
- total byte count;
- final-newline state.

For example, moving the unterminated final line in `"a\nb"` to BOF must produce `"b\na"`, not
`"b\na\n"`. Raw source-span insertion is forbidden because it cannot provide this invariant at
BOF, EOF, and mixed-EOL boundaries.

The text parser collapses adjacent CR and LF bytes into one CRLF delimiter and does not retain a
phantom logical line after a terminal delimiter. A permutation involving empty texts can therefore
be impossible to serialize while preserving the required text/EOL-slot sequence. Reject that layout
with `INVALID_ARGUMENT` on an unchanged target, or `AMBIGUOUS_RELOCATION` when it appears only after
exact-unique relocation. Never normalize a delimiter or weaken the positional-slot invariant.

Existing `replace` and `insert` rendering remains unchanged. A move's EOL-slot rule composes safely
with them only when their write footprints are non-conflicting.

## Batch Effect Model

Every parsed operation is reduced to immutable read and write effects.

| Operation | Read footprint | Write footprint |
| --- | --- | --- |
| `replace` | None | Destructive line span `[startLine, endLine]` |
| `insert` | None | Insertion boundary `afterLine` |
| `copy_range` | Source range `[startLine, endLine]` | Insertion boundary `afterLine` |
| `move_range` | Complete move corridor | Destructive move corridor |
| `replace_file` | Whole snapshot | Whole file; remains exclusive |

For a valid move, its destructive corridor is:

```text
destination before source: [afterLine + 1, endLine]
destination after source:  [startLine, afterLine]
```

The corridor, rather than only the deleted source, is the write footprint because every logical
line position between source and destination changes value. Representing a move as one corridor
rewrite also makes EOL-slot preservation explicit.

### Conflict Table

| Pair | Rule |
| --- | --- |
| Read range / read range | Allowed |
| Read range / destructive span | Reject, except a move's own source inside its own corridor |
| Read range / insertion boundary | Allowed |
| Destructive span / destructive span | Allowed only when line spans are disjoint |
| Destructive span `[a,b]` / insertion boundary `d` | Reject when `a - 1 <= d <= b` |
| Insertion boundary / insertion boundary | Reject when both use the same boundary |
| Any operation / `replace_file` | Reject; `replace_file` remains sole-operation only |

Consequences:

- Multiple copies may read overlapping or identical sources.
- A copy source may not intersect a replace target or move corridor.
- Multiple moves are accepted only when their full corridors are disjoint.
- A replace span may be immediately adjacent to a move corridor, but may not intersect it.
- An insert or copy destination cannot be inside or at either edge of a destructive span.
- Two inserts/copies cannot rely on array order to order content at one boundary.
- A swap whose move corridors overlap is rejected rather than interpreted sequentially.

Operation array order never chooses source content, destination adjustment, or same-boundary
ordering. Every successful permutation of the same non-conflicting operation set must produce the
same exact bytes.

### Rejected Broader Batch Alternatives

Several deterministic-looking alternatives were considered and rejected because they weaken an
existing invariant or give request order semantic meaning:

- Same-boundary blocks ordered by array index: rejected because current insert/insert calls reject
  that boundary and operation permutation would change output.
- Insertion at a destructive range endpoint: rejected because current replace/insert calls treat both
  endpoints as touching the range.
- Copying from a range another operation writes: rejected even with a documented pre-edit read,
  because it introduces an old-versus-new dependency that models can easily misunderstand.
- Source-only move provenance and relocation: rejected because positional EOL semantics rewrites the
  complete source-to-destination corridor.
- Sequential delete then insert: rejected because downward coordinates, final newline, and failures
  would depend on an intermediate document.

These restrictions still permit full mixed and multiple-transfer batches whenever their declared
read/write effects are independent.

## Issued Provenance

`copy_range` requires both authorities:

1. `assertRangeIssued(snapshot, startLine, endLine)` for every source line.
2. `assertBoundaryIssued(snapshot, afterLine)` for the destination.

`move_range` additionally requires every line in its complete base move corridor to be issued. The
corridor is its true write footprint under positional EOL semantics: intermediate logical texts are
reassigned to different output slots. Endpoint-only authority would recreate the exact weakness that
the existing multiline replacement protocol rejects.

The existing rules remain authoritative:

- a preview-only `N!|` line is not issued;
- an interior boundary requires both neighboring lines;
- BOF and EOF require their delivered edge provenance;
- pending, truncated, marker-lost, or output-mutated reads issue nothing;
- sources and destinations may accumulate issuance over separate pages of the same snapshot.

Source-derived content bypasses the model-payload display-prefix guard. A real retained line that
starts with `1|`, `1!|`, `@hashline`, `@more`, `@eof`, or `@note` is valid transfer content without
`allowHashlinePrefixes`.

## Strict And Unique Rebase

### Strict

`rebase: "none"` retains its current contract. Any byte difference between retained and current
documents returns `TARGET_CHANGED`. Source and destination coordinates map identically.

### Exact Unique

Transfer batches use one `UniqueMapper` instance and one cumulative comparison-work budget.

1. Collect every distinct source, replacement, move-corridor, and boundary anchor from all
   operations.
2. Canonically sort anchors by kind and snapshot position so array order cannot change budget use.
3. Memoize identical anchors within the batch.
4. Map every range, including each full move corridor, with exact `[text, eol]` tokens.
5. Map every boundary with exact adjacent tokens or exact BOF/EOF evidence.
6. Extract all source text only after every anchor maps successfully.
7. Validate anchor topology and mapped effect conflicts before rendering.

Do not invoke one-off range and boundary wrappers that each reset the work budget.

### Anchor Topology

Independent uniqueness is not sufficient. Two individually unique anchors can relocate to an
incoherent combination. A batch containing transfer operations must preserve the topology of all
its range and boundary anchors.

The planner records pairwise snapshot relations and verifies them after mapping:

- range/range: before, after, equal, overlap, or containment with relative offsets;
- boundary/boundary: before, equal, or after;
- boundary/range: before, left edge, internal offset, right edge, or after.

Before/after distances may grow or shrink, but their side and order must not reverse. Equality,
overlap, containment, edge, and internal relationships must preserve their relative offsets.

This check applies to all anchors in a batch containing transfer operations, including anchors from
existing replace and insert operations. Existing batches without transfer operations retain their
current compatibility behavior.

### Compatibility Boundary

Global topology validation and canonical anchor ordering activate only when a batch contains at
least one transfer operation. A transfer-free batch must retain the exact existing mapping order,
budget consumption, accepted bytes, and error behavior. Consequently, adding a disjoint transfer to
an otherwise identical legacy batch can subject the legacy anchors to additional topology checks and
can change a relocation rejection to `AMBIGUOUS_RELOCATION`. This is an intentional public protocol
boundary, not an implementation detail.

Document both modes in `docs/protocol.md` and lock them with compatibility fixtures. Do not
canonicalize transfer-free batches as part of this feature; that would be a separate protocol change
requiring its own migration and evidence.

After mapping, rebuild move corridors and rerun the complete conflict table. Reject:

- source/destination side reversal;
- an internal/edge copy destination that no longer has the same source-relative position;
- mapped destructive overlap;
- a mapped insertion touching a destructive span;
- mapped destination collisions;
- write-effect order inversion;
- copied, ambiguous, contradictory, normalized, or nearest anchor selection.

For each move, independently map source `S`, corridor `E`, and destination boundary `P`, then require
exact coherence:

```text
upward move:   E.start = P and E.end = S.end; S is the right edge of E
downward move: E.start = S.start and E.end = P; S is the left edge of E
```

Mapping the complete exact corridor permits unrelated changes before or after a move, but never
inside it.

`S`, `E`, and `P` are conceptually related but remain distinct mapper inputs. Existing memoization
eliminates only identical anchors, so one move can consume three bounded searches, especially for a
long corridor. Retain that explicit accounting for independent error classification and coherence;
cover canonical worst-case consumption in tests before attempting an optimization that derives one
anchor from another.

Changed source tokens retain `TARGET_CHANGED`; changed destination adjacency retains
`BOUNDARY_CHANGED`; ambiguity, topology changes, and order reversal use
`AMBIGUOUS_RELOCATION`; mapped write conflicts use `OPERATIONS_OVERLAP`; exhausted comparison work
uses `UNSUPPORTED_FILE`.

## Pure Planning Algorithm

The implementation remains in the pure protocol layer. The filesystem layer receives only one
fully rendered result.

### Planning Phases

1. Parse the flat schema into the closed operation union.
2. Validate required/forbidden fields, integer coordinates, bounds, move geometry, and
   `replace_file` exclusivity against the snapshot.
3. Build snapshot anchor topology and base effect footprints; reject base conflicts.
4. Verify complete copy source/destination provenance and complete move-corridor/destination
   provenance.
5. Stable-reread one immutable current document through the existing filesystem path.
6. For strict mode, require exact bytes; for unique mode, map all anchors canonically through one
   shared mapper.
7. Verify mapped topology and rebuild mapped effects; reject current conflicts and order reversal.
8. Extract all copy/move source line texts from the immutable mapped current document.
9. Preflight exact projected line and UTF-8 byte counts before constructing derived output.
10. Render every mapped effect after projection and compose sorted immutable-offset segments once.
11. Encode once with the current BOM, parse the result defensively, and reject byte-identical output.
12. Return one result to the unchanged diff, permission, reread, stage, publish, and verify path.

No step may replan after permission.

### Copy Rendering

For each mapped copy:

1. Read `current.lines.slice(mappedStart - 1, mappedEnd).map(line => line.text)`.
2. Feed those logical values to the same destination rendering used by `insert`.
3. Emit one insertion `MappedChange` at the mapped destination offset.

The model-supplied `lines` validator and display-prefix validator are not run on these retained
values. Text validity is already guaranteed by the retained `TextDocument`.

### Move Rendering

For mapped source `[s,e]` and destination `d`, build one corridor change.

```text
if d < s - 1:
  corridor = current[d + 1 .. e]
  output texts = source block + intervening texts

if d > e:
  corridor = current[s .. d]
  output texts = intervening texts + source block
```

Render output text at corridor position `i` with the original current corridor position `i` EOL.
The replacement covers the complete corridor text span and preserves its exact EOL vector. Reject
the move with `NO_CHANGE` if the rendered corridor bytes equal the original corridor bytes.

Do not desugar a move into independent current `replace(..., [])` and `insert(...)` calls. That can
invent or remove a final newline and obscures the move's full write corridor.

### Projected Limits

Up to 100 payload-free copies can otherwise amplify a retained file before the existing final check.
Planning must reject projected limits before materializing derived copy strings.

Compute exact deltas from mapped immutable effects:

Compute final logical-line effects with the same no-phantom-line rules as `parseText`, rather than
assuming that every inserted empty string adds one parsed line. In particular, model and transfer
insertion at an unterminated EOF needs an explicit projection case. Compute exact bytes as:

```text
final line count = delimiter count
                 + (non-empty body not ending in a delimiter ? 1 : 0)
```

Derive that metadata from lazy unchanged/replacement/insertion segments before joining them. Segment
composition must merge a trailing lone CR plus a leading LF into one CRLF delimiter, including at
unchanged/change boundaries. Reuse the same projection helper for existing payload operations so
transfer limits cannot disagree with the final `assertLineLimit` check.

```text
final bytes = current bytes
            + exact rendered insertion/copy deltas
            + exact replacement deltas
            + zero move delta
```

Use source-range and UTF-8-length caches for repeated copies. Keep move strings lazy until projected
limits pass. Then reparse every rendered move against its expected logical texts and positional EOL
slots, and perform a final defensive parse and byte/line projection check. No separate 20,000-line
transfer-source cap is needed: retained file limits, the 100-operation cap, the projected final
limits, and the unique-work budget are authoritative.

Required complexity bounds:

- conflict and topology checks: `O(k^2)` for at most 100 operations/300 anchors;
- strict planning: linear in current text, accepted output, and payload size;
- unique planning: the same plus the existing capped exact-comparison work;
- peak derived materialization: `O(current bytes + maxFileBytes + operation metadata)`, not
  `O(operation count * maxFileBytes)` before rejection.

## Error Precedence

Use existing error codes; do not add transfer-specific codes.

| Phase | Representative condition | Error |
| --- | --- | --- |
| Schema/runtime | Missing coordinates, forbidden `lines`, unsafe integer | `INVALID_ARGUMENT` |
| Snapshot validation | Source or destination outside snapshot | `INVALID_ARGUMENT` |
| Base geometry | Move destination strictly inside its own source | `INVALID_ARGUMENT` |
| Base effects | Conflicting footprints between operations | `OPERATIONS_OVERLAP` |
| Base no-op | Move at either source edge; whole-file move | `NO_CHANGE` |
| Provenance | Unissued source interior | `RANGE_NOT_FULLY_ISSUED` |
| Provenance | Unissued move-corridor interior | `RANGE_NOT_FULLY_ISSUED` |
| Provenance | Unissued internal destination neighbor | `RANGE_NOT_FULLY_ISSUED` |
| Provenance | Unissued BOF or EOF destination edge | `REF_NOT_ISSUED` |
| Strict freshness | Any byte or BOM drift | `TARGET_CHANGED` |
| Unique source | Source token changed | `TARGET_CHANGED` |
| Unique destination | Neighbor adjacency changed | `BOUNDARY_CHANGED` |
| Unique coherence | Ambiguity, topology change, order reversal | `AMBIGUOUS_RELOCATION` |
| Mapped effects | Overlap or destination collision after relocation | `OPERATIONS_OVERLAP` |
| Bounded work/output | Mapper budget or projected result limit | `UNSUPPORTED_FILE` |
| Move layout | Unchanged layout cannot preserve logical text/EOL slots | `INVALID_ARGUMENT` |
| Move layout | Relocated layout cannot preserve logical text/EOL slots | `AMBIGUOUS_RELOCATION` |
| Rendered result | Individual move or aggregate result changes no bytes | `NO_CHANGE` |
| Approval race | Current bytes change after approval plan | `RACE_BEFORE_WRITE` |

All shape, base conflict, provenance, mapped conflict, output-limit, and no-change failures occur
before edit permission. Existing snapshot-consumption and publication rules remain unchanged.

An individually byte-identical `move_range` rejects with `NO_CHANGE` even when another operation in
the batch would change the aggregate result. Existing byte-identical `replace`/`insert` members retain
their current aggregate-only behavior. This intentional asymmetry treats a no-op move as likely model
confusion without changing accepted legacy batches; document and test it explicitly.

## Production Integration

### `src/edits.ts`

- Add `CopyRangeOperation` and `MoveRangeOperation` to `EditOperation`.
- Extend pure coordinate and operation-combination validation.
- Replace operation-specific base overlap checks with explicit read/write effect construction while
  preserving all existing accepted/rejected behavior for old operations.
- Add canonical anchor collection, mapped topology validation, and mapped effect construction.
- Add copy rendering through existing insertion behavior.
- Add a dedicated move-corridor renderer that preserves EOL slots.
- Add exact projected line/byte preflight before derived materialization.
- Keep one immutable output and final `NO_CHANGE` check.

Keep this logic in the existing pure protocol layer. Add a new module only if the effect/topology
implementation cannot remain reviewable in `edits.ts`; do not move any of it into filesystem code.

### `src/rebase.ts`

- Reuse one `createUniqueMapper` for every anchor in a transfer batch.
- Add batch-local canonical request ordering and memoization at the smallest suitable layer.
- Preserve the existing exact token, ambiguity, edge, and cumulative-work behavior.
- Do not add fuzzy matching or an independent budget for each transfer anchor.

### `src/plugin.ts`

- Extend the provider enum with `copy_range` and `move_range`.
- Make provider-level and raw `lines` optional.
- Continue requiring and validating payload lines for existing operations.
- Require exactly the three coordinates and forbid `lines`/`finalNewline` for transfer operations.
- Count only model-supplied lines toward payload budgets.
- Skip display-prefix inspection for source-derived transfer text.
- Require copy source/boundary issuance and complete move-corridor/boundary issuance.
- Update the model-facing description with immutable-coordinate and pre-edit-source semantics.
- Keep the existing edit authorization/publication callback and operation count.

### Files Expected To Remain Unchanged

- `src/snapshots.ts`: existing range/boundary provenance primitives are sufficient.
- `src/render.ts`: issuance behavior does not change.
- `src/filesystem.ts`: one-file approval and publication already provide the required lifecycle.
- `src/index.ts` and `src/server.ts`: no package export change is required.
- `src/options.ts`: no new configurable cap is required.
- `src/errors.ts`: existing error codes are sufficient.

## Deterministic Test Plan

Every new branch requires deterministic coverage. Tests must assert exact bytes and error codes, not
only decoded visible text.

### Schema And Runtime Tests

Add to `tests/plugin.test.ts`:

- both new enum values appear in the provider schema;
- transfer calls without `lines` pass provider and runtime validation;
- existing payload operations without `lines` still fail;
- each missing coordinate fails;
- `lines`, including `[]`, and `finalNewline` are forbidden;
- unknown fields remain rejected;
- fractional, unsafe, zero source, negative boundary, reversed range, and out-of-bounds coordinates
  fail before permission;
- old valid tool calls and schema expectations remain compatible.

### Exhaustive Pure Oracle

Add an implementation-independent reference oracle to `tests/edits.test.ts` using arrays of logical
line text and EOL slots.

Exhaustively enumerate small documents and all valid single operations:

- zero through six lines;
- unique and duplicate line text;
- one-line, multi-line, and whole-file sources;
- every source range and destination boundary;
- LF, CRLF, lone CR, mixed EOL, terminated, and unterminated EOF;
- BOM and no BOM;
- ASCII, astral Unicode, blank text, and hashline-looking real content.

For move, assert the exact line permutation and unchanged EOL vector. For copy, assert equivalence to
the existing insertion oracle at the same boundary.

### Batch Conflict And Composition Tests

Cover at least the following pairs and representative triples:

- disjoint replace plus move;
- disjoint insert plus move;
- multiple disjoint moves;
- multiple copies with overlapping or identical read sources;
- copy source overlapping a replace, rejecting in both array orders;
- copy source overlapping any part of a move corridor, rejecting in both array orders;
- copy destination inside its own source, accepting and matching the copy oracle;
- overlapping move corridors;
- replace intersecting a move corridor, rejecting, plus immediately adjacent disjoint replace spans,
  accepting;
- insert/copy destination inside or at either edge of a destructive span;
- duplicate insertion/copy destinations;
- `replace_file` with every other operation kind;
- multi-line move at `d = s-1` and `d = e`, expecting `NO_CHANGE`, and at `d = s` and
  `d = e-1`, expecting `INVALID_ARGUMENT`;
- one no-op move plus a changing operation, expecting batch-level `NO_CHANGE`, contrasted with a
  legacy no-op payload operation plus a changing operation retaining its current aggregate behavior;
- upward and downward moves with original-document coordinates.

For every accepted operation set, test all permutations and require identical bytes. For every
rejected conflict set, require a stable error class independent of permutation.

Add a compatibility fixture proving that a transfer-free legacy batch keeps current mapper ordering
and error behavior. Add the corresponding transfer-containing fixture to prove that all anchors then
use canonical ordering and global topology validation, including the documented possibility of an
`AMBIGUOUS_RELOCATION` rejection that the legacy-only mode does not perform.

### Deterministic Property Tests

Use a fixed-seed generator without a new dependency to exercise larger documents and batches.

Properties:

- accepted copy has exactly the same line-count, EOL, and final-newline behavior as inserting its
  source text values at the same boundary, including empty-text EOF cases;
- accepted move preserves line count, BOM, EOL vector, final newline, and the multiset of line text;
- move and copy source values always come from the pre-edit current document;
- successful non-conflicting batch output is permutation-invariant;
- planning does not mutate snapshot/current documents or operation objects;
- repeated planning over identical inputs yields identical bytes/errors;
- no rejected plan reaches permission or mutates a file;
- the production planner and independent oracle agree.

Use exhaustive small-state tests for completeness and fixed-seed larger tests for interaction depth.
Do not use a random test whose seed or failing case is not printed.

### Issued-Provenance Tests

Add plugin-level cases for:

- fully issued source and destination success;
- issued endpoints with one omitted interior source line;
- issued move source/destination with one omitted move-corridor line;
- a move corridor accumulated over several delivered pages;
- preview-only source line;
- preview-only move-corridor line;
- only one issued internal destination neighbor, expecting `RANGE_NOT_FULLY_ISSUED`;
- missing BOF or EOF authority, expecting `REF_NOT_ISSUED`;
- source and destination issued across separate pages;
- pending read not passed through `tool.execute.after`;
- truncated, marker-lost, and output-mutated delivery;
- session, worktree, path, and snapshot mismatch;
- a retained line beginning with each display prefix copied without the opt-out flag.

### Strict Freshness Tests

For each new operation, mutate before planning:

- source text;
- source EOL;
- destination neighbor;
- destination boundary adjacency;
- BOM;
- unrelated prefix, suffix, and text between source and destination.

Every strict case must return `TARGET_CHANGED`, request no edit permission, and write nothing.

### Unique Transfer-Anchor Tests

Add focused tests to `tests/rebase.test.ts` and `tests/edits.test.ts`:

- source and destination shift together;
- source and destination shift by different amounts while preserving side/order;
- source unchanged but destination shifted;
- destination unchanged but source shifted;
- copy destination at left edge, right edge, and internal offset;
- duplicate source with no decisive context;
- sole-surviving wrong duplicate;
- duplicate destination pair;
- changed source text or EOL;
- complete move corridor shifted intact by unrelated changes before/after it;
- changed or inserted text anywhere inside a move corridor;
- independently mapped move source/corridor/destination that fail edge-coherence checks;
- destination pair no longer adjacent;
- copied BOF/EOF evidence;
- contradictory contexts;
- source/destination side reversal;
- overlapping/contained anchor relation changes;
- two base-disjoint effects that overlap after mapping;
- destination collision after mapping;
- mapped write-order inversion;
- repeated identical anchors are mapped once;
- one move charges distinct source, corridor, and destination anchors through the shared budget;
- canonical mapping makes operation permutations consume the same budget;
- first anchors consume most of the shared budget and a later anchor deterministically exhausts it.

Never accept by nearest distance, first occurrence, normalization, or independently reset budgets.

### EOL, BOM, And EOF Golden Cases

Assert exact bytes for:

- LF, CRLF, lone CR, and mixed-EOL moves in both directions;
- `"a\nb"` and `"a\nb\n"` moving the final line to BOF;
- moving an unterminated final source into the middle;
- moving a terminated source to EOF;
- copy at BOF, interior, terminated EOF, and unterminated EOF;
- copy/move of blank logical lines;
- blank moves that would coalesce CR plus LF or lose a no-phantom EOF line rejecting fail-closed;
- exhaustive short raw documents over text, LF, and CR, with and without BOM, accepting every
  representable move and rejecting every non-representable layout;
- copying a blank source line to terminated and unterminated EOF;
- one BOM at byte zero after moving line 1;
- mixed batches outside a move corridor preserving the move EOL slots.

### Limit And Amplification Tests

- One copy exceeds `maxLines` by one.
- One copy exceeds `maxFileBytes` by one UTF-8 byte.
- Several individually small copies exceed each limit in aggregate.
- One hundred large copies reject before derived strings, diff, or permission are materialized.
- Astral Unicode and CRLF byte projection is exact.
- A move at configured limits succeeds because its line and byte deltas are zero.
- Existing 20,000-line payload and aggregate payload limits remain unchanged.
- Shared unique work remains bounded across up to 300 anchors in a transfer-containing batch.

Use a test-only injected callback or module-local counter at the planner seam so a projected-limit
test can prove that derived rendering was not entered, rather than inferring this only from the final
error. Do not export that instrumentation through the library or provider surface.

### Permission, Publication, And Race Tests

Add successful end-to-end plugin paths for strict and unique copy/move, including a mixed batch and
multiple transfers. Assert:

- exactly one final unified diff;
- exactly one edit permission request;
- move counts as one operation;
- permission denial writes nothing and leaves an unchanged snapshot retryable;
- mutation while permission is pending returns `RACE_BEFORE_WRITE`;
- no remapping, replanning, second permission, or partial publication occurs;
- successful publication invalidates every same-path snapshot;
- reuse of the consumed source snapshot fails;
- existing path, symlink, hardlink, read-only, abort, staging, and post-publication race behavior
  remains unchanged.

The production filesystem module should not need feature-specific branches. Existing filesystem
tests must still run in the focused safety suite.

### Packed OpenCode Smoke

Extend `scripts/session-smoke.ts` with at least one payload-free transfer call through the packed
plugin. This catches provider/host rejection caused by changing `lines` from required to optional.
Exercise both enum serialization and successful after-hook issuance before publication.

## Benchmark And Evidence Plan

### Deterministic Corpus

Update `benchmarks/suite.ts` explicitly. Its current non-replace fallthrough must not classify new
operations as insertions or ignore transfer sources.

Add scenarios for:

- exact copy before/inside/after source;
- exact upward and downward move;
- mixed-EOL and unterminated-EOF move;
- mixed non-conflicting batch;
- overlapping move corridors;
- strict stale source/destination;
- unique source ambiguity;
- unique destination ambiguity;
- topology reversal;
- mapped effect collision;
- shared work-budget exhaustion;
- projected copy amplification.

Record new evidence under a new write-once result path. Never overwrite the July 18 or July 19
results and never use `--force` on published evidence.

### Wire-Size Evidence

Protocol review requires before/after measurements:

- serialized provider schema bytes;
- tool-description bytes;
- representative tool-call bytes for 1, 10, 100, 1,000, and maximum accepted source lines;
- current `insert`/`replace` representation versus new copy/move representation;
- additional `hashline_read` bytes needed to issue a near and far move's complete corridor;
- break-even source size where schema overhead is recovered;
- exact output-token categories when a provider reports them, without claiming UTF-8 bytes are
  universal tokenizer counts.

The measured opportunity must include both recurring schema overhead and per-call payload savings.
The prior expectation is deliberately asymmetric: `copy_range` can save payload for any sufficiently
large issued source, while `move_range` is most likely economical for nearby moves because its full
corridor must be delivered and relocated. A move across 5,000 lines may require at least five reads
at the 1,000-line page cap and more under the 40 KB output cap. Evaluate and ship the two operations
independently; evidence for copy does not justify move.

### Model Tasks

Add a separately versioned development task set rather than silently changing the existing 12-task
baseline. Include:

- duplicate a long function or configuration block;
- move a function upward and downward among similar anchors;
- move a block across a long corridor, measuring the cost of obtaining full issued provenance;
- attempt to copy from a range replaced in the same batch, grading safe rejection and recovery;
- several disjoint transfers in one batch;
- source/destination shifts under an injected stale event;
- duplicate source and destination recovery after safe rejection;
- a control where ordinary `replace`/`insert` is still the better choice.

Compare otherwise identical tool descriptions with transfer operations enabled/disabled. Measure
exact task success, malformed calls, safe rejects, retries, rereads, tool rounds, output tokens,
latency, and unintended changes. Do not infer model benefit from deterministic safety tests.

`bun run bench:model` remains a no-cost dry run. Do not use `--execute` without explicit user
approval, an exact model/auth source, and `BENCHMARK_ACK_COSTS=yes`.

## Documentation And Compatibility

Update in the implementation change:

- `docs/protocol.md`: grammar, pre-edit sources, coordinate examples, EOL rules, effect conflicts,
  transfer versus transfer-free rebase modes, individual-move `NO_CHANGE` asymmetry, errors, limits,
  and atomicity;
- `README.md`: concise tool description and copy/move examples;
- `docs/architecture.md`: read/write effects, move corridors, and pure planner ownership;
- `docs/threat-model.md`: source/destination and full move-corridor provenance, topology,
  amplification, and approval binding;
- `docs/research.md`: primary-source comparison and explicit departure from sequential JSON Patch;
- `docs/benchmarks.md`: new deterministic and wire-size evidence;
- `docs/model-evaluation-plan.md` or its versioned task manifest: transfer-specific model tasks;
- release migration notes: provider `lines` optionality and older-plugin rejection of new enum values.

Also complete the currently partial protocol error table while touching this public surface. At a
minimum, document `INVALID_ARGUMENT`, `NO_CHANGE`, `OPERATIONS_OVERLAP`, `TARGET_CHANGED`,
`BOUNDARY_CHANGED`, `AMBIGUOUS_RELOCATION`, `RANGE_NOT_FULLY_ISSUED`, `REF_NOT_ISSUED`,
`UNSUPPORTED_FILE`, and both race outcomes used by the feature.

Do not edit generated `dist/` or `coverage/`. Release notes and versions continue through Release
Please; do not manually publish, retag, or introduce token-based npm release credentials.

## Implementation Sequence

The feature may be developed in reviewable commits or pull requests, but no partial public protocol
should be released. Full strict, unique, and batch behavior must pass before the enum is shipped.

### Phase 0: Freeze Contract And Evidence

- [x] Approve this protocol contract and examples.
- [x] Freeze intrinsic move errors, adjacent-span behavior, provenance error precedence, compatibility
  modes, and individual-move `NO_CHANGE` semantics in fixtures.
- [x] Add schema, pure-oracle, topology, EOL, and multi-anchor regression tests.
- [x] Add deterministic current-protocol payload measurements.
- [x] Record the concrete failure or measured opportunity required by `CONTRIBUTING.md`.

### Phase 1: Pure Effect And Rebase Model

- [x] Add operation types and base validation.
- [x] Add read/write footprints and move corridors.
- [x] Add canonical shared-budget anchor mapping and memoization.
- [x] Add topology preservation and mapped conflict validation.
- [x] Pass pure exhaustive, property, and rebase tests without plugin/schema exposure.

### Phase 2: Rendering And Bounded Planning

- [x] Add copy insertion rendering from retained logical text.
- [x] Add EOL-slot-preserving move corridor rendering.
- [x] Add exact line/UTF-8 projection before derived materialization.
- [x] Preserve existing operation output fixtures byte-for-byte.
- [x] Pass no-op, mixed-EOL, EOF, BOM, Unicode, batch, and amplification tests.

### Phase 3: Provider And Plugin Integration

- [x] Extend the flat provider enum and make `lines` optional at schema level.
- [x] Add runtime field combinations and payload accounting.
- [x] Add source/destination and full move-corridor issued-provenance checks plus prefix-guard
  separation.
- [x] Add strict/unique successful plugin paths and all pre-permission failures.
- [x] Extend the packed OpenCode smoke for payload-free operations.

### Phase 4: Documentation And Deterministic Evidence

- [x] Update every public protocol and architecture document listed above.
- [x] Add compatibility fixtures and migration notes.
- [x] Measure provider schema and representative call wire sizes.
- [x] Extend deterministic benchmarks without comparator fallthrough.
- [x] Publish only a new immutable benchmark result.

### Phase 5: Model Evaluation And Ship Decision

- [x] Add the separately versioned transfer task set.
- [x] Complete dry-run and model-free preflight.
- [x] Preserve a separate approval gate for paid or authenticated execution; no paid call was made.
- [x] Record that no model outcome metrics exist yet rather than implying unmeasured results.
- [x] Evaluate `copy_range` and `move_range` independently: both retain deterministic payload
  opportunity, while move's far-corridor read cost is recorded separately.

## Verification Commands

During development, use focused suites first:

```sh
bun test tests/edits.test.ts tests/rebase.test.ts
bun test tests/plugin.test.ts tests/snapshots-render.test.ts tests/filesystem.test.ts
```

Before review:

```sh
bun run bench
bun run format
bun run ci
bun run pack:check
```

Run `bun run bench:model` only as a dry run unless the explicit execution and cost gates are met.
The deterministic benchmark result path must be new and write-once.

## Acceptance Gates

The protocol is ready to ship only when all of the following are true:

- [x] No existing valid operation changes result bytes or accepted/rejected behavior unexpectedly.
- [x] Transfer-free compatibility and transfer-batch topology modes match their frozen fixtures.
- [x] Strict copy/move and full exact-unique transfer-anchor behavior are implemented.
- [x] Non-conflicting mixed and multi-transfer batches are operation-order invariant.
- [x] Every base and mapped conflict class has a deterministic rejection test.
- [x] Exhaustive small-state and fixed-seed reference-oracle tests have zero mismatches.
- [x] BOM, LF, CRLF, lone CR, mixed EOL, and final-newline golden tests pass byte-for-byte.
- [x] Every copy source/destination and every complete move corridor/destination requires delivered
  issued provenance.
- [x] Copy amplification and shared relocation work reject before unbounded materialization.
- [x] Invalid, stale, ambiguous, over-limit, denied, and raced operations never partially mutate.
- [x] Permission covers exactly the one immutable result that publication attempts.
- [x] Provider-schema, packed OpenCode, build, coverage, and tarball smoke checks pass.
- [x] Protocol, architecture, threat, research, benchmark, and migration documents agree.
- [x] Before/after wire-size evidence and the concrete opportunity are published.
- [x] Any future model claim remains separately approved, versioned, and supported by retained raw
  evidence; no such claim is made here.

Failure of a safety gate blocks release regardless of model success or token savings.
