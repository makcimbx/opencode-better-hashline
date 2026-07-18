import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runDeterministicSuite,
  runMicroSuite,
  runRenderingWireSuite,
  runStaticSizeSuite,
} from "./suite.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function commandOutput(command: string[]): string | undefined {
  const result = Bun.spawnSync(command, { stderr: "ignore", stdout: "pipe" });
  return result.success ? result.stdout.toString().trim() : undefined;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const repository = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
  version: string;
};
const sourceCommit = commandOutput(["git", "rev-parse", "HEAD"]);
const gitStatus = commandOutput(["git", "status", "--porcelain", "--untracked-files=all"]);
const implementationSources = await Promise.all(
  [
    "benchmarks/run.ts",
    "benchmarks/suite.ts",
    "src/edits.ts",
    "src/errors.ts",
    "src/rebase.ts",
    "src/render.ts",
    "src/snapshots.ts",
    "src/text.ts",
  ].map(async (path) => [path, await readFile(resolve(repository, path), "utf8")]),
);

const deterministic = runDeterministicSuite();
const staticSize = runStaticSizeSuite();
const renderingWireSize = runRenderingWireSuite();
const micro = runMicroSuite();
if (renderingWireSize.legacyIssued || !renderingWireSize.currentIssued) {
  throw new Error("Long-line rendering wire-size assertions failed.");
}
const summary = new Map(deterministic.summary.map((row) => [row.adapter, row]));
if (
  summary.get("better-hashline-strict")?.unsafe_accept !== 0 ||
  summary.get("better-hashline-unique")?.unsafe_accept !== 0 ||
  summary.get("better-hashline-unique")?.false_reject !== 0 ||
  (summary.get("endpoint-hash-8")?.unsafe_accept ?? 0) < 1 ||
  (summary.get("endpoint-hash-16")?.unsafe_accept ?? 0) < 1
) {
  throw new Error("Deterministic protocol safety assertions failed.");
}
const result = {
  schemaVersion: 4,
  generatedAt: new Date().toISOString(),
  provenance: {
    packageVersion: packageJson.version,
    sourceCommit: sourceCommit ?? null,
    sourceDirty: gitStatus === undefined ? null : gitStatus.length > 0,
    sourceStatusSha256: gitStatus === undefined ? null : digest(gitStatus),
    lockfileSha256: digest(await readFile(resolve(repository, "bun.lock"))),
    corpusSha256: digest(JSON.stringify(deterministic.corpus)),
    implementationSha256: digest(JSON.stringify(implementationSources)),
    command: ["bun", "run", "bench", ...process.argv.slice(2)],
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    cpu: process.env.PROCESSOR_IDENTIFIER ?? "unreported",
  },
  methodology: {
    deterministic:
      "In-memory protocol mechanics only; no model, OpenCode baseline, or semantic-code claim.",
    staticSize: "Exact UTF-8 bytes for one generated 1,000-line fixture; not token estimates.",
    renderingWireSize:
      "Exact UTF-8 bytes before and after byte-budget issuance for one generated long-line fixture.",
    micro:
      "Five warmups, 100 measured runs below 10k lines and 30 otherwise; wall-clock timings are non-gating.",
  },
  deterministic,
  staticSize,
  renderingWireSize,
  micro,
};

console.log("\nDeterministic adversarial corpus\n");
console.table(deterministic.summary);
console.log("\nStatic model-visible size\n");
console.table(staticSize);
console.log("\nLong-line rendering wire-size change\n");
console.table([renderingWireSize]);
console.log("\nCore microbenchmarks (milliseconds)\n");
console.table(
  micro.map(({ lineCount, bytes, sha256, decode, strictEditPlan }) => ({
    lines: lineCount,
    bytes,
    sha256Median: sha256.medianMs,
    decodeMedian: decode.medianMs,
    editMedian: strictEditPlan.medianMs,
    editP95: strictEditPlan.p95Ms,
  })),
);

const output = argument("output");
if (output) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  try {
    await access(path);
    if (!process.argv.includes("--force")) {
      throw new Error(
        `Refusing to overwrite benchmark evidence: ${path}. Pass --force explicitly.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nWrote raw results to ${path}`);
}
