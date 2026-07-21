import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import {
  inspectJsonlTrace,
  inspectNativeAliasTrace,
  inspectSessionExport,
} from "../benchmarks/model/trace.js";
import { buildNativeAliasMetadata } from "../src/presentation.js";

function boundToolTrace(output: string): string {
  let index = 0;
  return output
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "tool_use" || typeof event.part !== "object" || !event.part) return line;
      const part = event.part as Record<string, unknown>;
      const state = part.state as Record<string, unknown> | undefined;
      index += 1;
      event.part = {
        id: `part-${index}`,
        sessionID: event.sessionID,
        messageID: `message-${index}`,
        type: "tool",
        ...part,
        state: state ? { input: {}, ...state } : state,
      };
      return JSON.stringify(event);
    })
    .join("\n");
}

describe("model benchmark trace inspection", () => {
  test("binds baseline read and edit targets to the allowed fixture root", () => {
    const output = boundToolTrace(
      [
        JSON.stringify({
          type: "tool_use",
          sessionID: "session",
          part: {
            sessionID: "session",
            tool: "hashline_read",
            callID: "call-read",
            state: {
              status: "completed",
              input: { filePath: "package.json" },
              metadata: { snapshotId: "snapshot-1" },
            },
          },
        }),
        JSON.stringify({
          type: "tool_use",
          sessionID: "session",
          part: {
            sessionID: "session",
            tool: "hashline_edit",
            callID: "call-edit",
            state: {
              status: "completed",
              input: {
                filePath: "package.json",
                snapshotId: "snapshot-1",
                operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["{}"] }],
              },
            },
          },
        }),
      ].join("\n"),
    );

    expect(
      inspectJsonlTrace(output, { allowedPathRoot: resolve(".") }).toolEvents.map(
        ({ tool, targetPath, snapshotId }) => ({ tool, targetPath, snapshotId }),
      ),
    ).toEqual([
      { tool: "hashline_read", targetPath: "package.json", snapshotId: "snapshot-1" },
      { tool: "hashline_edit", targetPath: "package.json", snapshotId: "snapshot-1" },
    ]);
  });

  test("leaves baseline targets outside the physical fixture unbound", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "better-hashline-trace-path-"));
    const fixture = join(temporaryRoot, "fixture");
    const outside = join(temporaryRoot, "outside");
    await mkdir(fixture);
    await mkdir(outside);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    await symlink(outside, join(fixture, "linked"), "junction");

    try {
      const inputs = [
        join(outside, "outside.txt"),
        join(fixture, "linked", "outside.txt"),
        join(fixture, "linked", "missing.txt"),
      ];
      const output = boundToolTrace(
        inputs
          .map((filePath, index) =>
            JSON.stringify({
              type: "tool_use",
              sessionID: "session",
              part: {
                sessionID: "session",
                tool: "hashline_edit",
                callID: `call-${index}`,
                state: {
                  status: "error",
                  input: { filePath },
                  error: "rejected",
                },
              },
            }),
          )
          .join("\n"),
      );

      expect(
        inspectJsonlTrace(output, { allowedPathRoot: fixture }).toolEvents.map(
          ({ targetPath }) => targetPath,
        ),
      ).toEqual([undefined, undefined, undefined]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("extracts completed tools, errors, tokens, cost, and finish reasons", () => {
    const output = boundToolTrace(
      [
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
      ].join("\n"),
    );

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
          sequence: 0,
          partID: "part-1",
          messageID: "message-1",
          tool: "hashline_read",
          callID: "call-read",
          status: "completed",
          argumentShape: "other",
          errorCode: null,
          protocolMarker: "absent",
        },
        {
          sequence: 1,
          partID: "part-2",
          messageID: "message-2",
          tool: "hashline_edit",
          callID: "call-edit",
          status: "error",
          argumentShape: "other",
          errorCode: null,
          protocolMarker: "absent",
          rebase: "none",
        },
      ],
      finishReasons: { stop: 1 },
      tokens: { input: 100, output: 25, reasoning: 5, cacheRead: 40, cacheWrite: 2 },
      cost: 0.0125,
    });
  });

  test("classifies native-shaped retries and native-alias protocol markers", () => {
    const allowedPathRoot = resolve(".");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: resolve(allowedPathRoot, "package.json"),
      relativePath: "package.json",
      unifiedDiff: "--- package.json\tbefore\n+++ package.json\tafter\n@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const output = boundToolTrace(
      [
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
      ].join("\n"),
    );

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree: allowedPathRoot },
      }).toolEvents,
    ).toEqual([
      {
        sequence: 0,
        partID: "part-1",
        messageID: "message-1",
        tool: "edit",
        callID: "native-call",
        status: "error",
        argumentShape: "native",
        errorCode: "INVALID_ARGUMENT",
        protocolMarker: "absent",
        targetPath: "a.ts",
        rebase: "none",
      },
      {
        sequence: 1,
        partID: "part-2",
        messageID: "message-2",
        tool: "edit",
        callID: "hashline-call",
        status: "completed",
        argumentShape: "better-hashline",
        errorCode: null,
        protocolMarker: "valid",
        protocolReason: "valid",
        targetPath: "package.json",
        snapshotId: "s_123",
        rebase: "none",
      },
      {
        sequence: 2,
        partID: "part-3",
        messageID: "message-3",
        tool: "apply_patch",
        callID: "bad-marker",
        status: "completed",
        argumentShape: "better-hashline",
        errorCode: null,
        protocolMarker: "invalid",
        protocolReason: "canonical-path-unreadable",
        targetPath: "a.ts",
        snapshotId: "s_123",
        rebase: "none",
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
    const output = boundToolTrace(
      JSON.stringify({
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
      }),
    );

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree: allowedPathRoot },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("invalid");
  });

  test("attests one exported drive-root worktree and correlates its terminal event", async () => {
    const worktree = parse(resolve(".")).root;
    const allowedPathRoot = resolve(".");
    const canonicalPath = resolve(allowedPathRoot, "package.json");
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
    const output = boundToolTrace(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          id: "part-call",
          sessionID: "session",
          messageID: "message-call",
          type: "tool",
          tool: "apply_patch",
          callID: "call",
          state: {
            status: "completed",
            input: {
              filePath: "package.json",
              snapshotId: "s_1234567890123456789012",
              operations: [{ op: "replace_file", lines: [] }],
            },
            output: "Applied 1 operation.",
            title: "Edit package.json",
            metadata,
            time: { start: 1, end: 2 },
          },
        },
      }),
    );

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("valid");
    const sessionExport = JSON.stringify({
      info: {
        id: "session",
        directory: allowedPathRoot,
        path: relative(worktree, allowedPathRoot).replaceAll("\\", "/"),
      },
      messages: [
        {
          info: { id: "message-call", sessionID: "session", role: "assistant" },
          parts: [JSON.parse(output).part],
        },
      ],
    });
    const trace = await inspectNativeAliasTrace(output, sessionExport, {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: worktree,
    });
    expect(trace.oracleDecision).toBe("valid");
    expect(trace.oracleReason).toBe("valid");
    expect(trace.toolEvents[0]).toMatchObject({
      protocolMarker: "valid",
      targetPath: "package.json",
    });

    const mismatchedExport = JSON.parse(sessionExport) as {
      messages: Array<{ parts: Array<{ state: Record<string, unknown> }> }>;
    };
    const mismatchedPart = mismatchedExport.messages[0]?.parts[0];
    if (!mismatchedPart) throw new Error("Expected one exported tool part");
    mismatchedPart.state.output = null;
    const mismatch = await inspectNativeAliasTrace(output, JSON.stringify(mismatchedExport), {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: worktree,
    });
    expect(mismatch.oracleReason).toBe("trace-export-mismatch");

    const malformedPart = JSON.parse(output) as { part: { type: string } };
    malformedPart.part.type = "text";
    const malformedTrace = await inspectNativeAliasTrace(
      JSON.stringify(malformedPart),
      sessionExport,
      {
        ...identity,
        allowedPathRoot,
        expectedDirectory: allowedPathRoot,
        expectedWorktree: worktree,
      },
    );
    expect(malformedTrace.oracleReason).toBe("trace-evidence-invalid");

    const erroredTrace = await inspectNativeAliasTrace(
      `${output}\n${JSON.stringify({ type: "error", sessionID: "session" })}`,
      sessionExport,
      {
        ...identity,
        allowedPathRoot,
        expectedDirectory: allowedPathRoot,
        expectedWorktree: worktree,
      },
    );
    expect(erroredTrace.oracleReason).toBe("trace-evidence-invalid");

    const pendingExport = JSON.parse(sessionExport) as {
      messages: Array<{ parts: Array<unknown> }>;
    };
    pendingExport.messages[0]?.parts.push({
      id: "part-pending",
      sessionID: "session",
      messageID: "message-call",
      type: "tool",
      tool: "read",
      callID: "call-pending",
      state: { status: "pending", input: { filePath: "package.json" }, raw: "" },
    });
    const pending = await inspectNativeAliasTrace(output, JSON.stringify(pendingExport), {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: worktree,
    });
    expect(pending.oracleDecision).toBe("invalid");
  });

  test("allows a creation-only native-alias session without an edit protocol marker", async () => {
    const worktree = parse(resolve(".")).root;
    const allowedPathRoot = resolve(".");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const output = boundToolTrace(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          tool: "hashline_write",
          callID: "call-write",
          state: {
            status: "completed",
            input: { filePath: "created.ts", content: "export {};\n" },
            output: "Created created.ts.",
            title: "Create created.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      }),
    );
    const part = (JSON.parse(output) as { part: unknown }).part;
    const sessionExport = JSON.stringify({
      info: {
        id: "session",
        directory: allowedPathRoot,
        path: relative(worktree, allowedPathRoot).replaceAll("\\", "/"),
      },
      messages: [
        {
          info: { id: "message-1", sessionID: "session", role: "assistant" },
          parts: [part],
        },
      ],
    });
    const expected = {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: worktree,
    };

    expect((await inspectNativeAliasTrace(output, sessionExport, expected)).oracleDecision).toBe(
      "invalid",
    );
    const creation = await inspectNativeAliasTrace(output, sessionExport, {
      ...expected,
      requireNativeAliasMarker: false,
    });
    expect(creation.oracleDecision).toBe("valid");
    expect(creation.toolEvents[0]).toMatchObject({
      tool: "hashline_write",
      protocolMarker: "absent",
      targetPath: "created.ts",
    });
  });

  test("binds absolute hashline paths to their physical fixture target", () => {
    const allowedPathRoot = resolve(".");
    const canonicalPath = resolve(allowedPathRoot, "package.json");
    const output = boundToolTrace(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          tool: "hashline_read",
          callID: "read-call",
          state: { status: "completed", input: { filePath: canonicalPath } },
        },
      }),
    );
    const trace = inspectJsonlTrace(output, {
      nativeAlias: {
        packageVersion: "0.3.0",
        schemaSha256: "a".repeat(64),
        hostVersion: "1.18.3",
        allowedPathRoot,
        worktree: allowedPathRoot,
      },
    });
    expect(trace.toolEvents[0]?.targetPath).toBe("package.json");
  });

  test("does not accept a fixture worktree when the export attests a broader worktree", async () => {
    const worktree = parse(resolve(".")).root;
    const allowedPathRoot = resolve(".");
    const canonicalPath = resolve(allowedPathRoot, "package.json");
    const identity = {
      packageVersion: "0.3.0",
      schemaSha256: "a".repeat(64),
      hostVersion: "1.18.3",
    };
    const metadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath,
      relativePath: "package.json",
      unifiedDiff: "--- package.json\tbefore\n+++ package.json\tafter\n@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      ...identity,
    });
    const part = {
      id: "part-call",
      sessionID: "session",
      messageID: "message-call",
      type: "tool",
      tool: "edit",
      callID: "call",
      state: {
        status: "completed",
        input: { filePath: "package.json", snapshotId: "s_123", operations: [] },
        output: "Applied 1 operation.",
        metadata,
      },
    };
    const output = JSON.stringify({ type: "tool_use", sessionID: "session", part });
    const sessionExport = JSON.stringify({
      info: {
        id: "session",
        directory: allowedPathRoot,
        path: relative(worktree, allowedPathRoot).replaceAll("\\", "/"),
      },
      messages: [
        { info: { id: "message-call", sessionID: "session", role: "assistant" }, parts: [part] },
      ],
    });

    const trace = await inspectNativeAliasTrace(output, sessionExport, {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: allowedPathRoot,
    });
    expect(trace.oracleDecision).toBe("invalid");
    expect(trace.toolEvents[0]?.protocolMarker).toBe("invalid");
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
    const output = boundToolTrace(
      JSON.stringify({
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
      }),
    );

    expect(
      inspectJsonlTrace(output, {
        nativeAlias: { ...identity, allowedPathRoot, worktree },
      }).toolEvents[0]?.protocolMarker,
    ).toBe("invalid");
  });

  test("keeps trace accounting when exported worktree attestation fails", async () => {
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
    const output = boundToolTrace(
      JSON.stringify({
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
      }),
    );

    const trace = await inspectNativeAliasTrace(output, "not json", {
      ...identity,
      allowedPathRoot,
      expectedDirectory: allowedPathRoot,
      expectedWorktree: allowedPathRoot,
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
    const terminal = boundToolTrace(
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          sessionID: "session",
          tool: "hashline_edit",
          callID: "call",
          state: { status: "completed" },
        },
      }),
    );
    expect(inspectJsonlTrace(`${terminal}\n${terminal}`).duplicateToolEvents).toBe(1);

    const exported = inspectSessionExport(
      JSON.stringify({
        info: { id: "session" },
        messages: [
          {
            info: {
              id: "message-user",
              sessionID: "session",
              role: "user",
              agent: "build",
              model: { providerID: "provider", modelID: "model" },
            },
            parts: [],
          },
          {
            info: {
              id: "message-assistant",
              sessionID: "session",
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
            parts: [
              {
                id: "part-retry",
                type: "retry",
                sessionID: "session",
                messageID: "message-assistant",
              },
            ],
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
      tools: {},
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
    expect(exported).toMatchObject({ schemaErrors: 8, messageErrors: 1 });
  });

  test("rejects negative and unsafe accounting values", () => {
    const trace = inspectJsonlTrace(
      [
        JSON.stringify({
          type: "step_finish",
          sessionID: "session",
          part: {
            reason: "stop",
            cost: -0.1,
            tokens: {
              input: -1,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session",
          part: {
            reason: "stop",
            cost: 0,
            tokens: {
              input: Number.MAX_SAFE_INTEGER,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        }),
      ].join("\n"),
    );
    expect(trace.schemaErrors).toBeGreaterThan(0);
    expect(trace.cost).toBe(0);
    expect(trace.tokens.input).toBe(Number.MAX_SAFE_INTEGER);
  });
});
