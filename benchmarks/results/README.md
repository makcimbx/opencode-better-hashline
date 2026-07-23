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

The schema-v8 record is mechanical protocol evidence, not paid or model-quality evidence. The
schema-v5, schema-v6, schema-v7, and pilot-v7 records above remain immutable.

See [docs/benchmarks.md](../../docs/benchmarks.md) for interpretation and claim limits.
