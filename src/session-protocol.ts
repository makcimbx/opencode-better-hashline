import { Buffer } from "node:buffer";
import { isAbsolute, relative } from "node:path";
import { fail } from "./errors.js";
import {
  canonicalPathSha256,
  countUnifiedDiffChanges,
  NATIVE_ALIAS_PROTOCOL,
  type NativeAliasSurface,
} from "./presentation.js";

export const SESSION_HISTORY_LIMIT = 200;
export const SESSION_HISTORY_FETCH_LIMIT = SESSION_HISTORY_LIMIT + 1;
export const SESSION_HISTORY_MAX_PARTS = 2_000;
export const SESSION_HISTORY_MAX_BYTES = 1_048_576;
export const SESSION_BINDING_LIMIT = 4_096;

export type NativeAliasProtocolIdentity = {
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
  worktree: string;
};

type HistoryOptions = {
  currentCall?: { id: string; tool: NativeAliasSurface };
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function rejectHistory(reason: string): never {
  fail("SESSION_PROTOCOL_MISMATCH", `${reason} Start a new session before editing.`);
}

function assertHistoryBounds(messagesValue: unknown): asserts messagesValue is unknown[] {
  if (!Array.isArray(messagesValue)) rejectHistory("OpenCode session history is unreadable.");
  if (messagesValue.length > SESSION_HISTORY_LIMIT) {
    rejectHistory("OpenCode session history exceeds the bounded inspection limit.");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(messagesValue);
  } catch {
    rejectHistory("OpenCode session history is unreadable.");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > SESSION_HISTORY_MAX_BYTES
  ) {
    rejectHistory("OpenCode session history exceeds the bounded inspection limit.");
  }
}

function shownPath(identity: NativeAliasProtocolIdentity, canonicalPath: string): string {
  const value = relative(identity.worktree, canonicalPath).replaceAll("\\", "/");
  if (!value || value.startsWith("../") || isAbsolute(value)) {
    rejectHistory("Completed historical alias path is outside the bound worktree.");
  }
  return value;
}

function assertPatch(patch: string, expectedPath: string): void {
  const lines = patch.split("\n");
  const oldHeader = lines.findIndex((line) => line.startsWith("--- "));
  if (
    oldHeader < 0 ||
    lines[oldHeader] !== `--- ${expectedPath}\tbefore` ||
    lines[oldHeader + 1] !== `+++ ${expectedPath}\tafter` ||
    !lines.slice(oldHeader + 2).some((line) => line.startsWith("@@ "))
  ) {
    rejectHistory("Completed historical alias patch headers are inconsistent.");
  }
  let inHunk = false;
  for (const line of lines.slice(oldHeader + 2)) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!line || !inHunk) continue;
    if (
      !(
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line === "\\ No newline at end of file"
      )
    ) {
      rejectHistory("Completed historical alias patch is malformed.");
    }
  }
}

function assertMarker(
  toolName: NativeAliasSurface,
  metadata: Record<string, unknown>,
  identity: NativeAliasProtocolIdentity,
): Record<string, unknown> {
  const marker = record(metadata.betterHashline);
  if (!marker) rejectHistory(`Completed historical ${toolName} has no Better Hashline marker.`);
  const markerKeys = Object.keys(marker).sort().join(",");
  if (
    markerKeys !== "canonicalPathSha256,hostVersion,packageVersion,protocol,schemaSha256,surface" ||
    marker.protocol !== NATIVE_ALIAS_PROTOCOL ||
    marker.packageVersion !== identity.packageVersion ||
    marker.schemaSha256 !== identity.schemaSha256 ||
    marker.hostVersion !== identity.hostVersion ||
    marker.surface !== toolName ||
    typeof marker.canonicalPathSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(marker.canonicalPathSha256)
  ) {
    rejectHistory(`Completed historical ${toolName} uses an incompatible protocol marker.`);
  }
  return marker;
}

function assertCounts(metadata: { patch: string; additions: unknown; deletions: unknown }): void {
  if (
    !Number.isSafeInteger(metadata.additions) ||
    (metadata.additions as number) < 0 ||
    !Number.isSafeInteger(metadata.deletions) ||
    (metadata.deletions as number) < 0
  ) {
    rejectHistory("Completed historical alias metadata has invalid change counts.");
  }
  const counts = countUnifiedDiffChanges(metadata.patch);
  if (metadata.additions !== counts.additions || metadata.deletions !== counts.deletions) {
    rejectHistory("Completed historical alias metadata has inconsistent change counts.");
  }
}

