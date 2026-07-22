import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import { openCodeProviderSchema } from "../src/native-alias.js";
import {
  betterHashlinePlugin,
  hashlineEditArgumentsSchema,
  hashlineEditDescription,
  nativeAliasEditDescription,
} from "../src/plugin.js";
import {
  buildNativeAliasMetadata,
  jsonSha256,
  NATIVE_ALIAS_PROTOCOL,
} from "../src/presentation.js";
import { PACKAGE_VERSION } from "../src/version.js";

type StructuredResult = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

type AskRecord = {
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
};

type AliasHarnessOptions = {
  hostVersion?: string;
  healthStatus?: number;
  history?: unknown | ((sessionId: string) => unknown);
  historyError?: boolean;
  pluginOptions?: Record<string, unknown>;
  worktree?: string;
};

let root = "";
let values: Hooks[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-alias-")));
  values = [];
});

afterEach(async () => {
  await Promise.all(values.map(async (value) => value.dispose?.()));
  await rm(root, { recursive: true, force: true });
});

function structured(result: unknown): StructuredResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("output" in result) ||
    typeof result.output !== "string"
  ) {
    throw new Error("Expected a structured tool result");
  }
  return {
    title: "title" in result && typeof result.title === "string" ? result.title : "",
    output: result.output,
    metadata:
      "metadata" in result && result.metadata ? (result.metadata as Record<string, unknown>) : {},
  };
}

function context(
  input: {
    sessionID?: string;
    asks?: AskRecord[];
    metadata?: Array<Record<string, unknown>>;
    denyEdit?: boolean;
    worktree?: string;
    onAsk?: (request: AskRecord) => Promise<void> | void;
  } = {},
): ToolContext {
  return {
    sessionID: input.sessionID ?? `session-${randomUUID()}`,
    messageID: "message",
    agent: "build",
    directory: root,
    worktree: input.worktree ?? root,
    abort: new AbortController().signal,
    metadata(value) {
      input.metadata?.push(value as Record<string, unknown>);
    },
    async ask(request) {
      const value = request as AskRecord;
      input.asks?.push(value);
      await input.onAsk?.(value);
      if (input.denyEdit && request.permission === "edit") throw new Error("edit denied");
    },
  } as ToolContext;
}

