import { describe, expect, test } from "bun:test";
import { inspectJsonlTrace, inspectSessionExport } from "../benchmarks/model/trace.js";

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
        { tool: "hashline_read", callID: "call-read", status: "completed" },
        { tool: "hashline_edit", callID: "call-edit", status: "error" },
      ],
      finishReasons: { stop: 1 },
      tokens: { input: 100, output: 25, reasoning: 5, cacheRead: 40, cacheWrite: 2 },
      cost: 0.0125,
    });
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