function assertCompletedMetadata(
  toolName: NativeAliasSurface,
  metadataValue: unknown,
  identity: NativeAliasProtocolIdentity,
): void {
  const metadata = record(metadataValue);
  const diagnostics = record(metadata?.diagnostics);
  if (!metadata || !diagnostics || Object.keys(diagnostics).length !== 0) {
    rejectHistory(`Completed historical ${toolName} metadata is unreadable.`);
  }
  const marker = assertMarker(toolName, metadata, identity);

  if (toolName === "edit") {
    const filediff = record(metadata.filediff);
    if (
      typeof metadata.diff !== "string" ||
      !filediff ||
      typeof filediff.file !== "string" ||
      typeof filediff.patch !== "string" ||
      filediff.patch !== metadata.diff
    ) {
      rejectHistory("Completed historical edit metadata is unreadable.");
    }
    assertCounts({
      patch: filediff.patch,
      additions: filediff.additions,
      deletions: filediff.deletions,
    });
    const expectedPath = shownPath(identity, filediff.file);
    assertPatch(filediff.patch, expectedPath);
    if (marker.canonicalPathSha256 !== canonicalPathSha256(filediff.file)) {
      rejectHistory("Completed historical edit path metadata is inconsistent.");
    }
    return;
  }

  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    rejectHistory("Completed historical apply_patch metadata is unreadable.");
  }
  const file = record(metadata.files[0]);
  if (
    !file ||
    typeof file.filePath !== "string" ||
    typeof file.relativePath !== "string" ||
    file.type !== "update" ||
    typeof file.patch !== "string"
  ) {
    rejectHistory("Completed historical apply_patch metadata is unreadable.");
  }
  assertCounts({ patch: file.patch, additions: file.additions, deletions: file.deletions });
  const expectedRelative = shownPath(identity, file.filePath);
  assertPatch(file.patch, expectedRelative);
  if (
    marker.canonicalPathSha256 !== canonicalPathSha256(file.filePath) ||
    file.relativePath !== expectedRelative
  ) {
    rejectHistory("Completed historical apply_patch path metadata is inconsistent.");
  }
}

function isKnownRejectedAliasCall(toolName: NativeAliasSurface, state: Record<string, unknown>) {
  const input = record(state.input);
  const expectedError = `INVALID_ARGUMENT: Invalid ${toolName} arguments.`;
  if (!input || state.error !== expectedError) return false;
  return toolName === "edit" ? "oldString" in input || "newString" in input : "patchText" in input;
}

function inspectHistory(
  messagesValue: unknown,
  identity: NativeAliasProtocolIdentity,
  options: HistoryOptions,
): void {
  if (!Array.isArray(messagesValue)) rejectHistory("OpenCode session history is unreadable.");
  if (messagesValue.length > SESSION_HISTORY_LIMIT) {
    rejectHistory("OpenCode session history exceeds the bounded inspection limit.");
  }
  const inspectedMessages: Record<string, unknown>[] = [];
  let partCount = 0;
  let currentMatches = 0;
  for (const messageValue of messagesValue) {
    const message = record(messageValue);
    if (!message || !Array.isArray(message.parts)) {
      rejectHistory("OpenCode session history is unreadable.");
    }
    const inspectedParts: unknown[] = [];
    for (const partValue of message.parts) {
      const part = record(partValue);
      if (part?.type !== "tool") {
        inspectedParts.push(partValue);
        continue;
      }
      const state = record(part.state);
      if (options.currentCall && part.callID === options.currentCall.id) {
        currentMatches += 1;
        if (
          currentMatches !== 1 ||
          part.tool !== options.currentCall.tool ||
          (state?.status !== "pending" && state?.status !== "running")
        ) {
          rejectHistory("The current alias call is ambiguous in session history.");
        }
        continue;
      }
      if (part.tool !== "hashline_edit" && part.tool !== "edit" && part.tool !== "apply_patch") {
        inspectedParts.push(partValue);
        continue;
      }
      inspectedParts.push(partValue);
      if (part.tool === "hashline_edit") {
        rejectHistory("This session contains the hashline tool surface.");
      }
      if (state?.status === "error" && isKnownRejectedAliasCall(part.tool, state)) continue;
      if (state?.status !== "completed") {
        rejectHistory(`Historical ${String(part.tool)} has an ambiguous execution state.`);
      }
      assertCompletedMetadata(part.tool, state.metadata, identity);
    }
    partCount += inspectedParts.length;
    if (partCount > SESSION_HISTORY_MAX_PARTS) {
      rejectHistory("OpenCode session history exceeds the bounded inspection limit.");
    }
    inspectedMessages.push({ ...message, parts: inspectedParts });
  }
  if (options.currentCall && currentMatches !== 1) {
    rejectHistory("The current alias call is missing from session history.");
  }
  assertHistoryBounds(inspectedMessages);
}

export function assertNativeAliasHistory(
  messagesValue: unknown,
  identity: NativeAliasProtocolIdentity,
  options: HistoryOptions = {},
): void {
  inspectHistory(messagesValue, identity, options);
}

export class NativeAliasSessionRegistry {
  readonly #bindings = new Map<string, string>();

  isBound(sessionId: string, fingerprint: string): boolean {
    const existing = this.#bindings.get(sessionId);
    if (existing !== undefined && existing !== fingerprint) {
      rejectHistory("This session is already bound to another Better Hashline protocol.");
    }
    return existing === fingerprint;
  }

  bind(sessionId: string, fingerprint: string): void {
    if (this.isBound(sessionId, fingerprint)) return;
    this.#bindings.set(sessionId, fingerprint);
    if (this.#bindings.size <= SESSION_BINDING_LIMIT) return;
    const oldest = this.#bindings.keys().next().value;
    if (oldest !== undefined) this.#bindings.delete(oldest);
  }

  clear(): void {
    this.#bindings.clear();
  }
}
