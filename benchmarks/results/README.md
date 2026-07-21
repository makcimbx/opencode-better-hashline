# Results

Committed JSON files are immutable, reviewable benchmark records. Local timing experiments belong in `local/`; paid model traces belong in `model/` and are ignored by Git.

| Result | Description |
| --- | --- |
| `2026-07-18-windows-x64.json` | Initial 15-scenario deterministic corpus, static output sizes, and core microbenchmarks on Bun 1.3.14 |
| `2026-07-19-windows-x64.json` | Expanded 21-scenario corpus with relocation regressions, rendering wire-size evidence, static output sizes, and core microbenchmarks on Bun 1.3.14 |
| `2026-07-19-transfer-windows-x64.json` | Expanded 28-scenario transfer corpus with provider-schema, transfer-call, move-corridor, rendering, static-size, and core timing evidence on Bun 1.3.14 |
| `2026-07-20-native-alias-pilot-v1-incident.json` | Sanitized no-go record for the failed-closed pilot v1 harness incident; not release or model-comparison evidence |
| `2026-07-21-native-alias-pilot-v3-incident.json` | Sanitized no-go record for the consumed pilot v3 runtime-correlation incident; not release or model-comparison evidence |
| `2026-07-21-native-alias-pilot-v4-incident.json` | Sanitized no-go record for the consumed pilot v4 baseline-ledger oracle incident; not release or model-comparison evidence |

See [docs/benchmarks.md](../../docs/benchmarks.md) for interpretation and claim limits.
