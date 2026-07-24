import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  hashlineEditArgumentsSchema,
  hashlineEditDescription,
  hashlineWriteArgumentsSchema,
} from "../src/plugin.js";
import {
  runCoverageHeaderWireSuite,
  runDeterministicSuite,
  runEditProtocolUxCallWireSuite,
  runFileLifecycleCallWireSuite,
  runManagedLspOutputWireSuite,
  runMicroSuite,
  runMoveCorridorWireSuite,
  runRenderingWireSuite,
  runReplaceFileReadbackCallWireSuite,
  runStaticSizeSuite,
  runTransferCallWireSuite,
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

type JsonSchemaNode = {
  enum?: string[] | undefined;
  description?: string | undefined;
  items?: JsonSchemaNode | undefined;
  properties?: Record<string, JsonSchemaNode> | undefined;
  required?: string[] | undefined;
  type?: string | undefined;
};

function rawEditSchemaFixtureWireSize(): {
  scenario: string;
  legacyBytes: number;
  currentBytes: number;
  deltaBytes: number;
  deltaPercent: number;
} {
  const syntheticBaselineDescription =
    'Apply a validation-atomic line edit to an exact hashline_read snapshot. Deletion is lines: []; a blank line is lines: [""]. Omitted rebase uses unique for relocation-capable text batches and none for strict-only operations; unique only relocates unchanged, unambiguous text and never uses fuzzy matching.';
  const currentParameters = z.toJSONSchema(hashlineEditArgumentsSchema);
  const baselineParameters = structuredClone(currentParameters) as JsonSchemaNode;
  const operation = baselineParameters.properties?.operations?.items;
  const discriminator = operation?.properties?.op;
  if (!operation || !discriminator) {
    throw new Error("Unexpected hashline_edit raw JSON Schema fixture shape.");
  }
  discriminator.enum = ["replace", "insert", "replace_file"];
  operation.required = ["op", "lines"];

  const encoder = new TextEncoder();
  const legacyBytes = encoder.encode(
    JSON.stringify({
      description: syntheticBaselineDescription,
      parameters: baselineParameters,
    }),
  ).byteLength;
  const currentBytes = encoder.encode(
    JSON.stringify({ description: hashlineEditDescription, parameters: currentParameters }),
  ).byteLength;
  return {
    scenario: "hashline_edit description plus raw JSON Schema fixture",
    legacyBytes,
    currentBytes,
    deltaBytes: currentBytes - legacyBytes,
    deltaPercent: Number((((currentBytes - legacyBytes) / legacyBytes) * 100).toFixed(2)),
  };
}

function rawWriteSchemaFixtureWireSize(): {
  scenario: string;
  legacyBytes: number;
  currentBytes: number;
  deltaBytes: number;
  deltaPercent: number;
} {
  const currentParameters = z.toJSONSchema(hashlineWriteArgumentsSchema);
  const baselineParameters = structuredClone(currentParameters) as JsonSchemaNode;
  if (!baselineParameters.properties) {
    throw new Error("Unexpected hashline_write raw JSON Schema fixture shape.");
  }
  baselineParameters.properties.createParents = {
    description:
      "Default false: a missing parent fails with PATH_NOT_FOUND. true creates up to 64 missing parents through one fixed, approved no-rollback plan. After publication starts, an error can leave the target file and created directories present; inspect them before retrying.",
    type: "boolean",
  };
  const encoder = new TextEncoder();
  const legacyBytes = encoder.encode(JSON.stringify(baselineParameters)).byteLength;
  const currentBytes = encoder.encode(JSON.stringify(currentParameters)).byteLength;
  return {
    scenario: "hashline_write raw JSON Schema fixture",
    legacyBytes,
    currentBytes,
    deltaBytes: currentBytes - legacyBytes,
    deltaPercent: Number((((currentBytes - legacyBytes) / legacyBytes) * 100).toFixed(2)),
  };
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
    "src/filesystem.ts",
    "src/plugin.ts",
    "src/lsp-client.ts",
    "src/lsp-diagnostics.ts",
    "src/lsp-jsonrpc.ts",
    "src/lsp-manager.ts",
    "src/lsp-output.ts",
    "src/options.ts",
    "src/presentation.ts",
    "src/rebase.ts",
    "src/session-protocol.ts",
    "src/render.ts",
    "src/snapshots.ts",
    "src/text.ts",
  ].map(async (path) => [path, await readFile(resolve(repository, path), "utf8")]),
);

