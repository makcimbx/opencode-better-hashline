import { createHash } from "node:crypto";
import { type EditOperation, planEdits } from "../src/edits.js";
import { renderSnapshotPage } from "../src/render.js";
import { SnapshotStore, sha256 } from "../src/snapshots.js";
import { decodeTextDocument, type TextDocument } from "../src/text.js";

const encoder = new TextEncoder();

export type Scenario = {
  id: string;
  category: string;
  base: string;
  current: string;
  operations: EditOperation[];
  expectedText?: string;
};

export type AdapterOutcome = { accepted: true; text: string } | { accepted: false; error: string };

export type Adapter = {
  id: string;
  description: string;
  run(scenario: Scenario): AdapterOutcome;
};

type Classification = "exact_apply" | "false_reject" | "safe_reject" | "unsafe_accept";

function document(text: string): TextDocument {
  return decodeTextDocument(encoder.encode(text));
}

function lineToken(line: { text: string; eol: string }): string {
  return JSON.stringify([line.text, line.eol]);
}

function shortHash(value: string, bits: 8 | 16): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, bits / 4);
}

function attempt(operation: () => string): AdapterOutcome {
  try {
    return { accepted: true, text: operation() };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function planScenario(scenario: Scenario, rebase: "none" | "unique"): string {
  return planEdits({
    base: document(scenario.base),
    current: document(scenario.current),
    operations: scenario.operations,
    rebase,
    maxContextLines: 4,
  }).text;
}

function findSequences(haystack: readonly string[], needle: readonly string[]): number[] {
  if (needle.length === 0) return [];
  const found: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((value, offset) => haystack[start + offset] === value)) found.push(start);
  }
  return found;
}

function mapExactOperations(scenario: Scenario): EditOperation[] {
  const base = document(scenario.base);
  const current = document(scenario.current);
  const baseTokens = base.lines.map(lineToken);
  const currentTokens = current.lines.map(lineToken);
  return scenario.operations.map((operation) => {
    if (operation.op === "replace_file") {
      if (scenario.base !== scenario.current) throw new Error("stale file");
      return operation;
    }
    if (operation.op === "replace") {
      const target = baseTokens.slice(operation.startLine - 1, operation.endLine);
      const matches = findSequences(currentTokens, target);
      if (matches.length !== 1) throw new Error("old text is missing or ambiguous");
      const startLine = (matches[0] ?? 0) + 1;
      return { ...operation, startLine, endLine: startLine + target.length - 1 };
    }

    const position = operation.afterLine;
    if (position === 0) {
      if (baseTokens[0] !== currentTokens[0]) throw new Error("BOF boundary changed");
      return operation;
    }
    if (position === baseTokens.length) {
      if (baseTokens.at(-1) !== currentTokens.at(-1)) throw new Error("EOF boundary changed");
      return { ...operation, afterLine: currentTokens.length };
    }
    const pair = baseTokens.slice(position - 1, position + 1);
    const matches = findSequences(currentTokens, pair);
    if (matches.length !== 1) throw new Error("insertion boundary is missing or ambiguous");
    return { ...operation, afterLine: (matches[0] ?? 0) + 1 };
  });
}

function validateEndpointHashes(scenario: Scenario, bits: 8 | 16): void {
  const base = document(scenario.base);
  const current = document(scenario.current);
  for (const operation of scenario.operations) {
    if (operation.op === "replace_file") {
      if (shortHash(scenario.base, bits) !== shortHash(scenario.current, bits)) {
        throw new Error("file hash mismatch");
      }
      continue;
    }
    if (operation.op === "replace") {
      const baseFirst = base.lines[operation.startLine - 1];
      const baseLast = base.lines[operation.endLine - 1];
      const currentFirst = current.lines[operation.startLine - 1];
      const currentLast = current.lines[operation.endLine - 1];
      if (!baseFirst || !baseLast || !currentFirst || !currentLast) {
        throw new Error("endpoint missing");
      }
      if (
        shortHash(lineToken(baseFirst), bits) !== shortHash(lineToken(currentFirst), bits) ||
        shortHash(lineToken(baseLast), bits) !== shortHash(lineToken(currentLast), bits)
      ) {
        throw new Error("endpoint hash mismatch");
      }
      continue;
    }

    const beforeBase = base.lines[operation.afterLine - 1];
    const afterBase = base.lines[operation.afterLine];
    const beforeCurrent = current.lines[operation.afterLine - 1];
    const afterCurrent = current.lines[operation.afterLine];
    for (const [left, right] of [
      [beforeBase, beforeCurrent],
      [afterBase, afterCurrent],
    ] as const) {
      if (!left && !right) continue;
      if (
        !left ||
        !right ||
        shortHash(lineToken(left), bits) !== shortHash(lineToken(right), bits)
      ) {
        throw new Error("boundary hash mismatch");
      }
    }
  }
}

function currentCoordinatePlan(scenario: Scenario): string {
  const current = document(scenario.current);
  return planEdits({
    base: current,
    current,
    operations: scenario.operations,
    rebase: "none",
    maxContextLines: 0,
  }).text;
}

