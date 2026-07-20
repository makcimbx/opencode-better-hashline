import { Buffer } from "node:buffer";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve } from "node:path";

export const SESSION_EXPORT_MAX_BYTES = 16 * 1_048_576;
export const SESSION_EXPORT_MAX_MESSAGES = 128;
export const SESSION_EXPORT_MAX_PARTS = 4_096;

export type AttestedSessionExport = {
  sessionId: string;
  directory: string;
  worktree: string;
  messages: Record<string, unknown>[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseLocator(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Session export worktree locator is unreadable.");
  if (value === "") return [];
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    throw new Error("Session export worktree locator is not normalized.");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    (process.platform === "win32" && segments.some((segment) => segment.includes(":")))
  ) {
    throw new Error("Session export worktree locator is unsafe.");
  }
  return segments;
}

async function physicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  return parse(resolved).root === resolved ? resolved : realpath(resolved);
}

export async function attestSessionExport(
  output: string,
  expectedDirectory: string,
  expectedSessionId: string,
  expectedWorktree: string,
): Promise<AttestedSessionExport> {
  if (Buffer.byteLength(output, "utf8") > SESSION_EXPORT_MAX_BYTES) {
    throw new Error("Session export exceeds the bounded inspection limit.");
  }
  const exported = record(JSON.parse(output));
  const info = record(exported?.info);
  if (!exported || !info || !Array.isArray(exported.messages)) {
    throw new Error("Session export is unreadable.");
  }
  if (info.id !== expectedSessionId) throw new Error("Session export ID does not match the trace.");
  if (typeof info.directory !== "string")
    throw new Error("Session export directory is unreadable.");
  const canonicalDirectory = await physicalPath(info.directory);
  const canonicalExpectedDirectory = await physicalPath(expectedDirectory);
  const [directoryIdentity, expectedIdentity] = await Promise.all([
    stat(canonicalDirectory),
    stat(canonicalExpectedDirectory),
  ]);
  const stableIdentity = directoryIdentity.ino !== 0 && expectedIdentity.ino !== 0;
  const sameCanonicalPath = canonicalDirectory === canonicalExpectedDirectory;
  if (
    stableIdentity
      ? directoryIdentity.dev !== expectedIdentity.dev ||
        directoryIdentity.ino !== expectedIdentity.ino
      : !sameCanonicalPath
  ) {
    throw new Error("Session export directory is inconsistent.");
  }

  const locator = parseLocator(info.path);
  const candidate = resolve(canonicalDirectory, ...locator.map(() => ".."));
  const worktree = await physicalPath(candidate);
  if (relative(worktree, canonicalDirectory).replaceAll("\\", "/") !== locator.join("/")) {
    throw new Error("Session export worktree locator is inconsistent.");
  }
  const canonicalExpectedWorktree = await physicalPath(expectedWorktree);
  const [worktreeIdentity, expectedWorktreeIdentity] = await Promise.all([
    stat(worktree),
    stat(canonicalExpectedWorktree),
  ]);
  const stableWorktreeIdentity = worktreeIdentity.ino !== 0 && expectedWorktreeIdentity.ino !== 0;
  if (
    stableWorktreeIdentity
      ? worktreeIdentity.dev !== expectedWorktreeIdentity.dev ||
        worktreeIdentity.ino !== expectedWorktreeIdentity.ino
      : worktree !== canonicalExpectedWorktree
  ) {
    throw new Error("Session export worktree is inconsistent.");
  }

  if (exported.messages.length > SESSION_EXPORT_MAX_MESSAGES) {
    throw new Error("Session export exceeds the bounded inspection limit.");
  }
  let partCount = 0;
  const messages = exported.messages.map((messageValue) => {
    const message = record(messageValue);
    const messageInfo = record(message?.info);
    if (!message || !messageInfo || !Array.isArray(message.parts)) {
      throw new Error("Session export message history is unreadable.");
    }
    if (typeof messageInfo.id !== "string" || !messageInfo.id) {
      throw new Error("Session export message identity is unreadable.");
    }
    if (messageInfo.sessionID !== expectedSessionId) {
      throw new Error("Session export message belongs to another session.");
    }
    partCount += message.parts.length;
    if (partCount > SESSION_EXPORT_MAX_PARTS) {
      throw new Error("Session export exceeds the bounded inspection limit.");
    }
    for (const partValue of message.parts) {
      const part = record(partValue);
      if (
        !part ||
        typeof part.id !== "string" ||
        !part.id ||
        part.sessionID !== expectedSessionId ||
        part.messageID !== messageInfo.id
      ) {
        throw new Error("Session export part belongs to another session.");
      }
    }
    return message;
  });

  return {
    sessionId: expectedSessionId,
    directory: canonicalDirectory,
    worktree: canonicalExpectedWorktree,
    messages,
  };
}
