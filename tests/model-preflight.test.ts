import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertNativeAliasPreflightReceipt,
  NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION,
  NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS,
  type NativeAliasPreflightReceipt,
} from "../benchmarks/model/preflight.js";
import type { EffectiveToolIdentities } from "../benchmarks/model/provenance.js";
import { canonicalJson, jsonSha256 } from "../src/presentation.js";

const hash = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const schedule = [{ index: 1, model: "provider/model", adapter: "better-hashline" }];
const limits = {
  timeoutMs: 300_000,
  maxAgentSteps: 12,
  requestedOutputTokenLimit: 2_048,
  traceByteLimit: 8_388_608,
  sessionLimit: 1,
  requestLimit: 12,
  totalCostStopThresholdUsd: 4,
  perModelCostStopThresholdUsd: 1,
};
const toolchain: EffectiveToolIdentities = {
  bun: {
    executable: { path: "/tools/bun", sha256: hash },
    version: "1.3.14",
    revision: "test-revision",
  },
  npm: {
    discoveryWrapper: { path: "/tools/npm", realPath: "/tools/npm", sha256: hash },
    node: { executable: { path: "/tools/node", sha256: hash }, version: "v24.0.0" },
    cli: {
      path: "/tools/npm-cli.js",
      sha256: hash,
      packageDirectory: "/tools/npm-package",
      packageVersion: "11.18.0",
      observedVersion: "11.18.0",
      packageTreeSha256: hash,
    },
    effectiveCommand: ["/tools/node", "/tools/npm-cli.js"],
  },
  opencode: {
    binary: { path: "/tools/opencode", sha256: hash },
    packageDirectory: "/tools/opencode-package",
    packageVersion: "1.18.3",
    observedVersion: "1.18.3",
    packageTreeSha256: hash,
  },
};
const artifact = {
  packageVersion: "0.2.1",
  filename: "opencode-better-hashline-0.2.1.tgz",
  relativePath: "artifacts/opencode-better-hashline-0.2.1.tgz",
  sha256: hash,
  installedLockfileSha256: hash,
  packageTreeSha256: hash,
};
const platform = { name: process.platform, arch: process.arch, osRelease: "test-os" };
const expected = {
  pilotId: "native-alias-pilot-v7",
  sourceCommit: "b".repeat(40),
  sourceStatusSha256: hash,
  runnerExecutableSha256: hash,
  scheduleManifestSha256: hash,
  taskManifestSha256: hash,
  adapterManifestSha256: hash,
  taskSet: "baseline-v1",
  adapterSet: "native-aliases-v1",
  adapters: ["better-hashline", "better-hashline-native-aliases"],
  taskCount: 12,
  schedule,
  limits,
  artifact,
  rootLockfileSha256: hash,
  toolchain,
  platform,
};
const caseReport = (
  route: "hashline" | "native-edit" | "native-apply-patch",
  editTool: "hashline_edit" | "edit" | "apply_patch",
  routing: boolean,
  permissions: boolean,
) => {
  const metadataSnapshot = canonicalJson([
    { state: { input: {}, status: "error" }, tool: editTool, type: "tool_use" },
    {
      state: { input: {}, metadata: {}, output: "read", status: "completed" },
      tool: "hashline_read",
      type: "tool_use",
    },
    {
      state: {
        input: {},
        metadata:
          route === "hashline" ? { operationCount: 1 } : { betterHashline: { surface: editTool } },
        output: "edit",
        status: "completed",
      },
      tool: editTool,
      type: "tool_use",
    },
  ]);
  const rendererSnapshot =
    route === "native-edit"
      ? "Renderer verified.\n\n> build · scripted\n\n⚙ hashline_read probe.txt\n\n← Edit probe.txt\nIndex: probe.txt\n===================================================================\n--- probe.txt\tbefore\n+++ probe.txt\tafter\n@@ -1,3 +1,3 @@\n alpha\n-DELTA\n+RENDER\n gamma"
      : route === "native-apply-patch"
        ? "Renderer verified.\n\n> build · gpt-5-scripted\n\n⚙ hashline_read probe.txt\n% Patch 1 file"
        : "Renderer verified.\n\n> build · scripted\n\n⚙ hashline_read probe.txt\n⚙ hashline_edit probe.txt";
  return {
    route,
    model: route === "native-apply-patch" ? "scripted/gpt-5-scripted" : "scripted/scripted",
    editTool,
    schemaSha256: "53887ee61c4554c8fe52320a8083a5546c148a578ce9d4f383b8b3e5fc51e0c3",
    ...(route === "hashline"
      ? {}
      : {
          protocolFingerprint: "1633511a6dea50f48730a565aaad23db54018b4125c4528de0c1a52e9365b971",
        }),
    finalBytesSha256: "8b1f3c90fab7f353b4a997497392fa025ea08f0b023c2f5f4ab9ec0993494293",
    providerRequests: route === "native-edit" ? 24 : route === "native-apply-patch" ? 21 : 17,
    malformedRejected: true as const,
    continuationVerified: true as const,
    forkVerified: true as const,
    exportVerified: true as const,
    reopenVerified: true as const,
    sanitizedExportVerified: true as const,
    terminalRendererVerified: true as const,
    modelRoutingVerified: routing,
    editPermissionMatrixVerified: permissions,
    benchmarkOracleVerified: true,
    retryAbortVerified: true,
    retryProviderRequests: route === "native-edit" ? 1 : 0,
    metadataSnapshotSha256: digest(metadataSnapshot),
    metadataSnapshot,
    rendererSnapshotSha256: digest(rendererSnapshot),
    rendererSnapshot,
  };
};
const receipt: NativeAliasPreflightReceipt = {
  schemaVersion: NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION,
  generatedAt: "2026-07-20T00:00:00.000Z",
  modelCalls: 0,
  pilotId: expected.pilotId,
  sourceCommit: expected.sourceCommit,
  sourceDirty: false,
  sourceEligibleForApproval: true,
  sourceStatusSha256: expected.sourceStatusSha256,
  runnerExecutableSha256: hash,
  runnerExecutableRelativePath: "artifacts/model-runner.mjs",
  scheduleManifestSha256: hash,
  taskManifestSha256: hash,
  adapterManifestSha256: hash,
  taskSet: expected.taskSet,
  adapterSet: expected.adapterSet,
  adapters: expected.adapters,
  taskCount: expected.taskCount,
  schedule,
  limits,
  sideEffects: [...NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS],
  artifact,
  rootLockfileSha256: hash,
  toolchain,
  toolchainSha256: jsonSha256(toolchain),
  platform,
  verifierReport: {
    ok: true,
    packageVersion: "0.2.1",
    hostVersion: "1.18.3",
    protocol: "native-aliases/v1",
    rollbackVerified: true,
    modelRoutingVerified: true,
    editPermissionMatrixVerified: true,
    benchmarkOracleVerified: true,
    retryAbortVerified: true,
    retryProviderRequests: 1,
    cases: [
      caseReport("native-edit", "edit", true, true),
      caseReport("native-apply-patch", "apply_patch", false, true),
      caseReport("hashline", "hashline_edit", false, false),
    ],
  },
  oracleFixture: {
    schemaVersion: 1,
    declaredSourceTraceSha256: "c4805f9c0644a9eb4b7050e892ba07c9800fb278ebebb27f3dd93a4e7dfbf49f",
    legacyDecision: "invalid",
    correctedDecision: "valid",
    correctedReason: "valid",
    outsideFixtureDecision: "invalid",
    forgedLocatorDecision: "invalid",
  },
};

