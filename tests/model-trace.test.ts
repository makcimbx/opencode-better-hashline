import { describe, expect, test } from "bun:test";
import { parse, relative, resolve } from "node:path";
import {
  inspectJsonlTrace,
  inspectNativeAliasTrace,
  inspectSessionExport,
  worktreeFromSessionExport,
} from "../benchmarks/model/trace.js";
import { buildNativeAliasMetadata } from "../src/presentation.js";

describe("model benchmark trace inspection", () => {
  test("extracts completed tools, errors, tokens, cost, and finish reasons", () => {
    const output = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "hashline_read",
          callID: "call-read",
          state: { status: "completed" },
        },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "hashline_edit",
          callID: "call-edit",
          state: { status: "error" },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session",
        part: {
          reason: "stop",
          cost: 0.0125,
          tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 40, write: 2 } },
        },
      }),
    ].join("\n");

    expect(inspectJsonlTrace(output)).toEqual({
      eventCount: 3,
      parseErrors: 0,
      schemaErrors: 0,
      duplicateToolEvents: 0,
      errorEvents: 0,
      sessionIds: ["session"],
      tools: { hashline_read: 1 },
      toolAttempts: { hashline_read: 1, hashline_edit: 1 },
      toolErrors: { hashline_edit: 1 },
      toolEvents: [
        {
          tool: "hashline_read",
          callID: "call-read",
          status: "completed",
          argumentShape: "other",
          errorCode: null,
          protocolMarker: "absent",
        },
        {
          tool: "hashline_edit",
          callID: "call-edit",
          status: "error",
          argumentShape: "other",
          errorCode: null,
          protocolMarker: "absent",
        },
      ],
      finishReasons: { stop: 1 },
      tokens: { input: 100, output: 25, reasoning: 5, cacheRead: 40, cacheWrite: 2 },
      cost: 0.0125,
    });
  });

  test("classifies native-shaped retries and native-alias protocol markers", () => {
    const allowedPathRoot = resolve("benchmark-fixture");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: resolve(allowedPathRoot, "a.ts"),
      relativePath: "a.ts",
      unifiedDiff: "--- a.ts\tbefore\n+++ a.ts\tafter\n@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "edit",
          callID: "native-call",
          state: {
            status: "error",
            input: { filePath: "a.ts", oldString: "a", newString: "b" },
            error: "INVALID_ARGUMENT: Invalid edit arguments.",
          },
        },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "edit",
          callID: "hashline-call",
          state: {
            status: "completed",
            input: { filePath: "a.ts", snapshotId: "s_123", operations: [] },
            metadata,
          },
        },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "apply_patch",
          callID: "bad-marker",
          state: {
            status: "completed",
            input: { filePath: "a.ts", snapshotId: "s_123", operations: [] },
            metadata: { betterHashline: { protocol: "native-aliases/v0" } },
          },
        },
      }),
    ].join("\n");

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree: allowedPathRoot },
      }).toolEvents,
    ).toEqual([
      {
        tool: "edit",
        callID: "native-call",
        status: "error",
        argumentShape: "native",
        errorCode: "INVALID_ARGUMENT",
        protocolMarker: "absent",
      },
      {
        tool: "edit",
        callID: "hashline-call",
        status: "completed",
        argumentShape: "better-hashline",
        errorCode: null,
        protocolMarker: "valid",
      },
      {
        tool: "apply_patch",
        callID: "bad-marker",
        status: "completed",
        argumentShape: "better-hashline",
        errorCode: null,
        protocolMarker: "invalid",
      },
    ]);
  });

  test("requires alias display paths to be relative to the exact fixture root", () => {
    const allowedPathRoot = resolve("benchmark-fixture");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: resolve(allowedPathRoot, "nested", "a.ts"),
      relativePath: "a.ts",
      unifiedDiff: "--- a.ts\tbefore\n+++ a.ts\tafter\n@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = JSON.stringify({
      type: "tool_use",
      sessionID: "session",
      part: {
        sessionID: "session",
        tool: "edit",
        callID: "call",
        state: {
          status: "completed",
          input: { filePath: "nested/a.ts", snapshotId: "s_123", operations: [] },
          metadata,
        },
      },
    });

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree: allowedPathRoot },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("invalid");
  });

  test("separates drive-root worktree paths from fixture confinement", () => {
    const worktree = parse(resolve(".")).root;
    const allowedPathRoot = resolve(worktree, "Users", "runner", "Temp", "benchmark-fixture");
    const canonicalPath = resolve(allowedPathRoot, "a.ts");
    const shownPath = relative(worktree, canonicalPath).replaceAll("\\", "/");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "apply_patch",
      canonicalPath,
      relativePath: shownPath,
      unifiedDiff: `--- ${shownPath}\tbefore\n+++ ${shownPath}\tafter\n@@ -1 +1 @@\n-a\n+b\n`,
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = JSON.stringify({
      type: "tool_use",
      sessionID: "session",
      part: {
        sessionID: "session",
        tool: "apply_patch",
        callID: "call",
        state: {
          status: "completed",
          input: { filePath: "a.ts", snapshotId: "s_123", operations: [] },
          metadata,
        },
      },
    });

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("valid");
    expect(
      worktreeFromSessionExport(
        JSON.stringify({
          info: {
            directory: allowedPathRoot,
            path: relative(worktree, allowedPathRoot).replaceAll("\\", "/"),
          },
        }),
        allowedPathRoot,
      ),
    ).toBe(worktree);
  });

  test("rejects paths outside the fixture even when they are inside the worktree", () => {
    const worktree = parse(resolve(".")).root;
    const allowedPathRoot = resolve(worktree, "Users", "runner", "fixture");
    const canonicalPath = resolve(worktree, "Users", "runner", "outside", "a.ts");
    const shownPath = relative(worktree, canonicalPath).replaceAll("\\", "/");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "apply_patch",
      canonicalPath,
      relativePath: shownPath,
      unifiedDiff: `--- ${shownPath}\tbefore\n+++ ${shownPath}\tafter\n@@ -1 +1 @@\n-a\n+b\n`,
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = JSON.stringify({
      type: "tool_use",
      sessionID: "session",
      part: {
        sessionID: "session",
        tool: "apply_patch",
        callID: "call",
        state: {
          status: "completed",
          input: { filePath: "a.ts", snapshotId: "s_123", operations: [] },
          metadata,
        },
      },
    });

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("invalid");
  });

  test("keeps trace accounting when exported worktree attestation fails", () => {
    const allowedPathRoot = resolve("benchmark-fixture");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: resolve(allowedPathRoot, "a.ts"),
      relativePath: "a.ts",
      unifiedDiff: "--- a.ts\tbefore\n+++ a.ts\tafter\n@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = JSON.stringify({
      type: "tool_use",
      sessionID: "session",
      part: {
        sessionID: "session",
        tool: "edit",
        callID: "call",
        state: {
          status: "completed",
          input: { filePath: "a.ts", snapshotId: "s_123", operations: [] },
          metadata,
        },
      },
    });

    const trace = inspectNativeAliasTrace(output, "not json", {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
    });
    expect(trace.eventCount).toBe(1);
    expect(trace.sessionIds).toEqual(["session"]);
    expect(trace.toolEvents[0]?.protocolMarker).toBe("invalid");
  });

  test("counts malformed lines without treating unrelated objects as events", () => {
    const output = ['{"type":"text","part":{"text":"done"}}', "not json", "[]", ""].join("\n");

    expect(inspectJsonlTrace(output)).toEqual({
      eventCount: 1,
      parseErrors: 1,
      schemaErrors: 0,
      duplicateToolEvents: 0,
      errorEvents: 0,
      sessionIds: [],
      tools: {},
      toolAttempts: {},
      toolErrors: {},
      toolEvents: [],
      finishReasons: {},
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    });
  });

  test("deduplicates terminal call events and inspects observed session identity", () => {
    const terminal = JSON.stringify({
      type: "tool_use",
      sessionID: "session",
      part: {
        sessionID: "session",
        tool: "hashline_edit",
        callID: "call",
        state: { status: "completed" },
      },
    });
    expect(inspectJsonlTrace(`${terminal}\n${terminal}`).duplicateToolEvents).toBe(1);

    const exported = inspectSessionExport(
      JSON.stringify({
        info: { id: "session" },
        messages: [
          {
            info: {
              role: "user",
              agent: "build",
              model: { providerID: "provider", modelID: "model" },
            },
            parts: [],
          },
          {
            info: {
              role: "assistant",
              providerID: "provider",
              modelID: "model",
              mode: "build",
              cost: 0.5,
              tokens: {
                input: 10,
                output: 4,
                reasoning: 1,
                cache: { read: 2, write: 3 },
              },
            },
            parts: [{ type: "retry" }],
          },
        ],
      }),
    );
    expect(exported).toMatchObject({
      parseError: false,
      schemaErrors: 0,
      sessionId: "session",
      userModels: { "provider/model": 1 },
      assistantModels: { "provider/model": 1 },
      agents: { build: 1 },
      modes: { build: 1 },
      retries: 1,
      tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
      cost: 0.5,
    });
  });

  test("fails closed on malformed trace and export schemas", () => {
    const trace = inspectJsonlTrace(
      [
        JSON.stringify({ type: "error", sessionID: "session" }),
        JSON.stringify({ type: "tool_use", sessionID: "session", part: {} }),
        JSON.stringify({
          type: "tool_use",
          sessionID: "session",
          part: {
            sessionID: "other",
            tool: "hashline_edit",
            callID: "call",
            state: { status: "completed" },
          },
        }),
        JSON.stringify({ type: "step_finish", sessionID: "session" }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session",
          part: { reason: 1, cost: Number.NaN, tokens: {} },
        }),
      ].join("\n"),
    );
    expect(trace).toMatchObject({
      eventCount: 5,
      schemaErrors: 6,
      errorEvents: 1,
      tools: { hashline_edit: 1 },
    });

    expect(inspectSessionExport("not json").parseError).toBeTrue();
    expect(inspectSessionExport("{}").schemaErrors).toBe(1);
    const exported = inspectSessionExport(
      JSON.stringify({
        info: { id: "session" },
        messages: [
          {},
          { info: { role: "user" }, parts: [] },
          { info: { role: "assistant", error: {} }, parts: [] },
          { info: { role: "unknown" }, parts: [] },
        ],
      }),
    );
    expect(exported).toMatchObject({ schemaErrors: 5, messageErrors: 1 });
  });
});
