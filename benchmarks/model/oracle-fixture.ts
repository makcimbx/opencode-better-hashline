import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildNativeAliasMetadata } from "../../src/presentation.js";
import topology from "./fixtures/native-alias-worktree-topology.json" with { type: "json" };
import { inspectJsonlTrace, inspectNativeAliasTrace } from "./trace.js";

export type OracleFixtureReport = {
  schemaVersion: 2;
  hostVersion: string;
  legacyDecision: "invalid";
  correctedDecision: "valid";
  correctedReason: "valid";
  outsideFixtureDecision: "invalid";
  forgedLocatorDecision: "invalid";
};

const MAX_PRIVACY_JSON_CHARACTERS = 16 * 1024 * 1024;
const MAX_PRIVACY_JSON_VALUES = 100_000;
const MAX_PRIVACY_PATHS = 16;
const MAX_PRIVACY_PATH_CHARACTERS = 64 * 1024;
const MAX_PRIVACY_PERCENT_DECODE_PASSES = 4;
const MAX_PRIVACY_SCANNED_CHARACTERS =
  MAX_PRIVACY_JSON_CHARACTERS * (MAX_PRIVACY_PERCENT_DECODE_PASSES + 1);
const MAX_PRIVACY_MATCH_CHARACTERS = 512 * 1024 * 1024;
const PERCENT_ENCODED_OCTETS = /(?:%[0-9A-Fa-f]{2})+/gu;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u;
const PATH_BOUNDARY_CHARACTERS = "\\/\"'`=<>()[\\]{},:;!?&#|";

type SensitivePathPattern = {
  value: string;
  windows: boolean;
};

function pathsWithinPrivacyBounds(paths: readonly string[]): boolean {
  if (paths.length === 0 || paths.length > MAX_PRIVACY_PATHS) return false;
  let characters = 0;
  for (const path of paths) {
    if (!path || path.includes("\0")) return false;
    characters += path.length;
    if (characters > MAX_PRIVACY_PATH_CHARACTERS) return false;
  }
  return true;
}

export async function resolveSensitivePathAliases(paths: readonly string[]): Promise<string[]> {
  if (!pathsWithinPrivacyBounds(paths)) {
    throw new Error("Sensitive path aliases exceed the privacy verification limits.");
  }
  const aliases = new Set<string>();
  try {
    for (const path of paths) {
      aliases.add(path);
      aliases.add(await realpath(path));
      if (aliases.size > MAX_PRIVACY_PATHS) throw new Error();
    }
  } catch {
    throw new Error("Sensitive path aliases could not be resolved within privacy limits.");
  }
  const result = [...aliases];
  if (!pathsWithinPrivacyBounds(result)) {
    throw new Error("Sensitive path aliases exceed the privacy verification limits.");
  }
  return result;
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/+/gu, "/").toLowerCase();
}

function sensitivePathPatterns(paths: readonly string[]): SensitivePathPattern[] | undefined {
  if (!pathsWithinPrivacyBounds(paths)) return undefined;
  const patterns = new Map<string, SensitivePathPattern>();
  const add = (value: string, windows: boolean) => {
    if (!value) return;
    patterns.set(`${windows ? "windows" : "literal"}:${value}`, { value, windows });
  };
  for (const path of paths) {
    const windows = process.platform === "win32" || WINDOWS_ABSOLUTE_PATH.test(path);
    if (!windows) {
      add(path, false);
      continue;
    }
    const normalized = normalizeWindowsPath(path);
    add(normalized, true);
    if (normalized.startsWith("/?/unc/")) add(`/${normalized.slice(7)}`, true);
    else if (normalized.startsWith("/?/")) add(normalized.slice(3), true);
  }
  return [...patterns.values()];
}

