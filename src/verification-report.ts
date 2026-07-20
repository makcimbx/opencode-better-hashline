import { createHash } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import { openCode1183ProviderSchema } from "./native-alias.js";
import { hashlineEditArgumentsSchema } from "./plugin.js";
import {
  canonicalJson,
  jsonSha256,
  NATIVE_ALIAS_PROTOCOL,
  nativeAliasProtocolFingerprint,
} from "./presentation.js";

export const PINNED_OPENCODE_VERSION = "1.18.3";
export const VERIFIER_RENDERED_BYTES = "alpha\nRENDER\ngamma\n";
export const TERMINAL_RENDERER_SHA256: Record<VerificationCaseReport["route"], string> = {
  hashline: "cc314f125f2cb87d36099a6503374a83d381f6ce09b0ae224869838d07092e8d",
  "native-edit": "d40a50dbfe64e8989066dba98a3922ba5aafe956128e6d8652998bf04419d94c",
  "native-apply-patch": "d9c6cef2282fac727d819bfecca836d90965dae5f7f691088bcc304fee310046",
};

export interface VerificationCaseReport {
  route: "hashline" | "native-edit" | "native-apply-patch";
  model: string;
  editTool: "hashline_edit" | "edit" | "apply_patch";
  schemaSha256: string;
  protocolFingerprint?: string;
  finalBytesSha256: string;
  providerRequests: number;
  malformedRejected: true;
  continuationVerified: true;
  forkVerified: true;
  exportVerified: true;
  reopenVerified: true;
  sanitizedExportVerified: true;
  terminalRendererVerified: true;
  modelRoutingVerified: boolean;
  editPermissionMatrixVerified: boolean;
  benchmarkOracleVerified: boolean;
  retryAbortVerified: boolean;
  retryProviderRequests: number;
  metadataSnapshotSha256: string;
  metadataSnapshot: string;
  rendererSnapshotSha256: string;
  rendererSnapshot: string;
}

export interface VerificationReport {
  ok: true;
  packageVersion: string;
  hostVersion: string;
  protocol: typeof NATIVE_ALIAS_PROTOCOL;
  rollbackVerified: boolean;
  modelRoutingVerified: boolean;
  editPermissionMatrixVerified: boolean;
  benchmarkOracleVerified: boolean;
  retryAbortVerified: boolean;
  retryProviderRequests: number;
  cases: VerificationCaseReport[];
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isVerificationMetadataSnapshot(
  value: unknown,
  route: VerificationCaseReport["route"],
  editTool: VerificationCaseReport["editTool"],
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || canonicalJson(parsed) !== value)
    return false;
  const tools = [editTool, "hashline_read", editTool];
  const statuses = ["error", "completed", "completed"];
  return parsed.every((item, index) => {
    const event = record(item);
    const state = record(event?.state);
    return (
      event !== undefined &&
      state !== undefined &&
      hasExactKeys(event, ["state", "tool", "type"]) &&
      event.type === "tool_use" &&
      event.tool === tools[index] &&
      state.status === statuses[index] &&
      record(state.input) !== undefined &&
      (index === 0 || (typeof state.output === "string" && record(state.metadata) !== undefined)) &&
      (index !== 2 ||
        (route === "hashline"
          ? record(state.metadata)?.operationCount === 1
          : record(record(state.metadata)?.betterHashline)?.surface === editTool))
    );
  });
}

