# Results

Committed JSON files are immutable, reviewable benchmark records. Local timing experiments belong in `local/`; paid model traces belong in `model/` and are ignored by Git.

| Result | Description |
| --- | --- |
| `2026-07-18-windows-x64.json` | Initial 15-scenario deterministic corpus, static output sizes, and core microbenchmarks on Bun 1.3.14 |
| `2026-07-19-windows-x64.json` | Expanded 21-scenario corpus with relocation regressions, rendering wire-size evidence, static output sizes, and core microbenchmarks on Bun 1.3.14 |

See [docs/benchmarks.md](../../docs/benchmarks.md) for interpretation and claim limits.