function decodePercentOctets(value: string): string {
  return value.replace(PERCENT_ENCODED_OCTETS, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function decodedPercentForms(value: string): string[] | undefined {
  const forms = [value];
  let current = value;
  for (let pass = 0; pass < MAX_PRIVACY_PERCENT_DECODE_PASSES; pass += 1) {
    const decoded = decodePercentOctets(current);
    if (decoded === current) return forms;
    forms.push(decoded);
    current = decoded;
  }
  return decodePercentOctets(current) === current ? forms : undefined;
}

function isPathBoundary(value: string | undefined): boolean {
  return value === undefined || /\s/u.test(value) || PATH_BOUNDARY_CHARACTERS.includes(value);
}

function isFileUrlPathStart(value: string, index: number, path: string): boolean {
  if (!path.startsWith("/")) return false;
  const prefix = value.slice(0, index).toLowerCase();
  const schemeIndex = prefix.lastIndexOf("file://");
  return schemeIndex !== -1 && !prefix.slice(schemeIndex + "file://".length).includes("/");
}

function containsBoundedPath(value: string, path: string): boolean {
  let offset = 0;
  while (offset <= value.length - path.length) {
    const index = value.indexOf(path, offset);
    if (index === -1) return false;
    if (
      (isPathBoundary(index === 0 ? undefined : value[index - 1]) ||
        isFileUrlPathStart(value, index, path)) &&
      (path.endsWith("/") ||
        isPathBoundary(
          index + path.length === value.length ? undefined : value[index + path.length],
        ))
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function containsSensitivePath(
  value: string,
  patterns: readonly SensitivePathPattern[],
  budget: { scannedCharacters: number; matchCharacters: number },
): boolean | undefined {
  const forms = decodedPercentForms(value);
  if (!forms) return undefined;
  for (const form of forms) {
    budget.scannedCharacters += form.length;
    budget.matchCharacters += form.length * patterns.length;
    if (
      budget.scannedCharacters > MAX_PRIVACY_SCANNED_CHARACTERS ||
      budget.matchCharacters > MAX_PRIVACY_MATCH_CHARACTERS
    ) {
      return undefined;
    }
    const literal = form.replaceAll("\\/", "/");
    const windows = normalizeWindowsPath(form);
    for (const pattern of patterns) {
      if (containsBoundedPath(pattern.windows ? windows : literal, pattern.value)) return true;
    }
  }
  return false;
}

export function excludesSensitiveJsonPaths(value: string, paths: readonly string[]): boolean {
  if (value.length > MAX_PRIVACY_JSON_CHARACTERS) return false;
  const sensitivePaths = sensitivePathPatterns(paths);
  if (!sensitivePaths) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }

  const pending: unknown[] = [parsed];
  let inspectedValues = 0;
  let decodedCharacters = 0;
  const budget = { scannedCharacters: 0, matchCharacters: 0 };
  while (pending.length > 0) {
    inspectedValues += 1;
    if (inspectedValues > MAX_PRIVACY_JSON_VALUES) return false;
    const current = pending.pop();
    if (typeof current === "string") {
      decodedCharacters += current.length;
      if (decodedCharacters > MAX_PRIVACY_JSON_CHARACTERS) return false;
      if (containsSensitivePath(current, sensitivePaths, budget) !== false) return false;
    } else if (Array.isArray(current)) {
      if (inspectedValues + pending.length + current.length > MAX_PRIVACY_JSON_VALUES) return false;
      for (const value of current) pending.push(value);
    } else if (current !== null && typeof current === "object") {
      const entries = Object.entries(current);
      if (inspectedValues + pending.length + entries.length * 2 > MAX_PRIVACY_JSON_VALUES) {
        return false;
      }
      for (const [key, value] of entries) {
        pending.push(key, value);
      }
    }
  }
  return true;
}

function terminalPart(metadata: Record<string, unknown>, canonicalPath: string) {
  return {
    id: "part-call",
    sessionID: "session",
    messageID: "message-call",
    type: "tool",
    tool: "apply_patch",
    callID: "call",
    state: {
      status: "completed",
      input: {
        filePath: canonicalPath,
        snapshotId: "s_1234567890123456789012",
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["after"] }],
      },
      output: "Applied 1 operation.",
      title: "Patch fixture",
      metadata,
      time: { start: 1, end: 2 },
    },
  };
}

export async function verifyNativeAliasOracleFixture(identity: {
  packageVersion: string;
  schemaSha256: string;
  hostVersion: string;
}): Promise<OracleFixtureReport> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-oracle-")));
  try {
    const fixture = resolve(temporary, ...topology.fixtureSegments);
    const canonicalPath = resolve(fixture, topology.filePath);
    await mkdir(resolve(canonicalPath, ".."), { recursive: true });
    await writeFile(canonicalPath, "before\n");
    const shownPath = relative(temporary, canonicalPath).replaceAll("\\", "/");
    const patch = `--- ${shownPath}\tbefore\n+++ ${shownPath}\tafter\n@@ -1 +1 @@\n-before\n+after\n`;
    const metadata = buildNativeAliasMetadata({
      surface: "apply_patch",
      canonicalPath,
      relativePath: shownPath,
      unifiedDiff: patch,
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const part = terminalPart(metadata, canonicalPath);
    const trace = JSON.stringify({ type: "tool_use", sessionID: "session", part });
    const exported = JSON.stringify({
      info: {
        id: "session",
        directory: fixture,
        path: relative(temporary, fixture).replaceAll("\\", "/"),
      },
      messages: [
        { info: { id: "message-call", sessionID: "session", role: "assistant" }, parts: [part] },
      ],
    });

    const legacy = inspectJsonlTrace(trace, {
      nativeAlias: { ...identity, allowedPathRoot: fixture, worktree: fixture },
    });
    const corrected = await inspectNativeAliasTrace(trace, exported, {
      ...identity,
      allowedPathRoot: fixture,
      expectedDirectory: fixture,
      expectedWorktree: temporary,
    });

    const outsidePath = resolve(temporary, "outside.ts");
    await writeFile(outsidePath, "outside\n");
    const outsideShown = relative(temporary, outsidePath).replaceAll("\\", "/");
    const outsideMetadata = buildNativeAliasMetadata({
      surface: "apply_patch",
      canonicalPath: outsidePath,
      relativePath: outsideShown,
      unifiedDiff: `--- ${outsideShown}\tbefore\n+++ ${outsideShown}\tafter\n@@ -1 +1 @@\n-a\n+b\n`,
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const outside = inspectJsonlTrace(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: terminalPart(outsideMetadata, outsidePath),
      }),
      { nativeAlias: { ...identity, allowedPathRoot: fixture, worktree: temporary } },
    );
    const forged = await inspectNativeAliasTrace(
      trace,
      exported.replace(
        relative(temporary, fixture).replaceAll("\\", "/"),
        `${relative(temporary, fixture).replaceAll("\\", "/")}/../forged`,
      ),
      {
        ...identity,
        allowedPathRoot: fixture,
        expectedDirectory: fixture,
        expectedWorktree: temporary,
      },
    );

    if (
      legacy.toolEvents[0]?.protocolMarker !== topology.legacyDecision ||
      corrected.oracleDecision !== topology.correctedDecision ||
      corrected.oracleReason !== "valid" ||
      outside.toolEvents[0]?.protocolMarker !== "invalid" ||
      forged.oracleDecision !== "invalid"
    ) {
      throw new Error("Native-alias oracle fixture did not meet its frozen decisions.");
    }
    return {
      schemaVersion: 2,
      hostVersion: identity.hostVersion,
      legacyDecision: "invalid",
      correctedDecision: "valid",
      correctedReason: "valid",
      outsideFixtureDecision: "invalid",
      forgedLocatorDecision: "invalid",
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