export function assertFullVerificationReport(
  value: unknown,
  expectedPackageVersion: string,
  expectedHostVersion: string,
): asserts value is VerificationReport {
  const report = record(value);
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const expectedCases = [
    {
      route: "native-edit",
      model: "scripted/scripted",
      editTool: "edit",
      providerRequests: 24,
      modelRoutingVerified: true,
      editPermissionMatrixVerified: true,
      retryProviderRequests: 1,
    },
    {
      route: "native-apply-patch",
      model: "scripted/gpt-5-scripted",
      editTool: "apply_patch",
      providerRequests: 21,
      modelRoutingVerified: false,
      editPermissionMatrixVerified: true,
      retryProviderRequests: 0,
    },
    {
      route: "hashline",
      model: "scripted/scripted",
      editTool: "hashline_edit",
      providerRequests: 17,
      modelRoutingVerified: false,
      editPermissionMatrixVerified: false,
      retryProviderRequests: 0,
    },
  ] as const;
  if (
    !report ||
    !hasExactKeys(report, [
      "benchmarkOracleVerified",
      "cases",
      "editPermissionMatrixVerified",
      "hostVersion",
      "modelRoutingVerified",
      "ok",
      "packageVersion",
      "protocol",
      "retryAbortVerified",
      "retryProviderRequests",
      "rollbackVerified",
    ]) ||
    report.ok !== true ||
    report.packageVersion !== expectedPackageVersion ||
    report.hostVersion !== expectedHostVersion ||
    report.protocol !== NATIVE_ALIAS_PROTOCOL ||
    report.rollbackVerified !== true ||
    report.modelRoutingVerified !== true ||
    report.editPermissionMatrixVerified !== true ||
    report.benchmarkOracleVerified !== true ||
    report.retryAbortVerified !== true ||
    report.retryProviderRequests !== 1 ||
    cases.length !== expectedCases.length
  ) {
    throw new Error("Verification report does not match the exact full-surface envelope.");
  }

  const schemaSha256 = jsonSha256(
    openCode1183ProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
  );
  const finalBytesSha256 = sha256(VERIFIER_RENDERED_BYTES);
  let protocolFingerprint: string | undefined;
  for (let index = 0; index < expectedCases.length; index += 1) {
    const expected = expectedCases[index];
    if (!expected) throw new Error("Verification report route definition is missing.");
    const verificationCase = record(cases[index]);
    const native = expected.route !== "hashline";
    if (
      !verificationCase ||
      !hasExactKeys(verificationCase, [
        "benchmarkOracleVerified",
        "continuationVerified",
        "editPermissionMatrixVerified",
        "editTool",
        "exportVerified",
        "finalBytesSha256",
        "forkVerified",
        "malformedRejected",
        "metadataSnapshot",
        "metadataSnapshotSha256",
        "model",
        "modelRoutingVerified",
        "providerRequests",
        ...(native ? ["protocolFingerprint"] : []),
        "rendererSnapshot",
        "rendererSnapshotSha256",
        "reopenVerified",
        "retryAbortVerified",
        "retryProviderRequests",
        "route",
        "sanitizedExportVerified",
        "schemaSha256",
        "terminalRendererVerified",
      ]) ||
      verificationCase.route !== expected.route ||
      verificationCase.model !== expected.model ||
      verificationCase.editTool !== expected.editTool ||
      verificationCase.providerRequests !== expected.providerRequests ||
      verificationCase.modelRoutingVerified !== expected.modelRoutingVerified ||
      verificationCase.editPermissionMatrixVerified !== expected.editPermissionMatrixVerified ||
      verificationCase.retryProviderRequests !== expected.retryProviderRequests ||
      verificationCase.schemaSha256 !== schemaSha256 ||
      verificationCase.finalBytesSha256 !== finalBytesSha256 ||
      verificationCase.malformedRejected !== true ||
      verificationCase.continuationVerified !== true ||
      verificationCase.forkVerified !== true ||
      verificationCase.exportVerified !== true ||
      verificationCase.reopenVerified !== true ||
      verificationCase.sanitizedExportVerified !== true ||
      verificationCase.terminalRendererVerified !== true ||
      verificationCase.benchmarkOracleVerified !== true ||
      verificationCase.retryAbortVerified !== true ||
      typeof verificationCase.metadataSnapshot !== "string" ||
      verificationCase.metadataSnapshot.length === 0 ||
      verificationCase.metadataSnapshot.length > 8_192 ||
      !/^[a-f0-9]{64}$/u.test(String(verificationCase.metadataSnapshotSha256)) ||
      !isVerificationMetadataSnapshot(
        verificationCase.metadataSnapshot,
        expected.route,
        expected.editTool,
      ) ||
      sha256(verificationCase.metadataSnapshot) !== verificationCase.metadataSnapshotSha256 ||
      typeof verificationCase.rendererSnapshot !== "string" ||
      verificationCase.rendererSnapshot.length === 0 ||
      verificationCase.rendererSnapshot.length > 8_192 ||
      verificationCase.rendererSnapshotSha256 !== TERMINAL_RENDERER_SHA256[expected.route] ||
      sha256(verificationCase.rendererSnapshot) !== verificationCase.rendererSnapshotSha256
    ) {
      throw new Error(`Verification report has invalid ${expected.route} evidence.`);
    }
    if (native) {
      const expectedFingerprint = nativeAliasProtocolFingerprint({
        packageVersion: expectedPackageVersion,
        schemaSha256,
        hostVersion: expectedHostVersion,
      });
      if (verificationCase.protocolFingerprint !== expectedFingerprint) {
        throw new Error(`Verification report has invalid ${expected.route} fingerprint.`);
      }
      protocolFingerprint ??= verificationCase.protocolFingerprint as string;
      if (verificationCase.protocolFingerprint !== protocolFingerprint) {
        throw new Error("Verification report has inconsistent native protocol fingerprints.");
      }
    }
  }
}
