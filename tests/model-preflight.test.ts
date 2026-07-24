import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertNativeAliasPreflightReceipt,
  NATIVE_ALIAS_PREFLIGHT_SCHEMA_VERSION,
  NATIVE_ALIAS_PREFLIGHT_SIDE_EFFECTS,
  type NativeAliasPreflightReceipt,
} from "../benchmarks/model/preflight.js";
import type { EffectiveToolIdentities } from "../benchmarks/model/provenance.js";
import { openCodeProviderSchema } from "../src/native-alias.js";
import { hashlineEditArgumentsSchema, hashlineWriteArgumentsSchema } from "../src/plugin.js";
import { canonicalJson, jsonSha256, nativeAliasProtocolFingerprint } from "../src/presentation.js";
import { PACKAGE_VERSION } from "../src/version.js";

const hash = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const schemaSha256 = jsonSha256(
  openCodeProviderSchema(z.toJSONSchema(hashlineEditArgumentsSchema)),
);
const writeSchemaSha256 = jsonSha256(
  openCodeProviderSchema(z.toJSONSchema(hashlineWriteArgumentsSchema)),
);
const hostVersion = "1.18.3";
const protocolFingerprint = nativeAliasProtocolFingerprint({
  packageVersion: PACKAGE_VERSION,
  schemaSha256,
  hostVersion,
});
const privateCanary = "BH_PRIVATE_CANARY_8f149f0a";
const fixturePath = (path: string) => `<fixture>/${path}`;
const lifecycleDeleteBytes = "delete exact bytes\n";
const lifecycleMoveBytes = "move exact bytes\n";
const lifecycleNoClobberBytes = "source remains exact\n";
const initialBytes = "alpha\nbeta\ngamma\n";
const patchSeparator = "===================================================================";
const patchHeader = (sourcePath: string, destinationPath: string, move = false) =>
  `${move ? "" : `Index: ${sourcePath}\n`}${patchSeparator}\n--- ${sourcePath}\tbefore\n+++ ${destinationPath}\tafter\n`;