const deterministic = runDeterministicSuite();
const staticSize = runStaticSizeSuite();
const renderingWireSize = runRenderingWireSuite();
const coverageHeaderWireSize = runCoverageHeaderWireSuite();
const operationSchemaWireSize = rawEditSchemaFixtureWireSize();
const writeOperationSchemaWireSize = rawWriteSchemaFixtureWireSize();
const fileLifecycleCallWireSize = runFileLifecycleCallWireSuite();
const editProtocolUxCallWireSize = runEditProtocolUxCallWireSuite();
const replaceFileReadbackCallWireSize = runReplaceFileReadbackCallWireSuite();
const transferCallWireSize = runTransferCallWireSuite();
const moveCorridorWireSize = runMoveCorridorWireSuite();
const managedLspOutputWireSize = runManagedLspOutputWireSuite();
const micro = runMicroSuite();
if (renderingWireSize.legacyIssued || !renderingWireSize.currentIssued) {
  throw new Error("Long-line rendering wire-size assertions failed.");
}
const coverageRows = new Map(coverageHeaderWireSize.map((row) => [row.scenario, row]));
const completeCoverage = coverageRows.get("complete single page");
const partialCoverage = coverageRows.get("initial partial page");
const cumulativeCoverage = coverageRows.get("cumulative completion page");
if (
  completeCoverage?.coverage !== "complete" ||
  completeCoverage.pagePartial ||
  completeCoverage.legacyHeaderBytes !== 71 ||
  completeCoverage.currentHeaderBytes !== 89 ||
  completeCoverage.overheadBytes !== 18 ||
  partialCoverage?.coverage !== "partial" ||
  !partialCoverage.pagePartial ||
  partialCoverage.legacyHeaderBytes !== 84 ||
  partialCoverage.currentHeaderBytes !== 101 ||
  partialCoverage.overheadBytes !== 17 ||
  cumulativeCoverage?.coverage !== "complete" ||
  !cumulativeCoverage.pagePartial ||
  cumulativeCoverage.priorIssuedLines !== 2 ||
  cumulativeCoverage.pageIssuedLines !== 1 ||
  cumulativeCoverage.legacyHeaderBytes !== 84 ||
  cumulativeCoverage.currentHeaderBytes !== 102 ||
  cumulativeCoverage.overheadBytes !== 18
) {
  throw new Error("Coverage-header wire-size assertions failed.");
}
if (
  replaceFileReadbackCallWireSize.omittedRequestsReadback ||
  !replaceFileReadbackCallWireSize.explicitRequestsReadback ||
  replaceFileReadbackCallWireSize.omittedEditBytes !== 149 ||
  replaceFileReadbackCallWireSize.explicitReadbackEditBytes !== 165 ||
  replaceFileReadbackCallWireSize.explicitOptInCostBytes !== 16 ||
  replaceFileReadbackCallWireSize.standaloneReadCallBytes !== 29 ||
  replaceFileReadbackCallWireSize.separateCallInputBytes !== 178 ||
  replaceFileReadbackCallWireSize.attachedSuccessorCallInputBytes !== 165 ||
  replaceFileReadbackCallWireSize.attachedSuccessorSavingsBytes !== 13
) {
  throw new Error("replace_file readback call wire-size assertions failed.");
}
const expectedManagedLspOutputWireSize = [
  {
    scenario: "clean byte-identical output",
    hostMaxBytes: 4096,
    hostMaxLines: 100,
    legacyLimitBytes: 1024,
    legacyLimitLines: null,
    legacyUtf8Bytes: 223,
    outputUtf8Bytes: 223,
    outputLines: 7,
    outputSha256: "2dbe7d6e629b164c6a0f23d6539670eb02ade5207f8d4881760e789282829535",
    legacyPreserved: true,
    diagnosticsPresent: false,
    diagnosticsTruncated: false,
    warningPresent: false,
  },
  {
    scenario: "error with unchanged legacy readback",
    hostMaxBytes: 4096,
    hostMaxLines: 100,
    legacyLimitBytes: 1024,
    legacyLimitLines: 99,
    legacyUtf8Bytes: 223,
    outputUtf8Bytes: 357,
    outputLines: 9,
    outputSha256: "87ae177493ab5da0e4e697df024bfce1798edea6bcba56e01337e300fe16de53",
    legacyPreserved: true,
    diagnosticsPresent: true,
    diagnosticsTruncated: false,
    warningPresent: false,
  },
  {
    scenario: "byte-headroom truncation",
    hostMaxBytes: 1400,
    hostMaxLines: 100,
    legacyLimitBytes: 1024,
    legacyLimitLines: 99,
    legacyUtf8Bytes: 1024,
    outputUtf8Bytes: 1252,
    outputLines: 7,
    outputSha256: "b7493e3e2d446847035fa9f1b227bdaa45649b5c25c87c7613794537724ae101",
    legacyPreserved: true,
    diagnosticsPresent: true,
    diagnosticsTruncated: true,
    warningPresent: false,
  },
  {
    scenario: "line-headroom truncation",
    hostMaxBytes: 4096,
    hostMaxLines: 8,
    legacyLimitBytes: 1024,
    legacyLimitLines: 7,
    legacyUtf8Bytes: 223,
    outputUtf8Bytes: 223,
    outputLines: 7,
    outputSha256: "2dbe7d6e629b164c6a0f23d6539670eb02ade5207f8d4881760e789282829535",
    legacyPreserved: true,
    diagnosticsPresent: false,
    diagnosticsTruncated: false,
    warningPresent: false,
  },
  {
    scenario: "mandatory warning",
    hostMaxBytes: 900,
    hostMaxLines: 100,
    legacyLimitBytes: 550,
    legacyLimitLines: 98,
    legacyUtf8Bytes: 1024,
    outputUtf8Bytes: 772,
    outputLines: 6,
    outputSha256: "5c7e74af1ec7757fbeab6809683d2600bed7633b3c9bfa24d2d38498ef65555a",
    legacyPreserved: false,
    diagnosticsPresent: false,
    diagnosticsTruncated: false,
    warningPresent: true,
  },
  {
    scenario: "drift warning",
    hostMaxBytes: 4096,
    hostMaxLines: 100,
    legacyLimitBytes: 1024,
    legacyLimitLines: 98,
    legacyUtf8Bytes: 223,
    outputUtf8Bytes: 446,
    outputLines: 8,
    outputSha256: "76e655682c3fc1522ef165cb4a8ee45ccdfbfc5f6fd6e771fbe48d429f526b98",
    legacyPreserved: true,
    diagnosticsPresent: false,
    diagnosticsTruncated: false,
    warningPresent: true,
  },
  {
    scenario: "insufficient host budget",
    hostMaxBytes: 128,
    hostMaxLines: 1,
    legacyLimitBytes: 0,
    legacyLimitLines: 0,
    legacyUtf8Bytes: 223,
    outputUtf8Bytes: 0,
    outputLines: 0,
    outputSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    legacyPreserved: false,
    diagnosticsPresent: false,
    diagnosticsTruncated: false,
    warningPresent: false,
  },
];
if (JSON.stringify(managedLspOutputWireSize) !== JSON.stringify(expectedManagedLspOutputWireSize)) {
  throw new Error("Managed LSP production-output wire-size assertions failed.");
}
const summary = new Map(deterministic.summary.map((row) => [row.adapter, row]));
if (
  summary.get("better-hashline-strict")?.unsafe_accept !== 0 ||
  summary.get("better-hashline-unique")?.unsafe_accept !== 0 ||
  summary.get("better-hashline-unique")?.false_reject !== 0 ||
  summary.get("better-hashline-default")?.exact_apply !== 11 ||
  summary.get("better-hashline-default")?.safe_reject !== 18 ||
  summary.get("better-hashline-default")?.false_reject !== 0 ||
  summary.get("better-hashline-default")?.unsafe_accept !== 0 ||
  (summary.get("endpoint-hash-8")?.unsafe_accept ?? 0) < 1 ||
  (summary.get("endpoint-hash-16")?.unsafe_accept ?? 0) < 1
) {
  throw new Error("Deterministic protocol safety assertions failed.");
}
const result = {
  schemaVersion: 11,
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
      "In-memory protocol mechanics only; the omitted adapter passes no rebase property and exercises the incremental branch of the shared runtime policy resolver. Strict-only defaults are covered by runtime tests, not this corpus. No model, OpenCode baseline, or semantic-code claim.",
    staticSize: "Exact UTF-8 bytes for one generated 1,000-line fixture; not token estimates.",
    renderingWireSize:
      "Exact UTF-8 bytes for one synthetic preview-era long-line output without a coverage marker versus the current issued output under a 4,096-byte budget.",
    coverageHeaderWireSize:
      "Exact UTF-8 header bytes for the former header without coverage and the current coverage=partial|complete header across complete, partial, and cumulatively completing pages.",
    operationSchemaWireSize:
      "Exact compact UTF-8 JSON bytes for the hashline_edit description plus raw z.toJSONSchema fixture, compared with a synthetic baseline derived from that current schema; not a provider projection or token estimate.",
    writeOperationSchemaWireSize:
      "Exact compact UTF-8 JSON bytes for the hashline_write raw z.toJSONSchema fixture and its reconstructed pre-change baseline with optional createParents; not a provider projection or token estimate.",
    fileLifecycleCallWireSize:
      "Exact compact UTF-8 JSON bytes for valid Better Hashline lifecycle calls and equivalent native apply_patch calls; no semantic or safety advantage is inferred from size.",
    editProtocolUxCallWireSize:
      "Exact compact UTF-8 JSON bytes for legacy explicit controls versus inferred readback, empty-file, and parent-creation calls.",
    replaceFileReadbackCallWireSize:
      "Exact compact UTF-8 request bytes for replace_file with omitted readback versus explicit readback:true, plus a standalone hashline_read request. Omission requests no readback; the reported call-input savings apply only when explicit readback attaches a usable successor page. Response bytes and attachment availability are not measured.",
    transferCallWireSize:
      "Exact compact UTF-8 JSON bytes for copy/move calls versus equivalent model-supplied insert/replace payloads.",
    moveCorridorWireSize:
      "Exact UTF-8 hashline_read output bytes required to issue fixed near and far move corridors under the default page and output limits.",
    managedLspOutputWireSize:
      "Exact UTF-8 bytes, line counts, and output digests from the shared production lspLegacyLimits and buildLspOutput composition for clean output, Error diagnostics, byte and line headroom, mandatory manager and drift warnings, and an insufficient host envelope. No language server or model is invoked.",
    micro:
      "Five warmups, 100 measured runs below 10k lines and 30 otherwise; wall-clock timings are non-gating.",
  },
  deterministic,
  staticSize,
  renderingWireSize,
  coverageHeaderWireSize,
  operationSchemaWireSize,
  writeOperationSchemaWireSize,
  fileLifecycleCallWireSize,
  editProtocolUxCallWireSize,
  replaceFileReadbackCallWireSize,
  transferCallWireSize,
  moveCorridorWireSize,
  managedLspOutputWireSize,
  micro,
};

console.log("\nDeterministic adversarial corpus\n");
console.table(deterministic.summary);
console.log("\nStatic model-visible size\n");
console.table(staticSize);
console.log("\nLong-line rendering wire-size change\n");
console.table([renderingWireSize]);
console.log("\nCoverage-header wire-size change\n");
console.table(coverageHeaderWireSize);
console.log("\nRaw edit-schema fixture wire-size change\n");
console.table([operationSchemaWireSize]);
console.log("\nRaw write-schema fixture wire-size change\n");
console.table([writeOperationSchemaWireSize]);
console.log("\nFile-lifecycle call wire size\n");
console.table(fileLifecycleCallWireSize);
console.log("\nEdit-protocol UX call wire size\n");
console.table(editProtocolUxCallWireSize);
console.log("\nreplace_file readback call wire size\n");
console.table([replaceFileReadbackCallWireSize]);
console.log("\nTransfer call wire-size change\n");
console.table(transferCallWireSize);
console.log("\nMove-corridor read wire size\n");
console.table(moveCorridorWireSize);
console.log("\nManaged LSP production output wire size\n");
console.table(managedLspOutputWireSize);
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
