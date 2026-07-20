import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildNativeAliasMetadata } from "../../src/presentation.js";
import topology from "./fixtures/native-alias-pilot-v1-topology.json" with { type: "json" };
import { inspectJsonlTrace, inspectNativeAliasTrace } from "./trace.js";

export type OracleFixtureReport = {
  schemaVersion: 1;
  declaredSourceTraceSha256: string;
  legacyDecision: "invalid";
  correctedDecision: "valid";
  correctedReason: "valid";
  outsideFixtureDecision: "invalid";
  forgedLocatorDecision: "invalid";
};

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
      schemaVersion: 1,
      declaredSourceTraceSha256: topology.declaredSourceTraceSha256,
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
