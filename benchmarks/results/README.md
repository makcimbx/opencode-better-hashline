# Results

Retained JSON files are immutable, reviewable benchmark records. Superseded intermediate records remain available in Git history. Local timing experiments belong in `local/`; paid model traces belong in `model/` and are ignored by Git.

| Result | Description |
| --- | --- |
| `2026-07-18-windows-x64.json` | Initial 15-scenario deterministic corpus, static output sizes, and core microbenchmarks on Bun 1.3.14 |
| `2026-07-19-windows-x64.json` | Expanded 21-scenario corpus with relocation regressions, rendering wire-size evidence, static output sizes, and core microbenchmarks on Bun 1.3.14 |
| `2026-07-19-transfer-windows-x64.json` | Expanded 28-scenario transfer corpus with raw-schema fixture, transfer-call, move-corridor, rendering, static-size, and core timing evidence on Bun 1.3.14 |
| `2026-07-21-native-alias-pilot-v7.json` | Privacy-safe successful pilot summary: 48/48 sessions passed across Luna/Sol and both paired surfaces; maintainer approved an opt-in experimental release |
| `2026-07-22-file-lifecycle-windows-x64.json` | Schema-v6 model-free corpus with lifecycle raw-schema and compact delete/move call-wire fixtures on Bun 1.3.14 |
| `2026-07-22-edit-protocol-ux-windows-x64.json` | Schema-v7 model-free corpus with composed-move acceptance, edit/write raw-schema sizes, and readback/parent-create call-wire fixtures on Bun 1.3.14 |
| `2026-07-23-default-simplification-r2-windows-x64.json` | Schema-v8 model-free corpus with unchanged safety classifications and wire evidence for inferred readback, empty-file newline, and parent-creation defaults on Bun 1.3.14 |
| `2026-07-23-operation-aware-rebase-default-windows-x64.json` | Schema-v9 model-free corpus adding the omitted incremental-rebase adapter and updated edit-schema wire evidence on Bun 1.3.14; strict-only defaults are covered by runtime tests |
| `2026-07-24-coverage-readback-ux-windows-x64.json` | Schema-v10 model-free corpus retaining the unchanged 29-case classifications and adding cumulative-coverage-header and explicit `replace_file`-readback wire fixtures on Bun 1.3.14 |

The schema-v10 record is the current write-once retained mechanical textual protocol evidence. It
preserves the schema-v9 29-case classifications and adds cumulative-coverage-header and explicit
`replace_file`-readback wire fixtures. Schema-v5 through schema-v9 and pilot-v7 remain immutable.
None of these records is semantic, paid, or model-quality evidence.

See [docs/benchmarks.md](../../docs/benchmarks.md) for interpretation and claim limits.