describe("native alias preflight receipt", () => {
  test("accepts one clean receipt bound to the frozen schedule and artifact", () => {
    expect(() =>
      assertNativeAliasPreflightReceipt(structuredClone(receipt), expected),
    ).not.toThrow();
  });

  test("rejects dirty, incomplete, or artifact-substituted receipts", () => {
    for (const invalid of [
      { ...receipt, sourceDirty: true },
      { ...receipt, sourceEligibleForApproval: false },
      { ...receipt, verifierReport: { ...receipt.verifierReport, retryAbortVerified: false } },
      {
        ...receipt,
        artifact: { ...receipt.artifact, relativePath: "../replacement.tgz" },
      },
      { ...receipt, schedule: [{ ...schedule[0], adapter: "native" }] },
      { ...receipt, publishable: true },
    ]) {
      expect(() => assertNativeAliasPreflightReceipt(invalid, expected)).toThrow();
    }
  });

  test("rejects internally inconsistent or non-deterministic verifier evidence", () => {
    const mutated = (change: (report: NativeAliasPreflightReceipt["verifierReport"]) => void) => {
      const invalid = structuredClone(receipt);
      change(invalid.verifierReport);
      return invalid;
    };
    const reportCase = (report: NativeAliasPreflightReceipt["verifierReport"], index = 0) => {
      const value = report.cases[index];
      if (!value) throw new Error(`Missing verifier case ${index}.`);
      return value;
    };
    for (const invalid of [
      mutated((report) => {
        reportCase(report).model = "scripted/forged";
      }),
      mutated((report) => {
        reportCase(report).providerRequests = 999;
      }),
      mutated((report) => {
        reportCase(report).rendererSnapshot += "forged";
      }),
      mutated((report) => {
        reportCase(report).metadataSnapshotSha256 = reportCase(report, 1).metadataSnapshotSha256;
      }),
      mutated((report) => {
        Object.assign(report, { unknownEvidence: true });
      }),
      mutated((report) => {
        Object.assign(reportCase(report), { unknownEvidence: true });
      }),
    ]) {
      expect(() => assertNativeAliasPreflightReceipt(invalid, expected)).toThrow();
    }
  });
});
