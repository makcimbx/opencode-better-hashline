import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { exactRelativePath, physicalRelativePath } from "./path-identity.js";
import { canonicalJson } from "./presentation.js";
import { attestSessionExport } from "./session-export.js";
import type { NativeAliasProtocolIdentity } from "./session-protocol.js";
import { assertNativeAliasHistory } from "./session-protocol.js";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolTerminalEvent {
  sequence: number;
  partID: string;
  messageID: string;
  tool: string;
  callID: string;
  status: "completed" | "error";
  argumentShape: "better-hashline" | "native" | "hybrid" | "other";
  errorCode: string | null;
  protocolMarker: "absent" | "valid" | "invalid";
  protocolReason?: OracleReason;
  targetPath?: string;
  snapshotId?: string;
  rebase?: "none" | "unique";
}

export type OracleReason =
  | "not-inspected"
  | "valid"
  | "trace-session-invalid"
  | "trace-evidence-invalid"
  | "session-export-invalid"
  | "trace-export-mismatch"
  | "canonical-path-unreadable"
  | "canonical-path-outside-fixture"
  | "display-path-mismatch"
  | "protocol-history-invalid";

export interface TraceInspection {
  eventCount: number;
  parseErrors: number;
  schemaErrors: number;
  duplicateToolEvents: number;
  errorEvents: number;
  sessionIds: string[];
  tools: Record<string, number>;
  toolAttempts: Record<string, number>;
  toolErrors: Record<string, number>;
  toolEvents: ToolTerminalEvent[];
  finishReasons: Record<string, number>;
  tokens: TokenUsage;
  cost: number;
  oracleDecision?: "valid" | "invalid";
  oracleReason?: OracleReason;
}

export interface TraceInspectionOptions {
  nativeAlias?: NativeAliasProtocolIdentity & { allowedPathRoot: string };
}

export interface SessionExportInspection {
  parseError: boolean;
  schemaErrors: number;
  sessionId: string | null;
  userMessages: number;
  assistantMessages: number;
  userModels: Record<string, number>;
  assistantModels: Record<string, number>;
  agents: Record<string, number>;
  modes: Record<string, number>;
  messageErrors: number;
  retries: number;
  tokens: TokenUsage;
  cost: number;
  toolEvents: Array<{
    tool: string;
    callID: string;
    status: "completed" | "error";
  }>;
}

function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalPath(value: string): string {
  const resolved = resolve(value);
  return parse(resolved).root === resolved ? resolved : realpathSync(resolved);
}

function outside(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized === ".." || normalized.startsWith("../") || isAbsolute(relativePath);
}

function addTokens(value: unknown, target: TokenUsage): boolean {
  const tokens = object(value);
  const cache = object(tokens?.cache);
  if (
    !tokens ||
    !cache ||
    typeof tokens.input !== "number" ||
    typeof tokens.output !== "number" ||
    typeof tokens.reasoning !== "number" ||
    typeof cache.read !== "number" ||
    typeof cache.write !== "number" ||
    ![tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].every(
      (item) => Number.isSafeInteger(item) && (item as number) >= 0,
    )
  ) {
    return false;
  }
  target.input += tokens.input;
  target.output += tokens.output;
  target.reasoning += tokens.reasoning;
  target.cacheRead += cache.read;
  target.cacheWrite += cache.write;
  return Object.values(target).every(Number.isSafeInteger);
}

function argumentShape(tool: string, input: unknown): ToolTerminalEvent["argumentShape"] {
  const args = object(input);
  if (!args || (tool !== "edit" && tool !== "apply_patch" && tool !== "hashline_edit")) {
    return "other";
  }
  const betterHashline =
    typeof args.filePath === "string" &&
    typeof args.snapshotId === "string" &&
    Array.isArray(args.operations);
  const native =
    (tool === "edit" && ("oldString" in args || "newString" in args)) ||
    (tool === "apply_patch" && "patchText" in args);
  if (betterHashline && native) return "hybrid";
  if (native) return "native";
  if (betterHashline) return "better-hashline";
  return "other";
}