const deletePath = fixturePath("lifecycle-delete.txt");
const movePath = fixturePath("lifecycle-move.txt");
const movedPath = fixturePath("lifecycle-moved.txt");
const probePath = fixturePath("probe.txt");
const deletePatch = `${patchHeader(deletePath, deletePath)}@@ -1,1 +0,0 @@\n-delete exact bytes\n`;
const movePatch = patchHeader(movePath, movedPath, true);
const probePatch = `${patchHeader(probePath, probePath)}@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n`;
const nestedCreatePath = "nested/inner/new.txt";
const nestedCreateBytes = "created\n";
const nestedCreatePatch = `${patchHeader(fixturePath(nestedCreatePath), fixturePath(nestedCreatePath))}@@ -0,0 +1,1 @@\n+created\n`;
const editReceipt = "@hashline-edit previous=consumed successor=none next=hashline_read";
const readbackPath = "readback-window.txt";
const readbackLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
const readbackAfterLines = readbackLines.map((line, index) =>
  index === 9 ? "readback-changed" : line,
);
const readbackFinalLines = readbackAfterLines.map((line, index) =>
  index === 7 ? "readback-inside" : line,
);
const compositionPath = "composition.txt";
const compositionFinalBytes = [
  "L1",
  "L4",
  "R5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L2",
  "L3",
  "",
].join("\n");
const editInput = (
  filePath: string,
  operations: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({ filePath, ...extra, operations, snapshotId: "<snapshot>" });
const nestedCreationEvidence = canonicalJson({
  creation: {
    input: { content: nestedCreateBytes, filePath: nestedCreatePath },
    metadata: {
      created: true,
      createdDirectories: [fixturePath("nested"), fixturePath("nested/inner")],
      diff: nestedCreatePatch,
      truncated: false,
    },
    output: "Created 2 parent directories and the file. Use hashline_read before editing it.",
    status: "completed",
    tool: "hashline_write",
  },
  permission: {
    approved: true,
    count: 1,
    metadata: {
      createdDirectories: [fixturePath("nested"), fixturePath("nested/inner")],
      diff: nestedCreatePatch,
      filepath: fixturePath(nestedCreatePath),
      filepaths: [
        fixturePath(nestedCreatePath),
        fixturePath("nested"),
        fixturePath("nested/inner"),
      ],
    },
    patterns: [fixturePath(nestedCreatePath), fixturePath("nested"), fixturePath("nested/inner")],
    permission: "edit",
  },
  tree: {
    directories: ["nested", "nested/inner"],
    files: [{ bytes: nestedCreateBytes, path: nestedCreatePath }],
  },
});
const readbackEvidence = (editTool: "hashline_edit" | "edit" | "apply_patch") => {
  const deliveredLines = readbackAfterLines.slice(7, 12);
  const readbackBytes = `${readbackAfterLines.join("\n")}\n`;
  return canonicalJson({
    delivered: { endLine: 12, lines: deliveredLines, startLine: 8 },
    finalBytes: `${readbackFinalLines.join("\n")}\n`,
    issuance: {
      inside: {
        input: editInput(readbackPath, [
          { endLine: 8, lines: ["readback-inside"], op: "replace", startLine: 8 },
        ]),
        output: `Applied 1 operation.\n${editReceipt}`,
        status: "completed",
      },
      outside: {
        errorCode: "RANGE_NOT_FULLY_ISSUED",
        input: editInput(readbackPath, [
          { endLine: 13, lines: ["readback-outside"], op: "replace", startLine: 13 },
        ]),
        status: "error",
      },
    },
    readback: {
      input: editInput(
        readbackPath,
        [{ endLine: 10, lines: ["readback-changed"], op: "replace", startLine: 10 }],
        { readbackLimit: 5, readbackOffset: 8 },
      ),
      output: [
        "Applied 1 operation.",
        "@hashline-edit previous=consumed successor=attached",
        `@hashline snapshot=<snapshot> sha256=${digest(readbackBytes).slice(0, 12)} lines=20 partial=true coverage=partial`,
        ...deliveredLines.map((line, index) => `${index + 8}|${line}`),
        "@more offset=13",
      ].join("\n"),
      pendingRemoved: true,
      status: "completed",
      tool: editTool,
    },
  });
};
const compositionEvidence = (editTool: "hashline_edit" | "edit" | "apply_patch") =>
  canonicalJson({
    edit: {
      input: editInput(compositionPath, [
        { afterLine: 13, endLine: 3, op: "move_range", startLine: 2 },
        { endLine: 5, lines: ["R5"], op: "replace", startLine: 5 },
      ]),
      output: `Applied 2 operations.\n${editReceipt}`,
      status: "completed",
      tool: editTool,
    },
    finalBytes: compositionFinalBytes,
  });
const readOutput = (bytes: string) => {
  const lines = bytes.replace(/\n$/u, "").split("\n");
  return [
    `@hashline snapshot=<snapshot> sha256=${digest(bytes).slice(0, 12)} lines=${lines.length} coverage=complete`,
    ...lines.map((line, index) => `${index + 1}|${line}`),
    "@eof",
  ].join("\n");
};
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
  packageVersion: PACKAGE_VERSION,
  filename: `opencode-better-hashline-${PACKAGE_VERSION}.tgz`,
  relativePath: `artifacts/opencode-better-hashline-${PACKAGE_VERSION}.tgz`,
  sha256: hash,
  installedLockfileSha256: hash,
  packageTreeSha256: hash,
};
const platform = { name: process.platform, arch: process.arch, osRelease: "test-os" };
const expected = {
  pilotId: "synthetic-native-alias-preflight",
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
  const marker = (operation: "update" | "delete_file" | "move_file") => {
    const sourcePath =
      operation === "delete_file" ? deletePath : operation === "move_file" ? movePath : probePath;
    return {
      canonicalPathSha256: digest(sourcePath),
      hostVersion,
      operation,
      packageVersion: PACKAGE_VERSION,
      protocol: "native-aliases/v2",
      schemaSha256,
      surface: editTool,
      ...(operation === "move_file" ? { destinationPathSha256: digest(movedPath) } : {}),
    };
  };
  const lifecycleMetadata = (operation: "delete_file" | "move_file") => {
    const sourcePath = operation === "delete_file" ? deletePath : movePath;
    const patch = operation === "delete_file" ? deletePatch : movePatch;
    const additions = 0;
    const deletions = operation === "delete_file" ? 1 : 0;
    if (route === "hashline") {
      return {
        ...(operation === "move_file" ? { destinationPath: movedPath } : {}),
        diff: patch,
        operation,
        truncated: false,
      };
    }
    if (editTool === "apply_patch") {
      return {
        betterHashline: marker(operation),
        diagnostics: {},
        files: [
          {
            additions,
            deletions,
            filePath: sourcePath,
            ...(operation === "move_file" ? { movePath: movedPath } : {}),
            patch,
            relativePath: operation === "move_file" ? movedPath : sourcePath,
            type: operation === "move_file" ? "move" : "delete",
          },
        ],
        truncated: false,
      };
    }
    return {
      betterHashline: marker(operation),
      diagnostics: {},
      diff: patch,
      filediff: { additions, deletions, file: sourcePath, patch },
      truncated: false,
    };
  };
  const updateMetadata = () => {
    if (route === "hashline") {
      return { diff: probePatch, operationCount: 1, rebased: false, truncated: false };
    }
    if (editTool === "apply_patch") {
      return {
        betterHashline: marker("update"),
        diagnostics: {},
        files: [
          {
            additions: 1,
            deletions: 1,
            filePath: probePath,
            patch: probePatch,
            relativePath: probePath,
            type: "update",
          },
        ],
        truncated: false,
      };
    }
    return {
      betterHashline: marker("update"),
      diagnostics: {},
      diff: probePatch,
      filediff: { additions: 1, deletions: 1, file: probePath, patch: probePatch },
      truncated: false,
    };
  };
  const readEvent = (filePath: string, bytes: string, limit?: number) => ({
    state: {
      input: { filePath, ...(limit === undefined ? {} : { limit }) },
      metadata: {
        displayedLines: bytes.replace(/\n$/u, "").split("\n").length,
        snapshotId: "<snapshot>",
        truncated: false,
      },
      output: readOutput(bytes),
      status: "completed",
    },
    tool: "hashline_read",
    type: "tool_use",
  });
  const operationInput = (
    filePath: string,
    operation: "delete_file" | "move_file",
    destinationPath?: string,
  ) => ({
    filePath,
    operations: [
      operation === "delete_file" ? { op: operation } : { destinationPath, op: operation },
    ],
    snapshotId: "<snapshot>",
  });
  const lifecycleReceipt = "\n@hashline-edit previous=consumed successor=none next=hashline_read";
  const malformedInput =
    editTool === "apply_patch"
      ? {
          patchText: `*** Begin Patch\n*** Update File: malformed.txt\n@@\n-${privateCanary}\n+changed\n*** End Patch`,
        }
      : { filePath: "malformed.txt", newString: "changed", oldString: privateCanary };
  const rejectedField = editTool === "apply_patch" ? "patchText" : "newString";
  const metadataSnapshot = canonicalJson([
    {
      state: {
        error: `INVALID_ARGUMENT: ${rejectedField} is not accepted by ${editTool}. No mutation occurred; a valid supplied snapshot remains usable.`,
        input: malformedInput,
        status: "error",
      },
      tool: editTool,
      type: "tool_use",
    },
    readEvent("lifecycle-delete.txt", lifecycleDeleteBytes),
    {
      state: {
        input: operationInput("lifecycle-delete.txt", "delete_file"),
        metadata: lifecycleMetadata("delete_file"),
        output: `Deleted ${deletePath}.${lifecycleReceipt}`,
        status: "completed",
      },
      tool: editTool,
      type: "tool_use",
    },
    readEvent("lifecycle-move.txt", lifecycleMoveBytes),
    {
      state: {
        input: operationInput("lifecycle-move.txt", "move_file", "lifecycle-moved.txt"),
        metadata: lifecycleMetadata("move_file"),
        output: `Moved ${movePath} to ${movedPath}.${lifecycleReceipt}`,
        status: "completed",
      },
      tool: editTool,
      type: "tool_use",
    },
    readEvent("lifecycle-no-clobber.txt", lifecycleNoClobberBytes),
    {
      state: {
        error:
          "TARGET_EXISTS: The target already exists; create and move operations never overwrite. Inspect it and choose an absent target.",
        input: operationInput("lifecycle-no-clobber.txt", "move_file", "lifecycle-occupied.txt"),
        status: "error",
      },
      tool: editTool,
      type: "tool_use",
    },
    readEvent("probe.txt", initialBytes, 3),
    {
      state: {
        input: {
          filePath: "probe.txt",
          operations: [{ endLine: 2, lines: ["BETA"], op: "replace", startLine: 2 }],
          snapshotId: "<snapshot>",
        },
        metadata: updateMetadata(),
        output: `Applied 1 operation.${lifecycleReceipt}`,
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
  const readback = readbackEvidence(editTool);
  const composition = compositionEvidence(editTool);
  return {
    route,
    model: route === "native-apply-patch" ? "scripted/gpt-5-scripted" : "scripted/scripted",
    editTool,
    schemaSha256,
    writeSchemaSha256,
    ...(route === "hashline"
      ? {}
      : {
          protocolFingerprint,
        }),
    finalBytesSha256: "8b1f3c90fab7f353b4a997497392fa025ea08f0b023c2f5f4ab9ec0993494293",
    providerRequests: route === "native-edit" ? 42 : route === "native-apply-patch" ? 39 : 35,
    malformedRejected: true as const,
    fileOperationsVerified: true as const,
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
    nestedCreationEvidenceSha256: digest(nestedCreationEvidence),
    nestedCreationEvidence,
    readbackEvidenceSha256: digest(readback),
    readbackEvidence: readback,
    compositionEvidenceSha256: digest(composition),
    compositionEvidence: composition,
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
    packageVersion: PACKAGE_VERSION,
    hostVersion: "1.18.3",
    protocol: "native-aliases/v2",
    rollbackVerified: true,
    fileOperationsVerified: true,
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
    schemaVersion: 2,
    hostVersion: "1.18.3",
    legacyDecision: "invalid",
    correctedDecision: "valid",
    correctedReason: "valid",
    outsideFixtureDecision: "invalid",
    forgedLocatorDecision: "invalid",
  },
};

describe("native alias preflight receipt", () => {
  test("accepts one coherent synthetic receipt with mandatory coverage headers", () => {
    const headers = receipt.verifierReport.cases.flatMap((verificationCase) => {
      const events = JSON.parse(verificationCase.metadataSnapshot) as Array<{
        state: { output?: unknown };
      }>;
      const readback = JSON.parse(verificationCase.readbackEvidence) as {
        readback: { output?: unknown };
      };
      return [...events.map(({ state }) => state.output), readback.readback.output].flatMap(
        (output) =>
          typeof output === "string"
            ? output.split("\n").filter((line) => line.startsWith("@hashline snapshot="))
            : [],
      );
    });
    expect(headers).toHaveLength(15);
    expect(headers.filter((header) => header.endsWith(" coverage=complete"))).toHaveLength(12);
    expect(
      headers.filter((header) => header.endsWith(" partial=true coverage=partial")),
    ).toHaveLength(3);
    expect(() =>
      assertNativeAliasPreflightReceipt(structuredClone(receipt), expected),
    ).not.toThrow();
  });

  test("rejects dirty, incomplete, or artifact-substituted receipts", () => {
    for (const invalid of [
      { ...receipt, sourceDirty: true },
      { ...receipt, sourceEligibleForApproval: false },
      { ...receipt, verifierReport: { ...receipt.verifierReport, retryAbortVerified: false } },
      { ...receipt, verifierReport: { ...receipt.verifierReport, fileOperationsVerified: false } },
      {
        ...receipt,
        oracleFixture: { ...receipt.oracleFixture, hostVersion: "1.18.4" },
      },
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
        Object.assign(reportCase(report), { fileOperationsVerified: false });
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

  test("rejects self-hashed forged lifecycle evidence", () => {
    type SnapshotEvent = { state: Record<string, unknown>; tool: string; type: string };
    type SnapshotMutation = (events: SnapshotEvent[]) => void;
    const forged = (caseIndex: number, mutate: SnapshotMutation) => {
      const invalid = structuredClone(receipt);
      const verificationCase = invalid.verifierReport.cases[caseIndex];
      if (!verificationCase) throw new Error(`Missing verifier case ${caseIndex}.`);
      const events = JSON.parse(verificationCase.metadataSnapshot) as SnapshotEvent[];
      mutate(events);
      verificationCase.metadataSnapshot = canonicalJson(events);
      verificationCase.metadataSnapshotSha256 = digest(verificationCase.metadataSnapshot);
      return invalid;
    };
    const state = (events: SnapshotEvent[], index: number) => {
      const value = events[index]?.state;
      if (!value) throw new Error(`Missing event state ${index}.`);
      return value;
    };
    const metadata = (events: SnapshotEvent[], index: number) => {
      const value = state(events, index).metadata;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Missing event metadata ${index}.`);
      }
      return value as Record<string, unknown>;
    };
    const marker = (events: SnapshotEvent[], index: number) => {
      const value = metadata(events, index).betterHashline;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Missing native marker ${index}.`);
      }
      return value as Record<string, unknown>;
    };
    const filediff = (events: SnapshotEvent[], index: number) => {
      const value = metadata(events, index).filediff;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Missing edit filediff ${index}.`);
      }
      return value as Record<string, unknown>;
    };
    const patchFile = (events: SnapshotEvent[], index: number) => {
      const files = metadata(events, index).files;
      if (!Array.isArray(files) || !files[0] || typeof files[0] !== "object") {
        throw new Error(`Missing apply_patch file ${index}.`);
      }
      return files[0] as Record<string, unknown>;
    };

    const mutations: Array<[number, SnapshotMutation]> = [
      [0, (events) => Object.assign(marker(events, 2), { protocol: "native-aliases/v1" })],
      [0, (events) => Object.assign(marker(events, 2), { packageVersion: "9.9.9" })],
      [0, (events) => Object.assign(marker(events, 2), { hostVersion: "1.18.4" })],
      [0, (events) => Object.assign(marker(events, 2), { schemaSha256: "f".repeat(64) })],
      [0, (events) => Object.assign(marker(events, 2), { surface: "apply_patch" })],
      [0, (events) => Object.assign(marker(events, 2), { operation: "move_file" })],
      [0, (events) => Object.assign(marker(events, 2), { canonicalPathSha256: "f".repeat(64) })],
      [0, (events) => Object.assign(marker(events, 4), { destinationPathSha256: "f".repeat(64) })],
      [0, (events) => Object.assign(marker(events, 2), { forged: true })],
      [0, (events) => Object.assign(state(events, 1), { forged: true })],
      [0, (events) => delete (metadata(events, 1) as Record<string, unknown>).snapshotId],
      [
        0,
        (events) => {
          const input = state(events, 2).input as Record<string, unknown>;
          input.filePath = "forged.txt";
        },
      ],
      [0, (events) => Object.assign(state(events, 2), { output: "Deleted forged.txt." })],
      [0, (events) => Object.assign(metadata(events, 2).diagnostics as object, { forged: true })],
      [0, (events) => delete metadata(events, 2).diagnostics],
      [0, (events) => delete filediff(events, 2).deletions],
      [0, (events) => Object.assign(filediff(events, 2), { file: movedPath })],
      [
        0,
        (events) => {
          const value = String(metadata(events, 2).diff).replace(
            "-delete exact bytes",
            "-forged exact bytes",
          );
          metadata(events, 2).diff = value;
          filediff(events, 2).patch = value;
        },
      ],
      [
        0,
        (events) => {
          const value = String(metadata(events, 2).diff).replace("@@ -1,1", "@@ -2,1");
          metadata(events, 2).diff = value;
          filediff(events, 2).patch = value;
        },
      ],
      [
        0,
        (events) => {
          const value = String(metadata(events, 2).diff).split("@@ ")[0];
          metadata(events, 2).diff = value;
          const diff = filediff(events, 2);
          diff.patch = value;
          diff.deletions = 0;
        },
      ],
      [0, (events) => Object.assign(filediff(events, 2), { additions: 1 })],
      [
        0,
        (events) => {
          const value = `${String(metadata(events, 4).diff)}@@ -1,1 +1,1 @@\n-move exact bytes\n+forged\n`;
          metadata(events, 4).diff = value;
          filediff(events, 4).patch = value;
        },
      ],
      [1, (events) => Object.assign(patchFile(events, 2), { deletions: 0 })],
      [1, (events) => Object.assign(patchFile(events, 2), { filePath: movePath })],
      [1, (events) => Object.assign(patchFile(events, 4), { relativePath: movePath })],
      [1, (events) => delete patchFile(events, 4).movePath],
      [1, (events) => Object.assign(patchFile(events, 4), { forged: true })],
      [
        1,
        (events) => {
          patchFile(events, 4).patch = String(patchFile(events, 4).patch).replace(
            `+++ ${movedPath}`,
            `+++ ${deletePath}`,
          );
        },
      ],
      [2, (events) => Object.assign(metadata(events, 2), { forged: true })],
      [2, (events) => Object.assign(metadata(events, 4), { destinationPath: deletePath })],
      [2, (events) => Object.assign(metadata(events, 4), { operation: "delete_file" })],
      [2, (events) => delete metadata(events, 8).rebased],
      [2, (events) => Object.assign(metadata(events, 8), { operationCount: 2 })],
      [
        2,
        (events) => {
          metadata(events, 8).diff = String(metadata(events, 8).diff).replace("+BETA", "+FORGED");
        },
      ],
      [0, (events) => Object.assign(metadata(events, 1), { displayedLines: 2 })],
      [0, (events) => Object.assign(metadata(events, 1), { truncated: true })],
      [0, (events) => Object.assign(metadata(events, 1), { forged: true })],
      [
        0,
        (events) => {
          state(events, 1).output = String(state(events, 1).output).replace(
            digest(lifecycleDeleteBytes).slice(0, 12),
            "0".repeat(12),
          );
        },
      ],
      [
        0,
        (events) => {
          state(events, 7).output = String(state(events, 7).output).replace("2|beta", "2|forged");
        },
      ],
      [
        0,
        (events) => {
          const input = state(events, 7).input as Record<string, unknown>;
          delete input.limit;
        },
      ],
      [
        0,
        (events) => {
          const input = state(events, 6).input as Record<string, unknown>;
          const operations = input.operations as Array<Record<string, unknown>>;
          if (!operations[0]) throw new Error("Missing no-clobber operation.");
          operations[0].destinationPath = "forged.txt";
        },
      ],
      [0, (events) => Object.assign(state(events, 6), { error: "TARGET_EXISTS: forged" })],
      [0, (events) => Object.assign(state(events, 0), { error: "INVALID_ARGUMENT: forged" })],
      [
        0,
        (events) => {
          const input = state(events, 0).input as Record<string, unknown>;
          input.oldString = "forged";
        },
      ],
      [
        0,
        (events) => {
          const input = state(events, 8).input as Record<string, unknown>;
          Object.assign(input, { forged: true });
        },
      ],
      [0, (events) => Object.assign(state(events, 8), { output: "Applied 1 operation." })],
      [0, (events) => Object.assign(state(events, 4), { status: "error" })],
      [
        0,
        (events) => {
          const first = events[2];
          const second = events[4];
          if (!first || !second) throw new Error("Missing lifecycle events.");
          events[2] = second;
          events[4] = first;
        },
      ],
    ];

    for (const [caseIndex, mutate] of mutations) {
      const invalid = forged(caseIndex, mutate);
      expect(() => assertNativeAliasPreflightReceipt(invalid, expected)).toThrow();
    }
  });

  test("rejects forged write schema and self-hashed edit UX evidence", () => {
    const forgedWriteSchema = structuredClone(receipt);
    const writeCase = forgedWriteSchema.verifierReport.cases[0];
    if (!writeCase) throw new Error("Missing write-schema verifier case.");
    writeCase.writeSchemaSha256 = digest("forged write schema");
    expect(() => assertNativeAliasPreflightReceipt(forgedWriteSchema, expected)).toThrow();

    const forgedEvidence = (
      caseIndex: number,
      evidenceField: "nestedCreationEvidence" | "readbackEvidence" | "compositionEvidence",
      hashField:
        | "nestedCreationEvidenceSha256"
        | "readbackEvidenceSha256"
        | "compositionEvidenceSha256",
      mutate: (evidence: Record<string, unknown>) => void,
    ) => {
      const invalid = structuredClone(receipt);
      const verificationCase = invalid.verifierReport.cases[caseIndex];
      if (!verificationCase) throw new Error(`Missing verifier case ${caseIndex}.`);
      const evidence = JSON.parse(verificationCase[evidenceField]) as Record<string, unknown>;
      mutate(evidence);
      verificationCase[evidenceField] = canonicalJson(evidence);
      verificationCase[hashField] = digest(verificationCase[evidenceField]);
      return invalid;
    };
    const invalid = [
      forgedEvidence(0, "nestedCreationEvidence", "nestedCreationEvidenceSha256", (evidence) => {
        const creation = evidence.creation as Record<string, unknown>;
        const input = creation.input as Record<string, unknown>;
        input.createParents = true;
      }),
      forgedEvidence(1, "readbackEvidence", "readbackEvidenceSha256", (evidence) => {
        const delivered = evidence.delivered as Record<string, unknown>;
        delivered.endLine = 13;
      }),
      forgedEvidence(2, "compositionEvidence", "compositionEvidenceSha256", (evidence) => {
        evidence.finalBytes = "forged\n";
      }),
    ];
    for (const value of invalid) {
      expect(() => assertNativeAliasPreflightReceipt(value, expected)).toThrow();
    }
  });
});