async function aliasHarness(options: AliasHarnessOptions = {}) {
  const historyCalls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") {
        return Response.json(
          { healthy: true, version: options.hostVersion ?? "1.18.3" },
          { status: options.healthStatus ?? 200 },
        );
      }
      const match = /^\/session\/(.+)\/message$/u.exec(url.pathname);
      if (!match?.[1]) return new Response("not found", { status: 404 });
      const sessionId = decodeURIComponent(match[1]);
      historyCalls.push(sessionId);
      if (options.historyError) return new Response("unavailable", { status: 500 });
      const history =
        typeof options.history === "function"
          ? options.history(sessionId)
          : (options.history ?? []);
      return Response.json(
        !Array.isArray(history)
          ? history
          : history.map((message: unknown, messageIndex: number) => {
              const value = message as Record<string, unknown>;
              const info = (value.info ?? {}) as Record<string, unknown>;
              const messageID = typeof info.id === "string" ? info.id : `message-${messageIndex}`;
              const parts = Array.isArray(value.parts)
                ? value.parts.map((part, partIndex) => {
                    const record = part as Record<string, unknown>;
                    if (record.type !== "tool") return record;
                    const state = record.state as Record<string, unknown> | undefined;
                    const metadata = state?.metadata as Record<string, unknown> | undefined;
                    const filediff = metadata?.filediff as Record<string, unknown> | undefined;
                    const files = metadata?.files as Array<Record<string, unknown>> | undefined;
                    const canonicalPath =
                      typeof filediff?.file === "string"
                        ? filediff.file
                        : typeof files?.[0]?.filePath === "string"
                          ? files[0].filePath
                          : undefined;
                    let boundState =
                      state?.status === "completed" && state.input === undefined && canonicalPath
                        ? {
                            ...state,
                            input: {
                              filePath: canonicalPath,
                              snapshotId: "s_0000000000000000000000",
                              operations: [{ op: "replace_file", lines: [] }],
                            },
                          }
                        : state;
                    if (boundState?.status === "completed") {
                      boundState = {
                        ...boundState,
                        output:
                          typeof boundState.output === "string" ? boundState.output : "Applied",
                        title: typeof boundState.title === "string" ? boundState.title : "Edit",
                        time: boundState.time ?? { start: 1, end: 2 },
                      };
                    } else if (boundState?.status === "running") {
                      boundState = { ...boundState, time: boundState.time ?? { start: 1 } };
                    } else if (boundState?.status === "error") {
                      boundState = { ...boundState, time: boundState.time ?? { start: 1, end: 2 } };
                    }
                    return {
                      ...record,
                      id:
                        typeof record.id === "string"
                          ? record.id
                          : `part-${messageIndex}-${partIndex}`,
                      callID:
                        typeof record.callID === "string"
                          ? record.callID
                          : `call-${messageIndex}-${partIndex}`,
                      sessionID: sessionId,
                      messageID,
                      state: boundState,
                    };
                  })
                : value.parts;
              return { ...value, info: { ...info, id: messageID, sessionID: sessionId }, parts };
            }),
      );
    },
  });
  try {
    const value = await betterHashlinePlugin(
      {
        serverUrl: server.url,
        directory: root,
        worktree: options.worktree ?? root,
        client: {
          _client: {
            getConfig() {
              return { baseUrl: server.url.href, fetch };
            },
          },
        },
      } as never,
      {
        enforce: true,
        toolSurface: "native-aliases",
        ...options.pluginOptions,
      },
    );
    const dispose = value.dispose;
    value.dispose = async () => {
      try {
        await dispose?.();
      } finally {
        server.stop(true);
      }
    };
    values.push(value);
    return { value, historyCalls };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

function aliasRegistry(value: Hooks) {
  const hashlineRead = value.tool?.hashline_read;
  const edit = value.tool?.edit;
  const applyPatch = value.tool?.apply_patch;
  const hashlineWrite = value.tool?.hashline_write;
  if (!hashlineRead || !edit || !applyPatch || !hashlineWrite) {
    throw new Error("Native alias registry is incomplete");
  }
  return { hashlineRead, edit, applyPatch, hashlineWrite };
}

async function issueSnapshot(value: Hooks, toolContext: ToolContext, filePath: string) {
  const { hashlineRead } = aliasRegistry(value);
  const result = structured(await hashlineRead.execute({ filePath }, toolContext));
  const after = value["tool.execute.after"];
  if (!after) throw new Error("Missing after hook");
  await after(
    {
      tool: "hashline_read",
      sessionID: toolContext.sessionID,
      callID: "read-call",
      args: { filePath },
    },
    result,
  );
  return result;
}

function replaceArgs(filePath: string, snapshotId: string, replacement = "TWO") {
  return {
    filePath,
    snapshotId,
    operations: [{ op: "replace", startLine: 2, endLine: 2, lines: [replacement] }],
  };
}

async function systemGuidance(value: Hooks, sessionID?: string): Promise<string> {
  const output = { system: [] as string[] };
  await value["experimental.chat.system.transform"]?.({ sessionID } as never, output);
  return output.system.join("\n");
}

describe("native alias activation and visibility", () => {
  test("registers aliases without hashline_edit on a compatible host", async () => {
    const { value } = await aliasHarness();
    expect(Object.keys(value.tool ?? {}).sort()).toEqual([
      "apply_patch",
      "edit",
      "hashline_read",
      "hashline_write",
    ]);
    const expectedSchema = z.toJSONSchema(hashlineEditArgumentsSchema);
    const editShape = value.tool?.edit?.args;
    const patchShape = value.tool?.apply_patch?.args;
    if (!editShape || !patchShape) throw new Error("Alias schemas are unavailable");
    expect(z.toJSONSchema(z.object(editShape).strict())).toEqual(expectedSchema);
    expect(z.toJSONSchema(z.object(patchShape).strict())).toEqual(expectedSchema);
    expect(value.tool?.edit?.description).toBe(nativeAliasEditDescription);
    expect(value.tool?.apply_patch?.description).toBe(nativeAliasEditDescription);
    expect(nativeAliasEditDescription).toContain(
      "serialize while system guidance says native-alias-session=unbound",
    );
    expect(hashlineEditDescription).not.toContain("native-alias-session");
    expect(await systemGuidance(value)).toContain("native-alias-session=unbound");
    expect(await systemGuidance(value)).toContain(
      "Never issue edit or apply_patch calls concurrently or in the same assistant message",
    );
  });

  test("preserves every host alias-visibility state while hiding write and hashline_edit", async () => {
    const { value } = await aliasHarness();
    const states = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const;

    for (const [editVisible, patchVisible] of states) {
      const output = {
        message: {
          tools: {
            edit: editVisible,
            apply_patch: patchVisible,
            write: true,
            hashline_edit: true,
          },
        },
      };
      await value["chat.message"]?.({ sessionID: randomUUID() } as never, output as never);
      expect(output.message.tools).toEqual({
        edit: editVisible,
        apply_patch: patchVisible,
        write: false,
        hashline_edit: false,
      });
    }
  });

  test("fails closed without alias or unique fallback for invalid options", async () => {
    const { value } = await aliasHarness({
      pluginOptions: { toolSurface: "native-aliases", unknownOption: true },
    });
    expect(Object.keys(value.tool ?? {}).sort()).toEqual(["hashline_read", "hashline_write"]);
    expect(await systemGuidance(value)).toContain("configuration is invalid");
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID: "invalid", callID: "call" },
        { args: {} },
      ),
    ).rejects.toThrow("CONFIG_INVALID:");
    await expect(
      value.tool?.hashline_write?.execute(
        { filePath: "blocked.txt", content: "blocked" },
        context(),
      ),
    ).rejects.toThrow("CONFIG_INVALID:");
    expect(await readdir(root)).toEqual([]);
  });

  test("accepts later host versions when the required capabilities are present", async () => {
    const { value } = await aliasHarness({ hostVersion: "1.18.4" });
    expect(Object.keys(value.tool ?? {}).sort()).toEqual([
      "apply_patch",
      "edit",
      "hashline_read",
      "hashline_write",
    ]);
    expect(await systemGuidance(value)).toContain("native aliases are active");
  });

  test("fails closed when host capabilities are unavailable", async () => {
    const { value } = await aliasHarness({ healthStatus: 503 });
    expect(Object.keys(value.tool ?? {}).sort()).toEqual(["hashline_read", "hashline_write"]);
    expect(await systemGuidance(value)).toContain("native aliases are unavailable");
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID: randomUUID(), callID: "call" },
        { args: replaceArgs("missing.txt", "s_AAAAAAAAAAAAAAAAAAAAAA") },
      ),
    ).rejects.toThrow("TOOL_SURFACE_UNAVAILABLE:");
    await expect(
      value.tool?.hashline_write?.execute(
        { filePath: "blocked.txt", content: "blocked" },
        context(),
      ),
    ).rejects.toThrow("TOOL_SURFACE_UNAVAILABLE:");
    expect(await readdir(root)).toEqual([]);
  });

  test("tripwires inactive hashline_edit in alias mode", async () => {
    const { value } = await aliasHarness();
    await expect(
      value["tool.execute.before"]?.(
        { tool: "hashline_edit", sessionID: randomUUID(), callID: "call" },
        { args: replaceArgs("missing.txt", "s_AAAAAAAAAAAAAAAAAAAAAA") },
      ),
    ).rejects.toThrow("NATIVE_TOOL_DISABLED:");
  });
});