function argumentTargetPath(
  input: unknown,
  allowedPathRoot: string | undefined,
): string | undefined {
  if (!allowedPathRoot) {
    return undefined;
  }
  const filePath = object(input)?.filePath;
  if (typeof filePath !== "string") return undefined;
  let root: string;
  try {
    root = canonicalPathFn(allowedPathRoot);
  } catch {
    return undefined;
  }
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  let target: string;
  try {
    target = canonicalPathFn(candidate);
  } catch {
    try {
      target = join(canonicalPathFn(dirname(candidate)), basename(candidate));
    } catch {
      return undefined;
    }
  }
  const confined = exactRelativePath(root, target);
  return confined === undefined || outside(confined) ? undefined : confined.replaceAll("\\", "/");
}

function protocolMarker(
  tool: string,
  metadata: unknown,
  expected: TraceInspectionOptions["nativeAlias"],
): {
  marker: ToolTerminalEvent["protocolMarker"];
  targetPath: string | null;
  reason: OracleReason;
} {
  const marker = object(object(metadata)?.betterHashline);
  if (!marker) return { marker: "absent", targetPath: null, reason: "not-inspected" };
  if (!expected || (tool !== "edit" && tool !== "apply_patch")) {
    return { marker: "invalid", targetPath: null, reason: "protocol-history-invalid" };
  }
  try {
    const metadataRecord = object(metadata);
    const file =
      tool === "edit"
        ? object(metadataRecord?.filediff)
        : Array.isArray(metadataRecord?.files)
          ? object(metadataRecord.files[0])
          : undefined;
    const canonicalPath = tool === "edit" ? file?.file : file?.filePath;
    const patch = file?.patch;
    const shownPath =
      tool === "edit" && typeof patch === "string"
        ? /^--- ([^\t\r\n]+)\tbefore$/mu.exec(patch)?.[1]
        : file?.relativePath;
    if (
      typeof canonicalPath !== "string" ||
      typeof shownPath !== "string" ||
      isAbsolute(shownPath)
    ) {
      return { marker: "invalid", targetPath: null, reason: "canonical-path-unreadable" };
    }
    const root = canonicalPathFn(expected.allowedPathRoot);
    const target = canonicalPathFn(canonicalPath);
    const confined = physicalRelativePath(root, target);
    if (confined === undefined) {
      return { marker: "invalid", targetPath: null, reason: "canonical-path-outside-fixture" };
    }
    const expectedShownPath = physicalRelativePath(
      canonicalPathFn(expected.worktree),
      target,
    )?.replaceAll("\\", "/");
    if (!expectedShownPath || outside(expectedShownPath) || shownPath !== expectedShownPath) {
      return { marker: "invalid", targetPath: null, reason: "display-path-mismatch" };
    }
    const { allowedPathRoot: _allowedPathRoot, ...identity } = expected;
    assertNativeAliasHistory(
      [
        {
          parts: [
            {
              type: "tool",
              tool,
              callID: "benchmark-trace",
              state: { status: "completed", metadata },
            },
          ],
        },
      ],
      identity,
    );
    return {
      marker: "valid",
      targetPath: confined.replaceAll("\\", "/"),
      reason: "valid",
    };
  } catch {
    return { marker: "invalid", targetPath: null, reason: "protocol-history-invalid" };
  }
}

const canonicalPathFn = canonicalPath;

function terminalProjection(part: Record<string, unknown>): string {
  const state = object(part.state);
  if (
    !state ||
    part.type !== "tool" ||
    typeof part.id !== "string" ||
    typeof part.sessionID !== "string" ||
    typeof part.messageID !== "string" ||
    typeof part.callID !== "string" ||
    typeof part.tool !== "string" ||
    (state.status !== "completed" && state.status !== "error") ||
    !object(state.input)
  ) {
    throw new Error("Terminal tool part is unreadable.");
  }
  return canonicalJson(part);
}

function traceTerminalParts(output: string): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = object(JSON.parse(line));
    if (event?.type !== "tool_use") continue;
    const part = object(event.part);
    if (part?.type !== "tool" || part.sessionID !== event.sessionID) {
      throw new Error("Trace tool part is unbound.");
    }
    parts.push(part);
  }
  return parts;
}

