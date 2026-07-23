import { createHash } from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import { openCodeProviderSchema } from "./native-alias.js";
import { hashlineEditArgumentsSchema, hashlineWriteArgumentsSchema } from "./plugin.js";
import {
  canonicalJson,
  jsonSha256,
  NATIVE_ALIAS_PROTOCOL,
  nativeAliasProtocolFingerprint,
} from "./presentation.js";

export const PINNED_OPENCODE_VERSION = "1.18.4";
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
  writeSchemaSha256: string;
  protocolFingerprint?: string;
  finalBytesSha256: string;
  providerRequests: number;
  malformedRejected: true;
  fileOperationsVerified: true;
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
  nestedCreationEvidenceSha256: string;
  nestedCreationEvidence: string;
  readbackEvidenceSha256: string;
  readbackEvidence: string;
  compositionEvidenceSha256: string;
  compositionEvidence: string;
  rendererSnapshotSha256: string;
  rendererSnapshot: string;
}

export interface VerificationReport {
  ok: true;
  packageVersion: string;
  hostVersion: string;
  protocol: typeof NATIVE_ALIAS_PROTOCOL;
  rollbackVerified: boolean;
  fileOperationsVerified: boolean;
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

const LIFECYCLE_DELETE_PATH = "lifecycle-delete.txt";
const LIFECYCLE_MOVE_PATH = "lifecycle-move.txt";
const LIFECYCLE_MOVED_PATH = "lifecycle-moved.txt";
const LIFECYCLE_NO_CLOBBER_PATH = "lifecycle-no-clobber.txt";
const LIFECYCLE_OCCUPIED_PATH = "lifecycle-occupied.txt";
const PROBE_PATH = "probe.txt";
const PRIVATE_CANARY = "BH_PRIVATE_CANARY_8f149f0a";
const INITIAL_BYTES = "alpha\nbeta\ngamma\n";
const LIFECYCLE_DELETE_BYTES = "delete exact bytes\n";
const LIFECYCLE_MOVE_BYTES = "move exact bytes\n";
const LIFECYCLE_NO_CLOBBER_BYTES = "source remains exact\n";
const PATCH_SEPARATOR = "===================================================================";
const EDIT_RECEIPT = "@hashline-edit previous=consumed successor=none next=hashline_read";
const NESTED_CREATE_PATH = "nested/inner/new.txt";
const NESTED_CREATE_BYTES = "created\n";
const READBACK_PATH = "readback-window.txt";
const COMPOSITION_PATH = "composition.txt";
const READBACK_BEFORE_LINES = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
const READBACK_AFTER_LINES = READBACK_BEFORE_LINES.map((line, index) =>
  index === 9 ? "readback-changed" : line,
);
const READBACK_FINAL_LINES = READBACK_AFTER_LINES.map((line, index) =>
  index === 7 ? "readback-inside" : line,
);
const COMPOSITION_FINAL_BYTES = [
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

type EvidenceOperation = "delete_file" | "move_file" | "update";

interface OperationEvidence {
  operation: EvidenceOperation;
  sourcePath: string;
  destinationPath: string;
  patch: string;
  additions: number;
  deletions: number;
}

function fixturePath(path: string): string {
  return `<fixture>/${path}`;
}

function patchHeader(
  sourcePath: string,
  destinationPath: string,
  operation: EvidenceOperation,
): string {
  return `${operation === "move_file" ? "" : `Index: ${sourcePath}\n`}${PATCH_SEPARATOR}\n--- ${sourcePath}\tbefore\n+++ ${destinationPath}\tafter\n`;
}

function deletePatch(path: string, bytes: string): string {
  const header = patchHeader(path, path, "delete_file");
  if (bytes.length === 0) return header;
  const lines = bytes.endsWith("\n") ? bytes.slice(0, -1).split("\n") : bytes.split("\n");
  return `${header}@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join("\n")}\n`;
}

const OPERATION_EVIDENCE: Record<EvidenceOperation, OperationEvidence> = {
  delete_file: {
    operation: "delete_file",
    sourcePath: fixturePath(LIFECYCLE_DELETE_PATH),
    destinationPath: fixturePath(LIFECYCLE_DELETE_PATH),
    patch: deletePatch(fixturePath(LIFECYCLE_DELETE_PATH), LIFECYCLE_DELETE_BYTES),
    additions: 0,
    deletions: 1,
  },
  move_file: {
    operation: "move_file",
    sourcePath: fixturePath(LIFECYCLE_MOVE_PATH),
    destinationPath: fixturePath(LIFECYCLE_MOVED_PATH),
    patch: patchHeader(
      fixturePath(LIFECYCLE_MOVE_PATH),
      fixturePath(LIFECYCLE_MOVED_PATH),
      "move_file",
    ),
    additions: 0,
    deletions: 0,
  },
  update: {
    operation: "update",
    sourcePath: fixturePath(PROBE_PATH),
    destinationPath: fixturePath(PROBE_PATH),
    patch: `${patchHeader(fixturePath(PROBE_PATH), fixturePath(PROBE_PATH), "update")}@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n`,
    additions: 1,
    deletions: 1,
  },
};

function sameJson(value: unknown, expected: unknown): boolean {
  return canonicalJson(value) === canonicalJson(expected);
}

function createFilePatch(path: string, bytes: string): string {
  const lines = bytes.endsWith("\n") ? bytes.slice(0, -1).split("\n") : bytes.split("\n");
  return `${patchHeader(path, path, "update")}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

function expectedNestedCreationEvidence() {
  const target = fixturePath(NESTED_CREATE_PATH);
  const directories = [fixturePath("nested"), fixturePath("nested/inner")];
  const diff = createFilePatch(target, NESTED_CREATE_BYTES);
  return {
    creation: {
      input: { content: NESTED_CREATE_BYTES, filePath: NESTED_CREATE_PATH },
      metadata: { created: true, createdDirectories: directories, diff, truncated: false },
      output: "Created 2 parent directories and the file. Use hashline_read before editing it.",
      status: "completed",
      tool: "hashline_write",
    },
    permission: {
      approved: true,
      count: 1,
      metadata: {
        createdDirectories: directories,
        diff,
        filepath: target,
        filepaths: [target, ...directories],
      },
      patterns: [target, ...directories],
      permission: "edit",
    },
    tree: {
      directories: ["nested", "nested/inner"],
      files: [{ bytes: NESTED_CREATE_BYTES, path: NESTED_CREATE_PATH }],
    },
  };
}

function editInput(
  filePath: string,
  operations: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return { filePath, ...extra, operations, snapshotId: "<snapshot>" };
}

function expectedReadbackEvidence(editTool: VerificationCaseReport["editTool"]) {
  const deliveredLines = READBACK_AFTER_LINES.slice(7, 12);
  const readbackBytes = `${READBACK_AFTER_LINES.join("\n")}\n`;
  const readbackOutput = [
    "Applied 1 operation.",
    "@hashline-edit previous=consumed successor=attached",
    `@hashline snapshot=<snapshot> sha256=${sha256(readbackBytes).slice(0, 12)} lines=20 partial=true`,
    ...deliveredLines.map((line, index) => `${index + 8}|${line}`),
    "@more offset=13",
  ].join("\n");
  return {
    delivered: {
      endLine: 12,
      lines: deliveredLines,
      startLine: 8,
    },
    finalBytes: `${READBACK_FINAL_LINES.join("\n")}\n`,
    issuance: {
      inside: {
        input: editInput(READBACK_PATH, [
          { endLine: 8, lines: ["readback-inside"], op: "replace", startLine: 8 },
        ]),
        output: `Applied 1 operation.\n${EDIT_RECEIPT}`,
        status: "completed",
      },
      outside: {
        errorCode: "RANGE_NOT_FULLY_ISSUED",
        input: editInput(READBACK_PATH, [
          { endLine: 13, lines: ["readback-outside"], op: "replace", startLine: 13 },
        ]),
        status: "error",
      },
    },
    readback: {
      input: editInput(
        READBACK_PATH,
        [{ endLine: 10, lines: ["readback-changed"], op: "replace", startLine: 10 }],
        { readbackLimit: 5, readbackOffset: 8 },
      ),
      output: readbackOutput,
      pendingRemoved: true,
      status: "completed",
      tool: editTool,
    },
  };
}

function expectedCompositionEvidence(editTool: VerificationCaseReport["editTool"]) {
  return {
    edit: {
      input: editInput(COMPOSITION_PATH, [
        { afterLine: 13, endLine: 3, op: "move_range", startLine: 2 },
        { endLine: 5, lines: ["R5"], op: "replace", startLine: 5 },
      ]),
      output: `Applied 2 operations.\n${EDIT_RECEIPT}`,
      status: "completed",
      tool: editTool,
    },
    finalBytes: COMPOSITION_FINAL_BYTES,
  };
}

function isExactEvidence(value: unknown, expected: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return value === canonicalJson(parsed) && sameJson(parsed, expected);
  } catch {
    return false;
  }
}

function parseUnifiedDiff(
  patch: string,
  expected: OperationEvidence,
): { additions: number; deletions: number; hunks: number } | undefined {
  const lines = patch.split("\n");
  let index = 0;
  if (expected.operation === "move_file") {
    if (lines[0] !== PATCH_SEPARATOR) return undefined;
    index = 1;
  } else {
    if (lines[0] !== `Index: ${expected.sourcePath}` || lines[1] !== PATCH_SEPARATOR) {
      return undefined;
    }
    index = 2;
  }
  if (
    lines[index] !== `--- ${expected.sourcePath}\tbefore` ||
    lines[index + 1] !== `+++ ${expected.destinationPath}\tafter`
  ) {
    return undefined;
  }
  index += 2;

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  while (index < lines.length && lines[index] !== "") {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(lines[index] ?? "");
    if (!header) return undefined;
    hunks += 1;
    const oldStart = Number(header[1]);
    const oldExpected = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newExpected = header[4] === undefined ? 1 : Number(header[4]);
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldExpected) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newExpected) ||
      oldExpected < 0 ||
      newExpected < 0 ||
      (oldExpected === 0 ? oldStart < 0 : oldStart < 1) ||
      (newExpected === 0 ? newStart < 0 : newStart < 1) ||
      oldStart < previousOldEnd ||
      newStart < previousNewEnd ||
      (expected.operation === "delete_file" &&
        (hunks !== 1 || oldStart !== 1 || oldExpected < 1 || newStart !== 0 || newExpected !== 0))
    ) {
      return undefined;
    }
    previousOldEnd = oldStart + oldExpected;
    previousNewEnd = newStart + newExpected;

    let oldCount = 0;
    let newCount = 0;
    let newlineMarkerAllowed = false;
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("@@ ") || line === "") break;
      if (line === "\\ No newline at end of file") {
        if (!newlineMarkerAllowed) return undefined;
        newlineMarkerAllowed = false;
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        oldCount += 1;
        newCount += 1;
      } else if (line.startsWith("-")) {
        oldCount += 1;
        deletions += 1;
      } else if (line.startsWith("+")) {
        newCount += 1;
        additions += 1;
      } else {
        return undefined;
      }
      newlineMarkerAllowed = true;
      index += 1;
    }
    if (oldCount !== oldExpected || newCount !== newExpected) return undefined;
  }

  const validHunks =
    expected.operation === "update"
      ? hunks > 0
      : expected.operation === "delete_file"
        ? hunks === 0 || (hunks === 1 && additions === 0 && deletions > 0)
        : hunks === 0;
  if (!validHunks || index !== lines.length - 1) return undefined;
  return { additions, deletions, hunks };
}

function isExpectedPatch(value: unknown, expected: OperationEvidence): value is string {
  if (typeof value !== "string" || value !== expected.patch) return false;
  const parsed = parseUnifiedDiff(value, expected);
  return parsed?.additions === expected.additions && parsed.deletions === expected.deletions;
}

function expectedReadOutput(bytes: string): string {
  const lines = bytes.length === 0 ? [] : bytes.replace(/\n$/u, "").split("\n");
  return [
    `@hashline snapshot=<snapshot> sha256=${sha256(bytes).slice(0, 12)} lines=${lines.length}`,
    ...lines.map((line, index) => `${index + 1}|${line}`),
    "@eof",
  ].join("\n");
}

function isCompleteRead(value: unknown, path: string, bytes: string, limit?: number): boolean {
  const state = record(value);
  const input = record(state?.input);
  const metadata = record(state?.metadata);
  const inputKeys = limit === undefined ? ["filePath"] : ["filePath", "limit"];
  const displayedLines = bytes.length === 0 ? 0 : bytes.replace(/\n$/u, "").split("\n").length;
  return (
    state !== undefined &&
    hasExactKeys(state, ["input", "metadata", "output", "status"]) &&
    state.status === "completed" &&
    input !== undefined &&
    hasExactKeys(input, inputKeys) &&
    input.filePath === path &&
    (limit === undefined ? !("limit" in input) : input.limit === limit) &&
    metadata !== undefined &&
    hasExactKeys(metadata, ["displayedLines", "snapshotId", "truncated"]) &&
    metadata.displayedLines === displayedLines &&
    metadata.snapshotId === "<snapshot>" &&
    metadata.truncated === false &&
    state.output === expectedReadOutput(bytes)
  );
}

function isFileOperationInput(
  value: unknown,
  sourcePath: string,
  operation: "delete_file" | "move_file",
  destinationPath?: string,
): boolean {
  return sameJson(value, {
    filePath: sourcePath,
    operations: [
      operation === "delete_file" ? { op: operation } : { destinationPath, op: operation },
    ],
    snapshotId: "<snapshot>",
  });
}

function isNativeMarker(
  value: unknown,
  editTool: "edit" | "apply_patch",
  expected: OperationEvidence,
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): boolean {
  const marker = record(value);
  const markerKeys = [
    "canonicalPathSha256",
    "hostVersion",
    "operation",
    "packageVersion",
    "protocol",
    "schemaSha256",
    "surface",
    ...(expected.operation === "move_file" ? ["destinationPathSha256"] : []),
  ];
  return (
    marker !== undefined &&
    hasExactKeys(marker, markerKeys) &&
    marker.protocol === NATIVE_ALIAS_PROTOCOL &&
    marker.packageVersion === expectedPackageVersion &&
    marker.hostVersion === expectedHostVersion &&
    marker.schemaSha256 === schemaSha256 &&
    marker.surface === editTool &&
    marker.operation === expected.operation &&
    marker.canonicalPathSha256 === sha256(expected.sourcePath) &&
    (expected.operation === "move_file"
      ? marker.destinationPathSha256 === sha256(expected.destinationPath)
      : !("destinationPathSha256" in marker))
  );
}

function isNativeMetadata(
  value: unknown,
  editTool: "edit" | "apply_patch",
  expected: OperationEvidence,
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): boolean {
  const metadata = record(value);
  const diagnostics = record(metadata?.diagnostics);
  if (
    !metadata ||
    !diagnostics ||
    !hasExactKeys(diagnostics, []) ||
    metadata.truncated !== false ||
    !isNativeMarker(
      metadata.betterHashline,
      editTool,
      expected,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    )
  ) {
    return false;
  }

  if (editTool === "apply_patch") {
    if (!hasExactKeys(metadata, ["betterHashline", "diagnostics", "files", "truncated"])) {
      return false;
    }
    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const file = record(files[0]);
    const moving = expected.operation === "move_file";
    return (
      files.length === 1 &&
      file !== undefined &&
      hasExactKeys(file, [
        "additions",
        "deletions",
        "filePath",
        ...(moving ? ["movePath"] : []),
        "patch",
        "relativePath",
        "type",
      ]) &&
      file.additions === expected.additions &&
      file.deletions === expected.deletions &&
      file.filePath === expected.sourcePath &&
      file.relativePath === (moving ? expected.destinationPath : expected.sourcePath) &&
      file.type ===
        (expected.operation === "delete_file"
          ? "delete"
          : expected.operation === "move_file"
            ? "move"
            : "update") &&
      (moving ? file.movePath === expected.destinationPath : !("movePath" in file)) &&
      isExpectedPatch(file.patch, expected)
    );
  }

  if (!hasExactKeys(metadata, ["betterHashline", "diagnostics", "diff", "filediff", "truncated"])) {
    return false;
  }
  const filediff = record(metadata.filediff);
  return (
    filediff !== undefined &&
    hasExactKeys(filediff, ["additions", "deletions", "file", "patch"]) &&
    filediff.additions === expected.additions &&
    filediff.deletions === expected.deletions &&
    filediff.file === expected.sourcePath &&
    filediff.patch === metadata.diff &&
    isExpectedPatch(metadata.diff, expected)
  );
}

function isEditMetadata(
  value: unknown,
  route: VerificationCaseReport["route"],
  editTool: VerificationCaseReport["editTool"],
  expected: OperationEvidence,
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): boolean {
  const metadata = record(value);
  if (!metadata) return false;
  if (route === "hashline") {
    if (expected.operation === "update") {
      return (
        hasExactKeys(metadata, ["diff", "operationCount", "rebased", "truncated"]) &&
        metadata.operationCount === 1 &&
        metadata.rebased === false &&
        metadata.truncated === false &&
        isExpectedPatch(metadata.diff, expected)
      );
    }
    return (
      hasExactKeys(metadata, [
        ...(expected.operation === "move_file" ? ["destinationPath"] : []),
        "diff",
        "operation",
        "truncated",
      ]) &&
      metadata.operation === expected.operation &&
      metadata.truncated === false &&
      isExpectedPatch(metadata.diff, expected) &&
      (expected.operation === "move_file"
        ? metadata.destinationPath === expected.destinationPath
        : !("destinationPath" in metadata))
    );
  }
  return isNativeMetadata(
    value,
    editTool as "edit" | "apply_patch",
    expected,
    expectedPackageVersion,
    expectedHostVersion,
    schemaSha256,
  );
}

function isMalformedState(value: unknown, editTool: VerificationCaseReport["editTool"]): boolean {
  const state = record(value);
  const input =
    editTool === "apply_patch"
      ? {
          patchText: `*** Begin Patch\n*** Update File: malformed.txt\n@@\n-${PRIVATE_CANARY}\n+changed\n*** End Patch`,
        }
      : { filePath: "malformed.txt", newString: "changed", oldString: PRIVATE_CANARY };
  const rejectedField = editTool === "apply_patch" ? "patchText" : "newString";
  return (
    state !== undefined &&
    hasExactKeys(state, ["error", "input", "status"]) &&
    state.status === "error" &&
    state.error ===
      `INVALID_ARGUMENT: ${rejectedField} is not accepted by ${editTool}. No mutation occurred; a valid supplied snapshot remains usable.` &&
    sameJson(state.input, input)
  );
}

function isFileOperationState(
  value: unknown,
  route: VerificationCaseReport["route"],
  editTool: VerificationCaseReport["editTool"],
  expected: OperationEvidence,
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): boolean {
  if (expected.operation === "update") return false;
  const state = record(value);
  const sourcePath =
    expected.operation === "delete_file" ? LIFECYCLE_DELETE_PATH : LIFECYCLE_MOVE_PATH;
  const destinationPath = expected.operation === "move_file" ? LIFECYCLE_MOVED_PATH : undefined;
  const output =
    expected.operation === "delete_file"
      ? `Deleted ${expected.sourcePath}.\n${EDIT_RECEIPT}`
      : `Moved ${expected.sourcePath} to ${expected.destinationPath}.\n${EDIT_RECEIPT}`;
  return (
    state !== undefined &&
    hasExactKeys(state, ["input", "metadata", "output", "status"]) &&
    state.status === "completed" &&
    isFileOperationInput(state.input, sourcePath, expected.operation, destinationPath) &&
    state.output === output &&
    isEditMetadata(
      state.metadata,
      route,
      editTool,
      expected,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    )
  );
}

function isNoClobberState(value: unknown): boolean {
  const state = record(value);
  return (
    state !== undefined &&
    hasExactKeys(state, ["error", "input", "status"]) &&
    state.status === "error" &&
    state.error ===
      "TARGET_EXISTS: The target already exists; create and move operations never overwrite. Inspect it and choose an absent target." &&
    isFileOperationInput(
      state.input,
      LIFECYCLE_NO_CLOBBER_PATH,
      "move_file",
      LIFECYCLE_OCCUPIED_PATH,
    )
  );
}

function isFinalEditState(
  value: unknown,
  route: VerificationCaseReport["route"],
  editTool: VerificationCaseReport["editTool"],
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): boolean {
  const state = record(value);
  return (
    state !== undefined &&
    hasExactKeys(state, ["input", "metadata", "output", "status"]) &&
    state.status === "completed" &&
    sameJson(state.input, {
      filePath: PROBE_PATH,
      operations: [{ endLine: 2, lines: ["BETA"], op: "replace", startLine: 2 }],
      snapshotId: "<snapshot>",
    }) &&
    state.output === `Applied 1 operation.\n${EDIT_RECEIPT}` &&
    isEditMetadata(
      state.metadata,
      route,
      editTool,
      OPERATION_EVIDENCE.update,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    )
  );
}

function isVerificationMetadataSnapshot(
  value: unknown,
  route: VerificationCaseReport["route"],
  editTool: VerificationCaseReport["editTool"],
  expectedPackageVersion: string,
  expectedHostVersion: string,
  schemaSha256: string,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== 9 || canonicalJson(parsed) !== value)
    return false;
  const tools = [
    editTool,
    "hashline_read",
    editTool,
    "hashline_read",
    editTool,
    "hashline_read",
    editTool,
    "hashline_read",
    editTool,
  ];
  const statuses = [
    "error",
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
    "error",
    "completed",
    "completed",
  ];
  const validEnvelope = parsed.every((item, index) => {
    const event = record(item);
    const state = record(event?.state);
    return (
      event !== undefined &&
      state !== undefined &&
      hasExactKeys(event, ["state", "tool", "type"]) &&
      event.type === "tool_use" &&
      event.tool === tools[index] &&
      state.status === statuses[index]
    );
  });
  if (!validEnvelope) return false;

  const malformedState = record(record(parsed[0])?.state);
  const deleteReadState = record(record(parsed[1])?.state);
  const deleteState = record(record(parsed[2])?.state);
  const moveReadState = record(record(parsed[3])?.state);
  const moveState = record(record(parsed[4])?.state);
  const noClobberReadState = record(record(parsed[5])?.state);
  const noClobberState = record(record(parsed[6])?.state);
  const probeReadState = record(record(parsed[7])?.state);
  const editState = record(record(parsed[8])?.state);
  return (
    isMalformedState(malformedState, editTool) &&
    isCompleteRead(deleteReadState, LIFECYCLE_DELETE_PATH, LIFECYCLE_DELETE_BYTES) &&
    isFileOperationState(
      deleteState,
      route,
      editTool,
      OPERATION_EVIDENCE.delete_file,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    ) &&
    isCompleteRead(moveReadState, LIFECYCLE_MOVE_PATH, LIFECYCLE_MOVE_BYTES) &&
    isFileOperationState(
      moveState,
      route,
      editTool,
      OPERATION_EVIDENCE.move_file,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    ) &&
    isCompleteRead(noClobberReadState, LIFECYCLE_NO_CLOBBER_PATH, LIFECYCLE_NO_CLOBBER_BYTES) &&
    isNoClobberState(noClobberState) &&
    isCompleteRead(probeReadState, PROBE_PATH, INITIAL_BYTES, 3) &&
    isFinalEditState(
      editState,
      route,
      editTool,
      expectedPackageVersion,
      expectedHostVersion,
      schemaSha256,
    )
  );
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
      providerRequests: 42,
      modelRoutingVerified: true,
      editPermissionMatrixVerified: true,
      retryProviderRequests: 1,
    },
    {
      route: "native-apply-patch",
      model: "scripted/gpt-5-scripted",
      editTool: "apply_patch",
      providerRequests: 39,
      modelRoutingVerified: false,
      editPermissionMatrixVerified: true,
      retryProviderRequests: 0,
    },
    {
      route: "hashline",
      model: "scripted/scripted",
      editTool: "hashline_edit",
      providerRequests: 35,
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
      "fileOperationsVerified",
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
    report.fileOperationsVerified !== true ||
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
    openCodeProviderSchema(tool.schema.toJSONSchema(hashlineEditArgumentsSchema)),
  );
  const writeSchema = openCodeProviderSchema(
    tool.schema.toJSONSchema(hashlineWriteArgumentsSchema),
  );
  const writeSchemaRecord = record(writeSchema);
  const writeProperties = record(writeSchemaRecord?.properties);
  const writeRequired = writeSchemaRecord?.required;
  if (
    !writeSchemaRecord ||
    !writeProperties ||
    !hasExactKeys(writeProperties, ["content", "filePath"]) ||
    !sameJson(writeRequired, ["filePath", "content"])
  ) {
    throw new Error("Verifier write schema does not expose the exact create-only fields.");
  }
  const writeSchemaSha256 = jsonSha256(writeSchema);
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
        "compositionEvidence",
        "compositionEvidenceSha256",
        "editPermissionMatrixVerified",
        "editTool",
        "exportVerified",
        "fileOperationsVerified",
        "finalBytesSha256",
        "forkVerified",
        "malformedRejected",
        "metadataSnapshot",
        "metadataSnapshotSha256",
        "model",
        "modelRoutingVerified",
        "nestedCreationEvidence",
        "nestedCreationEvidenceSha256",
        "providerRequests",
        ...(native ? ["protocolFingerprint"] : []),
        "rendererSnapshot",
        "rendererSnapshotSha256",
        "readbackEvidence",
        "readbackEvidenceSha256",
        "reopenVerified",
        "retryAbortVerified",
        "retryProviderRequests",
        "route",
        "sanitizedExportVerified",
        "schemaSha256",
        "terminalRendererVerified",
        "writeSchemaSha256",
      ]) ||
      verificationCase.route !== expected.route ||
      verificationCase.model !== expected.model ||
      verificationCase.editTool !== expected.editTool ||
      verificationCase.providerRequests !== expected.providerRequests ||
      verificationCase.modelRoutingVerified !== expected.modelRoutingVerified ||
      verificationCase.editPermissionMatrixVerified !== expected.editPermissionMatrixVerified ||
      verificationCase.retryProviderRequests !== expected.retryProviderRequests ||
      verificationCase.schemaSha256 !== schemaSha256 ||
      verificationCase.writeSchemaSha256 !== writeSchemaSha256 ||
      verificationCase.finalBytesSha256 !== finalBytesSha256 ||
      verificationCase.malformedRejected !== true ||
      verificationCase.fileOperationsVerified !== true ||
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
        expectedPackageVersion,
        expectedHostVersion,
        schemaSha256,
      ) ||
      sha256(verificationCase.metadataSnapshot) !== verificationCase.metadataSnapshotSha256 ||
      !/^[a-f0-9]{64}$/u.test(String(verificationCase.nestedCreationEvidenceSha256)) ||
      !isExactEvidence(verificationCase.nestedCreationEvidence, expectedNestedCreationEvidence()) ||
      sha256(String(verificationCase.nestedCreationEvidence)) !==
        verificationCase.nestedCreationEvidenceSha256 ||
      !/^[a-f0-9]{64}$/u.test(String(verificationCase.readbackEvidenceSha256)) ||
      !isExactEvidence(
        verificationCase.readbackEvidence,
        expectedReadbackEvidence(expected.editTool),
      ) ||
      sha256(String(verificationCase.readbackEvidence)) !==
        verificationCase.readbackEvidenceSha256 ||
      !/^[a-f0-9]{64}$/u.test(String(verificationCase.compositionEvidenceSha256)) ||
      !isExactEvidence(
        verificationCase.compositionEvidence,
        expectedCompositionEvidence(expected.editTool),
      ) ||
      sha256(String(verificationCase.compositionEvidence)) !==
        verificationCase.compositionEvidenceSha256 ||
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