describe("native alias argument and mutation contract", () => {
  test("rejects native and hybrid shapes in both hooks and executors before side effects", async () => {
    const { value, historyCalls } = await aliasHarness();
    const { edit, applyPatch } = aliasRegistry(value);
    const toolContext = context();
    const cases = [
      ["edit", edit, { filePath: "missing.txt", oldString: "old", newString: "new" }],
      ["apply_patch", applyPatch, { patchText: "*** Begin Patch" }],
      [
        "edit",
        edit,
        {
          ...replaceArgs("missing.txt", "s_AAAAAAAAAAAAAAAAAAAAAA"),
          oldString: "old",
        },
      ],
    ] as const;

    for (const [name, definition, args] of cases) {
      await expect(
        value["tool.execute.before"]?.(
          { tool: name, sessionID: toolContext.sessionID, callID: "call" },
          { args },
        ),
      ).rejects.toThrow(`INVALID_ARGUMENT: Invalid ${name} arguments.`);
      await expect(definition.execute(args as never, toolContext)).rejects.toThrow(
        `INVALID_ARGUMENT: Invalid ${name} arguments.`,
      );
    }

    expect(historyCalls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  test("rejects a current history call whose input differs from the before-hook arguments", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const sessionID = "current-input-mismatch";
    const callID = "edit-call";
    const { value, historyCalls } = await aliasHarness({
      history: [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              callID,
              state: {
                status: "running",
                input: replaceArgs("other.txt", "s_0000000000000000000000"),
              },
            },
          ],
        },
      ],
    });
    const toolContext = context({ sessionID });
    const snapshot = await issueSnapshot(value, toolContext, "file.txt");
    const args = replaceArgs("file.txt", String(snapshot.metadata.snapshotId));

    await expect(
      value["tool.execute.before"]?.({ tool: "edit", sessionID, callID }, { args }),
    ).rejects.toThrow("SESSION_PROTOCOL_MISMATCH:");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\ntwo\n");
    expect(historyCalls.length).toBeGreaterThanOrEqual(1);
    expect(historyCalls.length).toBeLessThanOrEqual(6);
  });

  test("rereads one exact current call until its persisted input stabilizes", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const sessionID = "current-input-settles";
    const callID = "edit-call";
    let expectedInput: unknown;
    let reads = 0;
    const { value, historyCalls } = await aliasHarness({
      history: () => [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              callID,
              state: {
                status: "running",
                input:
                  reads++ === 0
                    ? replaceArgs("other.txt", "s_0000000000000000000000")
                    : expectedInput,
              },
            },
          ],
        },
      ],
    });
    const toolContext = context({ sessionID });
    const snapshot = await issueSnapshot(value, toolContext, "file.txt");
    expectedInput = replaceArgs("file.txt", String(snapshot.metadata.snapshotId));

    await expect(
      value["tool.execute.before"]?.({ tool: "edit", sessionID, callID }, { args: expectedInput }),
    ).resolves.toBeUndefined();
    expect(historyCalls).toEqual([sessionID, sessionID]);
  });

  for (const surface of ["edit", "apply_patch"] as const) {
    test(`${surface} reaches the shared snapshot executor and emits renderer metadata`, async () => {
      await writeFile(join(root, "file.txt"), "one\ntwo\nthree\n");
      const asks: AskRecord[] = [];
      const metadataUpdates: Array<Record<string, unknown>> = [];
      const toolContext = context({ asks, metadata: metadataUpdates });
      let currentInput: unknown;
      const { value, historyCalls } = await aliasHarness({
        history: () => [
          {
            parts: [
              {
                type: "tool",
                tool: surface,
                callID: "edit-call",
                state: { status: "running", input: currentInput },
              },
            ],
          },
        ],
      });
      const tools = aliasRegistry(value);
      const readResult = await issueSnapshot(value, toolContext, "file.txt");
      const args = {
        ...replaceArgs("file.txt", String(readResult.metadata.snapshotId)),
        readback: true,
      };
      currentInput = args;

      await value["tool.execute.before"]?.(
        { tool: surface, sessionID: toolContext.sessionID, callID: "edit-call" },
        { args },
      );
      const result = structured(
        await tools[surface === "edit" ? "edit" : "applyPatch"].execute(args, toolContext),
      );
      expect(result.metadata.hashlinePending).toEqual(expect.any(String));
      await value["tool.execute.after"]?.(
        { tool: surface, sessionID: toolContext.sessionID, callID: "edit-call", args },
        result,
      );

      expect(result.output).toContain(
        "Applied 1 operation.\n@hashline-edit previous=consumed successor=attached\n@hashline snapshot=",
      );
      expect(result.output).toContain("2|TWO");
      expect(result.metadata.hashlinePending).toBeUndefined();
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\nTWO\nthree\n");
      expect(asks.map(({ permission }) => permission)).toEqual(["read", "edit"]);
      expect(historyCalls).toEqual([toolContext.sessionID]);
      expect(result.metadata.diagnostics).toEqual({});
      expect(result.metadata.betterHashline).toMatchObject({
        protocol: NATIVE_ALIAS_PROTOCOL,
        packageVersion: PACKAGE_VERSION,
        hostVersion: "1.18.3",
        surface,
      });
      expect(result.metadata.betterHashline).toMatchObject({
        schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        canonicalPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      if (surface === "edit") {
        expect(result.metadata).toMatchObject({
          diff: expect.stringContaining("-two"),
          filediff: { additions: 1, deletions: 1, patch: expect.stringContaining("+TWO") },
        });
      } else {
        expect(result.metadata).toMatchObject({
          files: [
            {
              type: "update",
              relativePath: "file.txt",
              additions: 1,
              deletions: 1,
              patch: expect.stringContaining("+TWO"),
            },
          ],
        });
      }
      expect(metadataUpdates.at(-1)?.metadata).toEqual(result.metadata);
    });
  }

  test("resolves a root worktree sentinel on the fixture drive", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const toolContext = context({ worktree: "/" });
    let currentInput: unknown;
    const { value } = await aliasHarness({
      worktree: "/",
      history: () => [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              callID: "edit-call",
              state: { status: "running", input: currentInput },
            },
          ],
        },
      ],
    });
    const { edit } = aliasRegistry(value);
    const snapshot = await issueSnapshot(value, toolContext, "file.txt");
    const args = replaceArgs("file.txt", String(snapshot.metadata.snapshotId));
    currentInput = args;

    await value["tool.execute.before"]?.(
      { tool: "edit", sessionID: toolContext.sessionID, callID: "edit-call" },
      { args },
    );
    await edit.execute(args, toolContext);

    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\nTWO\n");
  });

  test("does not transfer snapshots between case-distinct canonical files", async () => {
    if (process.platform === "win32") {
      const enabled = Bun.spawnSync(["fsutil", "file", "SetCaseSensitiveInfo", root, "enable"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (enabled.exitCode !== 0) return;
    }
    const upperPath = join(root, "Case.txt");
    const lowerPath = join(root, "case.txt");
    await writeFile(upperPath, "one\ntwo\n");
    await writeFile(lowerPath, "alpha\nbeta\n");
    if ((await realpath(upperPath)) === (await realpath(lowerPath))) return;
    const toolContext = context();
    const { value } = await aliasHarness();
    const snapshot = await issueSnapshot(value, toolContext, "Case.txt");
    const { edit } = aliasRegistry(value);

    await expect(
      edit.execute(
        replaceArgs("case.txt", String(snapshot.metadata.snapshotId), "BETA"),
        toolContext,
      ),
    ).rejects.toThrow("PATH_MISMATCH:");
    expect(await readFile(upperPath, "utf8")).toBe("one\ntwo\n");
    expect(await readFile(lowerPath, "utf8")).toBe("alpha\nbeta\n");
  });

  test("rechecks a concurrently invalidated snapshot after acquiring the path lock", async () => {
    await writeFile(join(root, "concurrent.txt"), "one\ntwo\n");
    let releaseApproval = () => {};
    let markApproval = () => {};
    const approvalStarted = new Promise<void>((resolve) => {
      markApproval = resolve;
    });
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let editApprovals = 0;
    const toolContext = context({
      async onAsk(request) {
        if (request.permission !== "edit") return;
        editApprovals += 1;
        if (editApprovals === 1) {
          markApproval();
          await approvalGate;
        }
      },
    });
    const { value } = await aliasHarness();
    const snapshot = await issueSnapshot(value, toolContext, "concurrent.txt");
    const snapshotId = String(snapshot.metadata.snapshotId);
    const { edit } = aliasRegistry(value);
    const first = edit.execute(replaceArgs("concurrent.txt", snapshotId, "FIRST"), toolContext);
    await approvalStarted;
    const second = edit.execute(
      { ...replaceArgs("concurrent.txt", snapshotId, "SECOND"), rebase: "unique" },
      toolContext,
    );
    const secondOutcome = second.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    releaseApproval();

    await expect(first).resolves.toBeDefined();
    const outcome = await secondOutcome;
    expect(outcome.value).toBeUndefined();
    expect(String(outcome.error)).toContain("SNAPSHOT_UNKNOWN:");
    expect(editApprovals).toBe(1);
    expect(await readFile(join(root, "concurrent.txt"), "utf8")).toBe("one\nFIRST\n");
  });

  test("overlaps independent-file aliases only after exact session binding", async () => {
    const sessionID = "bound-parallel";
    const toolContext = context({ sessionID });
    const { value, historyCalls } = await aliasHarness();
    const { edit, applyPatch } = aliasRegistry(value);
    for (const filePath of ["bind.txt", "left.txt", "right.txt"]) {
      await writeFile(join(root, filePath), "one\ntwo\n");
    }
    const bindSnapshot = await issueSnapshot(value, toolContext, "bind.txt");
    await edit.execute(
      replaceArgs("bind.txt", String(bindSnapshot.metadata.snapshotId), "BOUND"),
      toolContext,
    );
    const guidance = await systemGuidance(value, sessionID);
    expect(guidance).toContain("native-alias-session=bound");
    expect(guidance).toContain("Different paths may run concurrently");
    expect(guidance).not.toContain("Never issue edit or apply_patch calls concurrently");

    const leftSnapshot = await issueSnapshot(value, toolContext, "left.txt");
    const rightSnapshot = await issueSnapshot(value, toolContext, "right.txt");
    let approvalCount = 0;
    let markBothStarted = () => {};
    let releaseApprovals = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const approvalGate = new Promise<void>((resolve) => {
      releaseApprovals = resolve;
    });
    const concurrentContext = context({
      sessionID,
      async onAsk(request) {
        if (request.permission !== "edit") return;
        approvalCount += 1;
        if (approvalCount === 2) markBothStarted();
        await approvalGate;
      },
    });
    const left = edit.execute(
      replaceArgs("left.txt", String(leftSnapshot.metadata.snapshotId), "LEFT"),
      concurrentContext,
    );
    const right = applyPatch.execute(
      replaceArgs("right.txt", String(rightSnapshot.metadata.snapshotId), "RIGHT"),
      concurrentContext,
    );
    await bothStarted;
    expect(approvalCount).toBe(2);
    releaseApprovals();
    await Promise.all([left, right]);

    expect(historyCalls).toEqual([sessionID]);
    expect(await readFile(join(root, "left.txt"), "utf8")).toBe("one\nLEFT\n");
    expect(await readFile(join(root, "right.txt"), "utf8")).toBe("one\nRIGHT\n");
  });

  test("persists completed display-prefix rejection so a restarted session can recover", async () => {
    const sessionID = "prefix-retry";
    await writeFile(join(root, "prefix.txt"), "one\ntwo\n");
    const first = await aliasHarness();
    const firstContext = context({ sessionID });
    const initialRead = await issueSnapshot(first.value, firstContext, "prefix.txt");
    const blockedArgs = {
      ...replaceArgs("prefix.txt", String(initialRead.metadata.snapshotId), "@hashline"),
      operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["@hashline"] }],
      readback: true,
    };
    const rejection = structured(
      await aliasRegistry(first.value).edit.execute(blockedArgs, firstContext),
    );
    expect(rejection.output).toStartWith("DISPLAY_PREFIX_REJECTED:");
    expect(rejection.metadata.betterHashlineRejection).toBeDefined();
    expect(await readFile(join(root, "prefix.txt"), "utf8")).toBe("one\ntwo\n");

    const persisted = {
      ...rejection,
      metadata: { ...rejection.metadata, truncated: false },
    };
    const after = first.value["tool.execute.after"];
    if (!after) throw new Error("Missing after hook");
    await after({ tool: "edit", sessionID, callID: "rejected-call", args: blockedArgs }, persisted);
    expect(persisted.output).toBe(rejection.output);
    await first.value.dispose?.();

    const second = await aliasHarness({
      history: [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              state: {
                status: "completed",
                input: blockedArgs,
                metadata: persisted.metadata,
                output: persisted.output,
                title: persisted.title,
              },
            },
          ],
        },
      ],
    });
    const secondContext = context({ sessionID });
    const freshRead = await issueSnapshot(second.value, secondContext, "prefix.txt");
    await aliasRegistry(second.value).edit.execute(
      {
        ...replaceArgs("prefix.txt", String(freshRead.metadata.snapshotId), "@hashline"),
        operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["@hashline"] }],
        allowHashlinePrefixes: true,
      },
      secondContext,
    );
    expect(second.historyCalls).toEqual([sessionID]);
    expect(await readFile(join(root, "prefix.txt"), "utf8")).toBe("one\n@hashline\n");
  });

  test("rejects oversized renderer metadata before edit permission and publication", async () => {
    await writeFile(join(root, "large.txt"), "one\ntwo\n");
    const asks: AskRecord[] = [];
    const toolContext = context({ asks });
    const { value } = await aliasHarness();
    const snapshot = await issueSnapshot(value, toolContext, "large.txt");
    const { edit } = aliasRegistry(value);

    await expect(
      edit.execute(
        replaceArgs("large.txt", String(snapshot.metadata.snapshotId), "x".repeat(600 * 1024)),
        toolContext,
      ),
    ).rejects.toThrow("UNSUPPORTED_FILE: Native alias metadata exceeds");
    expect(asks.map(({ permission }) => permission)).toEqual(["read"]);
    expect(await readFile(join(root, "large.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("rejects same-volume paths outside the worktree before edit permission", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "better-hashline-alias-outside-"));
    const outsideFile = join(outsideRoot, "outside.txt");
    try {
      await writeFile(outsideFile, "one\ntwo\n");
      const asks: AskRecord[] = [];
      const toolContext = context({ asks });
      const { value } = await aliasHarness();
      const snapshot = await issueSnapshot(value, toolContext, outsideFile);
      const permissionsBeforeEdit = asks.length;
      const { edit } = aliasRegistry(value);

      await expect(
        edit.execute(
          replaceArgs(outsideFile, String(snapshot.metadata.snapshotId), "TWO"),
          toolContext,
        ),
      ).rejects.toThrow("UNSUPPORTED_FILE: Native aliases cannot edit files outside");
      expect(asks).toHaveLength(permissionsBeforeEdit);
      expect(await readFile(outsideFile, "utf8")).toBe("one\ntwo\n");
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("supports immutable transfer operations through both aliases", async () => {
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);
    for (const [index, surface] of (["edit", "apply_patch"] as const).entries()) {
      const filePath = `transfer-${index}.txt`;
      await writeFile(join(root, filePath), "a\nb\nc\nd\n");
      const toolContext = context();
      const readResult = await issueSnapshot(value, toolContext, filePath);
      const operation =
        surface === "edit"
          ? { op: "copy_range", startLine: 2, endLine: 3, afterLine: 4 }
          : { op: "move_range", startLine: 2, endLine: 3, afterLine: 4 };
      await tools[surface === "edit" ? "edit" : "applyPatch"].execute(
        {
          filePath,
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [operation],
        },
        toolContext,
      );
      expect(await readFile(join(root, filePath), "utf8")).toBe(
        surface === "edit" ? "a\nb\nc\nd\nb\nc\n" : "a\nd\nb\nc\n",
      );
    }
  });

  test("keeps snapshots session-scoped and permission denial side-effect free", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const owner = context();
    const { value } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const readResult = await issueSnapshot(value, owner, "file.txt");
    const args = replaceArgs("file.txt", String(readResult.metadata.snapshotId));

    await expect(edit.execute(args, context())).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await expect(
      edit.execute(args, context({ sessionID: owner.sessionID, denyEdit: true })),
    ).rejects.toThrow("PERMISSION_DENIED:");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("hides and tripwires native write while retaining create-only hashline_write", async () => {
    const { value } = await aliasHarness();
    const { hashlineWrite } = aliasRegistry(value);
    const tools = { write: true, edit: true, apply_patch: false };
    await value["chat.message"]?.(
      { sessionID: randomUUID(), model: { providerID: "test", modelID: "gpt-5" } } as never,
      { message: { tools } } as never,
    );
    expect(tools.write).toBeFalse();

    for (const sessionID of [randomUUID(), `synthetic-${randomUUID()}`]) {
      await expect(
        value["tool.execute.before"]?.(
          { tool: "write", sessionID, callID: "write-call" },
          { args: { filePath: "created.txt", content: "unsafe" } },
        ),
      ).rejects.toThrow("NATIVE_TOOL_DISABLED:");
    }

    const toolContext = context();
    await hashlineWrite.execute({ filePath: "created.txt", content: "safe\n" }, toolContext);
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("safe\n");
    await expect(
      hashlineWrite.execute({ filePath: "created.txt", content: "overwrite\n" }, toolContext),
    ).rejects.toThrow("TARGET_EXISTS:");
  });
});

describe("native alias continuation safety", () => {
  test("binds parent, child, and synthetic continuation sessions independently", async () => {
    const { value, historyCalls } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const sessions = ["parent", "child", "synthetic-compaction"];

    for (const [index, sessionID] of sessions.entries()) {
      const filePath = `session-${index}.txt`;
      await writeFile(join(root, filePath), "one\ntwo\n");
      const toolContext = context({ sessionID });
      const readResult = await issueSnapshot(value, toolContext, filePath);
      await edit.execute(
        replaceArgs(filePath, String(readResult.metadata.snapshotId), `SESSION-${index}`),
        toolContext,
      );
      expect(await readFile(join(root, filePath), "utf8")).toBe(`one\nSESSION-${index}\n`);
    }

    expect(historyCalls).toEqual(sessions);
  });

  test("rejects unreadable and sanitized history before filesystem access", async () => {
    const histories: unknown[] = [
      new Error("unavailable"),
      [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              state: { status: "completed", metadata: {} },
            },
          ],
        },
      ],
    ];

    for (const history of histories) {
      const harness =
        history instanceof Error
          ? await aliasHarness({ historyError: true })
          : await aliasHarness({ history });
      const { edit } = aliasRegistry(harness.value);
      await expect(
        edit.execute(replaceArgs("missing.txt", "s_AAAAAAAAAAAAAAAAAAAAAA"), context()),
      ).rejects.toThrow("SESSION_PROTOCOL_MISMATCH:");
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("accepts compatible unsanitized history and binds continuation once", async () => {
    const schemaSha256 = jsonSha256(
      openCodeProviderSchema(z.toJSONSchema(hashlineEditArgumentsSchema)),
    );
    const historicalDiff =
      "--- history.txt\tbefore\n+++ history.txt\tafter\n@@ -1 +1 @@\n-old\n+new\n";
    const history = [
      {
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              metadata: buildNativeAliasMetadata({
                surface: "edit",
                canonicalPath: join(root, "history.txt"),
                relativePath: "history.txt",
                unifiedDiff: historicalDiff,
                additions: 1,
                deletions: 1,
                packageVersion: PACKAGE_VERSION,
                schemaSha256,
                hostVersion: "1.18.3",
              }),
            },
          },
        ],
      },
    ];
    const { value, historyCalls } = await aliasHarness({ history });
    const { edit } = aliasRegistry(value);
    await writeFile(join(root, "first.txt"), "one\ntwo\n");
    const toolContext = context();
    const firstRead = await issueSnapshot(value, toolContext, "first.txt");
    await edit.execute(
      replaceArgs("first.txt", String(firstRead.metadata.snapshotId), "SECOND"),
      toolContext,
    );

    await writeFile(join(root, "second.txt"), "one\ntwo\n");
    const secondRead = await issueSnapshot(value, toolContext, "second.txt");
    await edit.execute(
      replaceArgs("second.txt", String(secondRead.metadata.snapshotId), "AGAIN"),
      toolContext,
    );
    expect(historyCalls).toEqual([toolContext.sessionID]);
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe("one\nAGAIN\n");
  });

  test("continues from compacted history on a synthetic turn", async () => {
    const schemaSha256 = jsonSha256(
      openCodeProviderSchema(z.toJSONSchema(hashlineEditArgumentsSchema)),
    );
    const historyMetadata = buildNativeAliasMetadata({
      surface: "edit",
      canonicalPath: join(root, "history.txt"),
      relativePath: "history.txt",
      unifiedDiff: "--- history.txt\tbefore\n+++ history.txt\tafter\n@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
      packageVersion: PACKAGE_VERSION,
      schemaSha256,
      hostVersion: "1.18.3",
    });
    const sessionID = "synthetic-compaction";
    const callID = "compacted-edit";
    let currentInput: unknown;
    const { value, historyCalls } = await aliasHarness({
      history: () => [
        {
          info: { role: "assistant", time: { created: 1, completed: 2, compacted: 3 } },
          parts: [
            {
              type: "tool",
              tool: "edit",
              callID: "historical-edit",
              state: { status: "completed", metadata: historyMetadata },
            },
          ],
        },
        {
          info: { role: "assistant", synthetic: true },
          parts: [
            {
              type: "tool",
              tool: "edit",
              callID,
              state: { status: "running", input: currentInput },
            },
          ],
        },
      ],
    });
    await writeFile(join(root, "compacted.txt"), "one\ntwo\n");
    const toolContext = context({ sessionID });
    const snapshot = await issueSnapshot(value, toolContext, "compacted.txt");
    const args = replaceArgs("compacted.txt", String(snapshot.metadata.snapshotId), "COMPACTED");
    currentInput = args;
    await value["tool.execute.before"]?.({ tool: "edit", sessionID, callID }, { args });
    await aliasRegistry(value).edit.execute(args, toolContext);

    expect(historyCalls).toEqual([sessionID]);
    expect(await readFile(join(root, "compacted.txt"), "utf8")).toBe("one\nCOMPACTED\n");
  });

  test("requires a fresh reread after plugin restart", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const toolContext = context();
    const first = await aliasHarness();
    const firstEdit = aliasRegistry(first.value).edit;
    const initialRead = await issueSnapshot(first.value, toolContext, "file.txt");
    const initialResult = structured(
      await firstEdit.execute(
        replaceArgs("file.txt", String(initialRead.metadata.snapshotId), "SECOND"),
        toolContext,
      ),
    );
    const staleRead = await issueSnapshot(first.value, toolContext, "file.txt");
    await first.value.dispose?.();

    const second = await aliasHarness({
      history: [
        {
          parts: [
            {
              type: "tool",
              tool: "edit",
              state: { status: "completed", metadata: initialResult.metadata },
            },
          ],
        },
      ],
    });
    const { edit } = aliasRegistry(second.value);
    await expect(
      edit.execute(replaceArgs("file.txt", String(staleRead.metadata.snapshotId)), toolContext),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");

    const freshRead = await issueSnapshot(second.value, toolContext, "file.txt");
    await edit.execute(
      replaceArgs("file.txt", String(freshRead.metadata.snapshotId), "THIRD"),
      toolContext,
    );
    expect(second.historyCalls).toEqual([toolContext.sessionID]);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\nTHIRD\n");
  });
});