function exportTerminalParts(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const message of messages) {
    const messageInfo = object(message.info);
    if (messageInfo?.error !== undefined) throw new Error("Session export contains an error.");
    for (const value of message.parts as unknown[]) {
      const part = object(value);
      if (part?.type === "retry") throw new Error("Session export contains a retry.");
      if (part?.type !== "tool") continue;
      const status = object(part.state)?.status;
      if (status !== "completed" && status !== "error") {
        throw new Error("Session export contains a nonterminal tool.");
      }
      terminalProjection(part);
      parts.push(part);
    }
  }
  return parts;
}

function traceEvidenceInvalid(inspection: TraceInspection): boolean {
  return (
    inspection.parseErrors !== 0 ||
    inspection.schemaErrors !== 0 ||
    inspection.duplicateToolEvents !== 0 ||
    inspection.errorEvents !== 0
  );
}

function assertTerminalCorrelation(
  traceParts: Record<string, unknown>[],
  exportedParts: Record<string, unknown>[],
): void {
  const trace = traceParts.map(terminalProjection).sort();
  const exported = exportedParts.map(terminalProjection).sort();
  if (canonicalJson(trace) !== canonicalJson(exported)) {
    throw new Error("Trace and export terminal tools are inconsistent.");
  }
}

export async function inspectNativeAliasTrace(
  output: string,
  sessionExport: string,
  expected: Omit<NonNullable<TraceInspectionOptions["nativeAlias"]>, "worktree"> & {
    expectedDirectory: string;
    expectedWorktree: string;
  },
): Promise<TraceInspection> {
  const accounting = inspectJsonlTrace(output);
  const { expectedDirectory, expectedWorktree, ...identity } = expected;
  if (accounting.sessionIds.length !== 1) {
    return { ...accounting, oracleDecision: "invalid", oracleReason: "trace-session-invalid" };
  }
  if (traceEvidenceInvalid(accounting)) {
    return { ...accounting, oracleDecision: "invalid", oracleReason: "trace-evidence-invalid" };
  }
  try {
    const attested = await attestSessionExport(
      sessionExport,
      expectedDirectory,
      accounting.sessionIds[0] as string,
      expectedWorktree,
    );
    return await inspectAttestedNativeAliasTrace(output, accounting, identity, attested);
  } catch {
    return { ...accounting, oracleDecision: "invalid", oracleReason: "session-export-invalid" };
  }
}

async function inspectAttestedNativeAliasTrace(
  output: string,
  accounting: TraceInspection,
  identity: Omit<NonNullable<TraceInspectionOptions["nativeAlias"]>, "worktree">,
  attested: Awaited<ReturnType<typeof attestSessionExport>>,
): Promise<TraceInspection> {
  try {
    assertTerminalCorrelation(traceTerminalParts(output), exportTerminalParts(attested.messages));
  } catch {
    return { ...accounting, oracleDecision: "invalid", oracleReason: "trace-export-mismatch" };
  }
  try {
    assertNativeAliasHistory(
      attested.messages,
      { ...identity, worktree: attested.worktree },
      { sessionId: attested.sessionId, directory: attested.directory },
    );
  } catch {
    return { ...accounting, oracleDecision: "invalid", oracleReason: "protocol-history-invalid" };
  }
  const inspection = inspectJsonlTrace(output, {
    nativeAlias: { ...identity, worktree: attested.worktree },
  });
  if (traceEvidenceInvalid(inspection)) {
    return { ...inspection, oracleDecision: "invalid", oracleReason: "trace-evidence-invalid" };
  }
  const invalid = inspection.toolEvents.find((event) => event.protocolMarker === "invalid");
  if (invalid) {
    return {
      ...inspection,
      oracleDecision: "invalid",
      oracleReason: invalid.protocolReason ?? "protocol-history-invalid",
    };
  }
  if (!inspection.toolEvents.some((event) => event.protocolMarker === "valid")) {
    return { ...inspection, oracleDecision: "invalid", oracleReason: "protocol-history-invalid" };
  }
  return { ...inspection, oracleDecision: "valid", oracleReason: "valid" };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "string") return null;
  return /^([A-Z][A-Z_]+):/u.exec(error)?.[1] ?? null;
}