function findCollision(bits: 8 | 16, requireWiderDifference: boolean): [string, string] {
  const seen = new Map<string, { value: string; wider: string }>();
  for (let index = 0; index < 1_000_000; index += 1) {
    const value = `collision-${bits}-${index}`;
    const token = lineToken({ text: value, eol: "\n" });
    const hash = shortHash(token, bits);
    const wider = shortHash(token, 16);
    const previous = seen.get(hash);
    if (
      previous &&
      previous.value !== value &&
      (!requireWiderDifference || previous.wider !== wider)
    ) {
      return [previous.value, value];
    }
    seen.set(hash, { value, wider });
  }
  throw new Error(`Could not generate a deterministic ${bits}-bit collision.`);
}

export function scenarios(): Scenario[] {
  const [collision8A, collision8B] = findCollision(8, true);
  const [collision16A, collision16B] = findCollision(16, false);
  return [
    {
      id: "exact-single-line",
      category: "exact",
      base: "one\ntwo\nthree\n",
      current: "one\ntwo\nthree\n",
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
      expectedText: "one\nTWO\nthree\n",
    },
    {
      id: "exact-batch",
      category: "exact",
      base: "one\ntwo\nthree",
      current: "one\ntwo\nthree",
      operations: [
        { op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] },
        { op: "insert", afterLine: 3, lines: ["four"] },
      ],
      expectedText: "ONE\ntwo\nthree\nfour",
    },
    {
      id: "stale-prefix-insertion",
      category: "relocation",
      base: "one\ntwo\nthree\n",
      current: "prefix\none\ntwo\nthree\n",
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
      expectedText: "prefix\none\nTWO\nthree\n",
    },
    {
      id: "stale-target-changed",
      category: "stale",
      base: "one\ntwo\nthree\n",
      current: "one\nchanged\nthree\n",
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
    },
    {
      id: "range-interior-changed",
      category: "stale",
      base: "start\ninside\nend\n",
      current: "start\nconcurrent\nend\n",
      operations: [{ op: "replace", startLine: 1, endLine: 3, lines: ["replacement"] }],
    },
    {
      id: "duplicate-target-with-context",
      category: "ambiguity",
      base: "left\ntarget\nright\nother\ntarget\nend\n",
      current: "prefix\nleft\ntarget\nright\nother\ntarget\nend\n",
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["changed"] }],
      expectedText: "prefix\nleft\nchanged\nright\nother\ntarget\nend\n",
    },
    {
      id: "concurrent-boundary-insertion",
      category: "boundary",
      base: "one\ntwo\nthree\n",
      current: "one\ntwo\nconcurrent\nthree\n",
      operations: [{ op: "insert", afterLine: 2, lines: ["ours"] }],
    },
    {
      id: "changed-target-eol",
      category: "encoding",
      base: "one\r\ntwo\r\n",
      current: "one\r\ntwo\n",
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
    },
    {
      id: "same-boundary-batch",
      category: "overlap",
      base: "one\ntwo\n",
      current: "one\ntwo\n",
      operations: [
        { op: "insert", afterLine: 1, lines: ["first"] },
        { op: "insert", afterLine: 1, lines: ["second"] },
      ],
    },
    {
      id: "bof-changed",
      category: "boundary",
      base: "one\ntwo\n",
      current: "concurrent\none\ntwo\n",
      operations: [{ op: "insert", afterLine: 0, lines: ["ours"] }],
    },
    {
      id: "eof-changed",
      category: "boundary",
      base: "one\ntwo\n",
      current: "one\ntwo\nconcurrent\n",
      operations: [{ op: "insert", afterLine: 2, lines: ["ours"] }],
    },
    {
      id: "short-hash-8-collision",
      category: "collision",
      base: `${collision8A}\n`,
      current: `${collision8B}\n`,
      operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["safe"] }],
    },
    {
      id: "short-hash-16-collision",
      category: "collision",
      base: `${collision16A}\n`,
      current: `${collision16B}\n`,
      operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["safe"] }],
    },
    {
      id: "unrelated-suffix-change",
      category: "relocation",
      base: "one\ntwo\nthree\n",
      current: "one\ntwo\nthree\nextra\n",
      operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
      expectedText: "ONE\ntwo\nthree\nextra\n",
    },
    {
      id: "empty-file-boundary-changed",
      category: "boundary",
      base: "",
      current: "concurrent",
      operations: [{ op: "insert", afterLine: 0, lines: ["ours"] }],
    },
  ];
}

