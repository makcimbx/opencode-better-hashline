import { isAbsolute, relative, resolve } from "node:path";
import type { NativeAliasProtocolIdentity } from "../../src/session-protocol.js";
import { assertNativeAliasHistory } from "../../src/session-protocol.js";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolTerminalEvent {
  tool: string;
  callID: string;
  status: "completed" | "error";
  argumentShape: "better-hashline" | "native" | "hybrid" | "other";
  errorCode: string | null;
  protocolMarker: "absent" | "valid" | "invalid";
}

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
    ![tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].every(Number.isFinite)
  ) {
    return false;
  }
  target.input += tokens.input;
  target.output += tokens.output;
  target.reasoning += tokens.reasoning;
  target.cacheRead += cache.read;
  target.cacheWrite += cache.write;
  return true;
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

function protocolMarker(
  tool: string,
  metadata: unknown,
  expected: TraceInspectionOptions["nativeAlias"],
): ToolTerminalEvent["protocolMarker"] {
  const marker = object(object(metadata)?.betterHashline);
  if (!marker) return "absent";
  if (!expected || (tool !== "edit" && tool !== "apply_patch")) return "invalid";
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
      return "invalid";
    }
    const confined = relative(resolve(expected.allowedPathRoot), resolve(canonicalPath));
    if (confined.startsWith("..") || isAbsolute(confined)) return "invalid";
    const expectedShownPath = relative(
      resolve(expected.worktree),
      resolve(canonicalPath),
    ).replaceAll("\\", "/");
    if (expectedShownPath.startsWith("../") || isAbsolute(expectedShownPath)) return "invalid";
    if (shownPath !== expectedShownPath) return "invalid";
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
    return "valid";
  } catch {
    return "invalid";
  }
}

export function worktreeFromSessionExport(output: string, expectedDirectory: string): string {
  const exported = object(JSON.parse(output));
  const info = object(exported?.info);
  const directory = info?.directory;
  const path = info?.path;
  if (typeof directory !== "string" || resolve(directory) !== resolve(expectedDirectory)) {
    throw new Error("Session export directory is inconsistent.");
  }
  if (typeof path !== "string") throw new Error("Session export worktree path is unreadable.");
  const segments = path.split(/[\\/]/u).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Session export worktree path is unsafe.");
  }
  const worktree = resolve(directory, ...segments.map(() => ".."));
  if (relative(worktree, directory).replaceAll("\\", "/") !== segments.join("/")) {
    throw new Error("Session export worktree path is inconsistent.");
  }
  return worktree;
}

export function inspectNativeAliasTrace(
  output: string,
  sessionExport: string,
  expected: Omit<NonNullable<TraceInspectionOptions["nativeAlias"]>, "worktree"> & {
    expectedDirectory: string;
  },
): TraceInspection {
  try {
    const { expectedDirectory, ...identity } = expected;
    return inspectJsonlTrace(output, {
      nativeAlias: {
        ...identity,
        worktree: worktreeFromSessionExport(sessionExport, expectedDirectory),
      },
    });
  } catch {
    // Preserve accounting and classify any marker as invalid when worktree attestation fails.
    return inspectJsonlTrace(output);
  }
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
        typeof partRecord.tool !== "string" ||
        typeof partRecord.callID !== "string" ||
        (status !== "completed" && status !== "error")
      ) {
        inspection.schemaErrors += 1;
        continue;
      }
      if (
        typeof record.sessionID !== "string" ||
        (typeof partRecord.sessionID === "string" && partRecord.sessionID !== record.sessionID)
      ) {
        inspection.schemaErrors += 1;
      }
      if (terminalCalls.has(partRecord.callID)) {
        inspection.duplicateToolEvents += 1;
        continue;
      }
      terminalCalls.set(partRecord.callID, status);
      increment(inspection.toolAttempts, partRecord.tool);
      inspection.toolEvents.push({
        tool: partRecord.tool,
        callID: partRecord.callID,
        status,
        argumentShape: argumentShape(partRecord.tool, state.input),
        errorCode: errorCode(state.error),
        protocolMarker: protocolMarker(partRecord.tool, state.metadata, options.nativeAlias),
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
      if (typeof partRecord.cost === "number" && Number.isFinite(partRecord.cost)) {
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
        !Number.isFinite(messageInfo.cost)
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
      if (object(part)?.type === "retry") inspection.retries += 1;
    }
  }
  return inspection;
}