export function inspectJsonlTrace(
  output: string,
  options: TraceInspectionOptions = {},
): TraceInspection {
  const inspection: TraceInspection = {
    eventCount: 0,
    parseErrors: 0,
    schemaErrors: 0,
    duplicateToolEvents: 0,
    errorEvents: 0,
    sessionIds: [],
    tools: {},
    toolAttempts: {},
    toolErrors: {},
    toolEvents: [],
    finishReasons: {},
    tokens: emptyTokens(),
    cost: 0,
  };
  const sessionIds = new Set<string>();
  const terminalCalls = new Map<string, "completed" | "error">();

  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      inspection.parseErrors += 1;
      continue;
    }
    const record = object(event);
    if (!record) continue;
    inspection.eventCount += 1;
    if (typeof record.sessionID === "string") sessionIds.add(record.sessionID);
    if (record.type === "error") inspection.errorEvents += 1;

    const partRecord = object(record.part);
    if (record.type === "tool_use") {
      const state = object(partRecord?.state);
      const status = state?.status;
      if (
        !partRecord ||
        !state ||
        partRecord.type !== "tool" ||
        typeof partRecord.id !== "string" ||
        !partRecord.id ||
        typeof partRecord.sessionID !== "string" ||
        !partRecord.sessionID ||
        typeof partRecord.messageID !== "string" ||
        !partRecord.messageID ||
        typeof partRecord.tool !== "string" ||
        !partRecord.tool ||
        typeof partRecord.callID !== "string" ||
        !partRecord.callID ||
        !object(state.input) ||
        (status !== "completed" && status !== "error")
      ) {
        inspection.schemaErrors += 1;
        continue;
      }
      if (typeof record.sessionID !== "string" || partRecord.sessionID !== record.sessionID) {
        inspection.schemaErrors += 1;
      }
      const terminalKey = canonicalJson([
        partRecord.sessionID,
        partRecord.messageID,
        partRecord.callID,
      ]);
      if (terminalCalls.has(terminalKey)) {
        inspection.duplicateToolEvents += 1;
        continue;
      }
      terminalCalls.set(terminalKey, status);
      increment(inspection.toolAttempts, partRecord.tool);
      const protocol = protocolMarker(partRecord.tool, state.metadata, options.nativeAlias);
      const targetPath =
        protocol.targetPath ??
        argumentTargetPath(state.input, options.nativeAlias?.allowedPathRoot);
      const input = object(state.input);
      const metadata = object(state.metadata);
      const snapshotId =
        partRecord.tool === "hashline_read" ? metadata?.snapshotId : input?.snapshotId;
      const rebase = input?.rebase === "unique" ? "unique" : "none";
      inspection.toolEvents.push({
        sequence: inspection.toolEvents.length,
        partID: partRecord.id,
        messageID: partRecord.messageID,
        tool: partRecord.tool,
        callID: partRecord.callID,
        status,
        argumentShape: argumentShape(partRecord.tool, state.input),
        errorCode: errorCode(state.error),
        protocolMarker: protocol.marker,
        ...(protocol.marker === "absent" ? {} : { protocolReason: protocol.reason }),
        ...(targetPath === undefined ? {} : { targetPath }),
        ...(typeof snapshotId === "string" ? { snapshotId } : {}),
        ...(["edit", "apply_patch", "hashline_edit"].includes(partRecord.tool) ? { rebase } : {}),
      });
      if (status === "completed") increment(inspection.tools, partRecord.tool);
      else increment(inspection.toolErrors, partRecord.tool);
      continue;
    }

    if (record.type === "step_finish") {
      if (!partRecord || typeof record.sessionID !== "string") {
        inspection.schemaErrors += 1;
        continue;
      }
      if (typeof partRecord.reason === "string") {
        increment(inspection.finishReasons, partRecord.reason);
      } else {
        inspection.schemaErrors += 1;
      }
      if (
        typeof partRecord.cost === "number" &&
        Number.isFinite(partRecord.cost) &&
        partRecord.cost >= 0 &&
        Number.isFinite(inspection.cost + partRecord.cost)
      ) {
        inspection.cost += partRecord.cost;
      } else {
        inspection.schemaErrors += 1;
      }
      if (!addTokens(partRecord.tokens, inspection.tokens)) inspection.schemaErrors += 1;
    }
  }
  inspection.sessionIds = [...sessionIds].sort();
  return inspection;
}

