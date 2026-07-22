import { basename } from "node:path";
import { canonicalJson, jsonSha256 } from "../../src/presentation.js";
import {
  assertFullVerificationReport,
  type VerificationReport,
} from "../../src/verification-report.js";
import type { OracleFixtureReport } from "./oracle-fixture.js";
import type { EffectiveToolIdentities } from "./provenance.js";

export const NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION = 6;
export const NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS = [
  "built the local package",
  "created an npm tarball",
  "installed exact package dependencies with lifecycle scripts disabled and copyfile backend",
  "executed model-free OpenCode tool-registration probes",
  "executed the packed all credential-free verifier",
] as const;

export interface NativeAliasPreflightReceipt {
  schemaVersion: typeof NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION;
  generatedAt: string;
  modelCalls: 0;
  pilotId: string;
  sourceCommit: string;
  sourceDirty: boolean;
  sourceEligibleForApproval: boolean;
  sourceStatusSha256: string;
  runnerExecutableSha256: string;
  runnerExecutableRelativePath: string;
  scheduleManifestSha256: string;
  taskManifestSha256: string;
  adapterManifestSha256: string;
  taskSet: string;
  adapterSet: string;
  adapters: string[];
  taskCount: number;
  schedule: unknown[];
  limits: {
    timeoutMs: number;
    maxAgentSteps: number;
    requestedOutputTokenLimit: number;
    traceByteLimit: number;
    sessionLimit: number;
    requestLimit: number;
    totalCostStopThresholdUsd: number;
    perModelCostStopThresholdUsd: number;
  };
  artifact: {
    packageVersion: string;
    filename: string;
    relativePath: string;
    sha256: string;
    installedLockfileSha256: string;
    packageTreeSha256: string;
  };
  rootLockfileSha256: string;
  toolchain: EffectiveToolIdentities;
  toolchainSha256: string;
  platform: { name: string; arch: string; osRelease: string };
  sideEffects: string[];
  verifierReport: VerificationReport;
  oracleFixture: OracleFixtureReport;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Preflight receipt has an invalid ${label}.`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

const RECEIPT_KEYS = [
  "adapterManifestSha256",
  "adapterSet",
  "adapters",
  "artifact",
  "generatedAt",
  "limits",
  "modelCalls",
  "oracleFixture",
  "pilotId",
  "platform",
  "rootLockfileSha256",
  "runnerExecutableRelativePath",
  "runnerExecutableSha256",
  "schedule",
  "scheduleManifestSha256",
  "schemaVersion",
  "sideEffects",
  "sourceCommit",
  "sourceDirty",
  "sourceEligibleForApproval",
  "sourceStatusSha256",
  "taskCount",
  "taskManifestSha256",
  "taskSet",
  "toolchain",
  "toolchainSha256",
  "verifierReport",
] as const;
const ARTIFACT_KEYS = [
  "filename",
  "installedLockfileSha256",
  "packageTreeSha256",
  "packageVersion",
  "relativePath",
  "sha256",
] as const;
const PLATFORM_KEYS = ["arch", "name", "osRelease"] as const;

export function assertNativeAliasPreflightReceipt(
  value: unknown,
  expected: {
    sourceCommit: string;
    pilotId: string;
    sourceStatusSha256: string;
    runnerExecutableSha256: string;
    scheduleManifestSha256: string;
    taskManifestSha256: string;
    adapterManifestSha256: string;
    taskSet: string;
    adapterSet: string;
    adapters: readonly string[];
    taskCount: number;
    schedule: unknown[];
    limits: NativeAliasPreflightReceipt["limits"];
    artifact: NativeAliasPreflightReceipt["artifact"];
    rootLockfileSha256: string;
    toolchain: EffectiveToolIdentities;
    platform: NativeAliasPreflightReceipt["platform"];
  },
): asserts value is NativeAliasPreflightReceipt {
  const receipt = record(value);
  const limits = record(receipt?.limits);
  const artifact = record(receipt?.artifact);
  const platform = record(receipt?.platform);
  if (
    !receipt ||
    !exactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION ||
    !isCanonicalTimestamp(receipt.generatedAt) ||
    receipt.modelCalls !== 0 ||
    receipt.pilotId !== expected.pilotId ||
    receipt.sourceDirty !== false ||
    receipt.sourceEligibleForApproval !== true ||
    receipt.sourceCommit !== expected.sourceCommit ||
    receipt.sourceStatusSha256 !== expected.sourceStatusSha256 ||
    receipt.runnerExecutableSha256 !== expected.runnerExecutableSha256 ||
    receipt.runnerExecutableRelativePath !== "artifacts/model-runner.mjs" ||
    receipt.scheduleManifestSha256 !== expected.scheduleManifestSha256 ||
    receipt.taskManifestSha256 !== expected.taskManifestSha256 ||
    receipt.adapterManifestSha256 !== expected.adapterManifestSha256 ||
    receipt.taskSet !== expected.taskSet ||
    receipt.adapterSet !== expected.adapterSet ||
    canonicalJson(receipt.adapters) !== canonicalJson(expected.adapters) ||
    receipt.taskCount !== expected.taskCount ||
    canonicalJson(receipt.schedule) !== canonicalJson(expected.schedule) ||
    canonicalJson(limits) !== canonicalJson(expected.limits) ||
    receipt.rootLockfileSha256 !== expected.rootLockfileSha256 ||
    canonicalJson(receipt.toolchain) !== canonicalJson(expected.toolchain) ||
    receipt.toolchainSha256 !== jsonSha256(expected.toolchain) ||
    !platform ||
    !exactKeys(platform, PLATFORM_KEYS) ||
    canonicalJson(platform) !== canonicalJson(expected.platform) ||
    canonicalJson(receipt.sideEffects) !== canonicalJson(NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS)
  ) {
    throw new Error("Preflight receipt does not match the frozen native-alias proposal.");
  }
  sha256(receipt.runnerExecutableSha256, "runner SHA-256");
  sha256(receipt.scheduleManifestSha256, "schedule SHA-256");
  sha256(receipt.taskManifestSha256, "task SHA-256");
  sha256(receipt.adapterManifestSha256, "adapter SHA-256");
  sha256(receipt.sourceStatusSha256, "source-status SHA-256");
  sha256(receipt.rootLockfileSha256, "root lockfile SHA-256");
  sha256(receipt.toolchainSha256, "toolchain SHA-256");
  if (
    !artifact ||
    !exactKeys(artifact, ARTIFACT_KEYS) ||
    canonicalJson(artifact) !== canonicalJson(expected.artifact) ||
    typeof artifact.filename !== "string" ||
    basename(artifact.filename) !== artifact.filename ||
    artifact.relativePath !== `artifacts/${artifact.filename}`
  ) {
    throw new Error("Preflight receipt has invalid artifact identity.");
  }
  sha256(artifact.sha256, "artifact SHA-256");
  sha256(artifact.installedLockfileSha256, "installed lockfile SHA-256");
  sha256(artifact.packageTreeSha256, "installed package-tree SHA-256");
  assertFullVerificationReport(
    receipt.verifierReport as unknown as VerificationReport,
    expected.artifact.packageVersion,
    expected.toolchain.opencode.packageVersion,
  );
  if (
    canonicalJson(receipt.oracleFixture) !==
    canonicalJson({
      schemaVersion: 1,
      legacyDecision: "invalid",
      correctedDecision: "valid",
      correctedReason: "valid",
      outsideFixtureDecision: "invalid",
      forgedLocatorDecision: "invalid",
    } satisfies OracleFixtureReport)
  ) {
    throw new Error("Preflight receipt has invalid oracle-fixture evidence.");
  }
}