export function adapters(): Adapter[] {
  return [
    {
      id: "better-hashline-strict",
      description: "Exact retained snapshot; stale files reject.",
      run: (scenario) => attempt(() => planScenario(scenario, "none")),
    },
    {
      id: "better-hashline-unique",
      description: "Exact snapshot plus explicit conservative unique relocation.",
      run: (scenario) => attempt(() => planScenario(scenario, "unique")),
    },
    {
      id: "exact-search-replace",
      description: "Unique exact old-text/boundary matching without fuzzy fallback.",
      run: (scenario) =>
        attempt(() => {
          const current = document(scenario.current);
          return planEdits({
            base: current,
            current,
            operations: mapExactOperations(scenario),
            rebase: "none",
            maxContextLines: 0,
          }).text;
        }),
    },
    {
      id: "line-number-only",
      description: "Original line numbers applied directly to the live file.",
      run: (scenario) => attempt(() => currentCoordinatePlan(scenario)),
    },
    ...([8, 16] as const).map(
      (bits): Adapter => ({
        id: `endpoint-hash-${bits}`,
        description: `${bits}-bit hashes validate range endpoints at original line numbers.`,
        run: (scenario) =>
          attempt(() => {
            validateEndpointHashes(scenario, bits);
            return currentCoordinatePlan(scenario);
          }),
      }),
    ),
  ];
}

function classify(scenario: Scenario, outcome: AdapterOutcome): Classification {
  if (scenario.expectedText === undefined)
    return outcome.accepted ? "unsafe_accept" : "safe_reject";
  if (!outcome.accepted) return "false_reject";
  return outcome.text === scenario.expectedText ? "exact_apply" : "unsafe_accept";
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function measure(operation: () => void, runs: number): { medianMs: number; p95Ms: number } {
  for (let index = 0; index < 5; index += 1) operation();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    medianMs: Number(percentile(samples, 0.5).toFixed(4)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(4)),
  };
}

export function runDeterministicSuite() {
  const corpus = scenarios();
  const protocolAdapters = adapters();
  const outcomes = protocolAdapters.flatMap((adapter) =>
    corpus.map((scenario) => {
      const outcome = adapter.run(scenario);
      return {
        adapter: adapter.id,
        scenario: scenario.id,
        category: scenario.category,
        classification: classify(scenario, outcome),
        accepted: outcome.accepted,
        error: outcome.accepted ? undefined : outcome.error,
      };
    }),
  );
  const summary = protocolAdapters.map((adapter) => {
    const rows = outcomes.filter((outcome) => outcome.adapter === adapter.id);
    const counts: Record<Classification, number> = {
      exact_apply: rows.filter(({ classification }) => classification === "exact_apply").length,
      safe_reject: rows.filter(({ classification }) => classification === "safe_reject").length,
      false_reject: rows.filter(({ classification }) => classification === "false_reject").length,
      unsafe_accept: rows.filter(({ classification }) => classification === "unsafe_accept").length,
    };
    return { adapter: adapter.id, description: adapter.description, ...counts };
  });
  return { corpus, outcomes, summary };
}

export function runStaticSizeSuite() {
  const lines = Array.from(
    { length: 1000 },
    (_, index) => `const value${index + 1} = ${index + 1};`,
  );
  const text = `${lines.join("\n")}\n`;
  const snapshot = new SnapshotStore({
    maxCacheBytes: 1024 * 1024,
    maxSnapshots: 2,
    maxSnapshotsPerPath: 2,
    maxSnapshotsPerSession: 2,
    snapshotTtlMs: 60_000,
  }).remember(
    { sessionId: "benchmark", worktree: "/benchmark" },
    "/benchmark/file.ts",
    document(text),
  );
  const formats = {
    native: lines.map((line, index) => `${index + 1}: ${line}`).join("\n"),
    betterHashline: renderSnapshotPage({
      snapshot,
      offset: 1,
      limit: 1000,
      maxOutputBytes: 1024 * 1024,
    }).output,
    endpointHash8: lines
      .map((line, index) => `${index + 1}#${shortHash(line, 8)}|${line}`)
      .join("\n"),
    endpointHash16: lines
      .map((line, index) => `${index + 1}#${shortHash(line, 16)}|${line}`)
      .join("\n"),
  };
  const nativeBytes = encoder.encode(formats.native).byteLength;
  return Object.entries(formats).map(([format, rendered]) => {
    const bytes = encoder.encode(rendered).byteLength;
    return {
      format,
      bytes,
      overheadBytes: bytes - nativeBytes,
      overheadPercent: Number((((bytes - nativeBytes) / nativeBytes) * 100).toFixed(2)),
    };
  });
}

export function runMicroSuite() {
  return [10, 100, 1000, 10_000, 20_000].map((lineCount) => {
    const text = `${Array.from(
      { length: lineCount },
      (_, index) => `const value${index} = "${String(index).padStart(8, "0")}";`,
    ).join("\n")}\n`;
    const bytes = encoder.encode(text);
    const base = decodeTextDocument(bytes);
    const operation: EditOperation = {
      op: "replace",
      startLine: Math.max(1, Math.floor(lineCount / 2)),
      endLine: Math.max(1, Math.floor(lineCount / 2)),
      lines: ["const changed = true;"],
    };
    const runs = lineCount >= 10_000 ? 30 : 100;
    return {
      lineCount,
      bytes: bytes.byteLength,
      sha256: measure(() => {
        sha256(bytes);
      }, runs),
      decode: measure(() => {
        decodeTextDocument(bytes);
      }, runs),
      strictEditPlan: measure(() => {
        planEdits({
          base,
          current: base,
          operations: [operation],
          rebase: "none",
          maxContextLines: 4,
        });
      }, runs),
    };
  });
}