export function inspectSessionExport(output: string): SessionExportInspection {
  const inspection: SessionExportInspection = {
    parseError: false,
    schemaErrors: 0,
    sessionId: null,
    userMessages: 0,
    assistantMessages: 0,
    userModels: {},
    assistantModels: {},
    agents: {},
    modes: {},
    messageErrors: 0,
    retries: 0,
    tokens: emptyTokens(),
    cost: 0,
    toolEvents: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    inspection.parseError = true;
    return inspection;
  }
  const root = object(parsed);
  const info = object(root?.info);
  if (!root || !info || typeof info.id !== "string" || !Array.isArray(root.messages)) {
    inspection.schemaErrors += 1;
    return inspection;
  }
  inspection.sessionId = info.id;

  for (const message of root.messages) {
    const record = object(message);
    const messageInfo = object(record?.info);
    if (!record || !messageInfo || !Array.isArray(record.parts)) {
      inspection.schemaErrors += 1;
      continue;
    }
    if (messageInfo.sessionID !== inspection.sessionId) inspection.schemaErrors += 1;
    if (messageInfo.role === "user") {
      const model = object(messageInfo.model);
      if (
        typeof messageInfo.agent !== "string" ||
        !model ||
        typeof model.providerID !== "string" ||
        typeof model.modelID !== "string"
      ) {
        inspection.schemaErrors += 1;
      } else {
        inspection.userMessages += 1;
        increment(inspection.agents, messageInfo.agent);
        increment(inspection.userModels, `${model.providerID}/${model.modelID}`);
      }
    } else if (messageInfo.role === "assistant") {
      if (
        typeof messageInfo.providerID !== "string" ||
        typeof messageInfo.modelID !== "string" ||
        typeof messageInfo.mode !== "string" ||
        typeof messageInfo.cost !== "number" ||
        !Number.isFinite(messageInfo.cost) ||
        messageInfo.cost < 0 ||
        !Number.isFinite(inspection.cost + messageInfo.cost)
      ) {
        inspection.schemaErrors += 1;
      } else {
        inspection.assistantMessages += 1;
        increment(inspection.assistantModels, `${messageInfo.providerID}/${messageInfo.modelID}`);
        increment(inspection.modes, messageInfo.mode);
        inspection.cost += messageInfo.cost;
      }
      if (messageInfo.error !== undefined) inspection.messageErrors += 1;
      if (!addTokens(messageInfo.tokens, inspection.tokens)) inspection.schemaErrors += 1;
    } else {
      inspection.schemaErrors += 1;
    }

    for (const part of record.parts) {
      const partRecord = object(part);
      if (partRecord?.sessionID !== inspection.sessionId) inspection.schemaErrors += 1;
      if (partRecord?.type === "retry") inspection.retries += 1;
      if (partRecord?.type === "tool") {
        const state = object(partRecord.state);
        if (
          typeof partRecord.tool !== "string" ||
          typeof partRecord.callID !== "string" ||
          (state?.status !== "completed" && state?.status !== "error")
        ) {
          inspection.schemaErrors += 1;
        } else {
          inspection.toolEvents.push({
            tool: partRecord.tool,
            callID: partRecord.callID,
            status: state.status,
          });
        }
      }
    }
  }
  return inspection;
}

export function terminalSkeletonMatches(
  trace: TraceInspection,
  exported: SessionExportInspection,
): boolean {
  const traceEvents = trace.toolEvents
    .map(({ tool, callID, status }) => ({ tool, callID, status }))
    .sort((left, right) => left.callID.localeCompare(right.callID));
  const exportEvents = [...exported.toolEvents].sort((left, right) =>
    left.callID.localeCompare(right.callID),
  );
  return canonicalJson(traceEvents) === canonicalJson(exportEvents);
}
