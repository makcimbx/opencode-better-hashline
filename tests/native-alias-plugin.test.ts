import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  betterHashlinePlugin,
  hashlineEditArgumentsSchema,
  hashlineEditDescription,
  nativeAliasEditDescription,
} from "../src/plugin.js";
import { NATIVE_ALIAS_PROTOCOL } from "../src/presentation.js";
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
  historyFetch?: (sessionId: string, attempt: number) => Response | Promise<Response>;
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

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected operation to reject");
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
      const attempt = historyCalls.filter((value) => value === sessionId).length;
      if (options.historyFetch) return options.historyFetch(sessionId, attempt);
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

const KIND_MISMATCH_OUTPUT =
  "SESSION_PROTOCOL_MISMATCH: The delivered tool kind did not match the pending Better Hashline operation. No snapshot was issued. An underlying mutation may need inspection; run a fresh hashline_read before retrying.";

async function deliverReadResult(
  value: Hooks,
  toolContext: ToolContext,
  filePath: string,
  result: StructuredResult,
  callID = "read-call",
) {
  const after = value["tool.execute.after"];
  if (!after) throw new Error("Missing after hook");
  await after(
    {
      tool: "hashline_read",
      sessionID: toolContext.sessionID,
      callID,
      args: { filePath },
    },
    result,
  );
}

async function issueSnapshot(value: Hooks, toolContext: ToolContext, filePath: string) {
  const { hashlineRead } = aliasRegistry(value);
  const result = structured(await hashlineRead.execute({ filePath }, toolContext));
  await deliverReadResult(value, toolContext, filePath, result);
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
      "Native aliases: edit and apply_patch require a delivered, attested hashline_read and native-alias-session=bound.",
    );
    expect(hashlineEditDescription).not.toContain("native-alias-session");
    expect(nativeAliasEditDescription).toContain(
      "neighboring lines outside the range remain, so do not repeat retained context such as a closing delimiter unless intentional.",
    );
    expect(nativeAliasEditDescription).toContain(
      "Every operation uses original immutable pre-batch coordinates; never shift later startLine/endLine/afterLine because of earlier operations and never target lines created by another operation.",
    );
    const guidance = await systemGuidance(value);
    expect(guidance).toContain("native-alias-session=unbound");
    expect(guidance).toContain(
      "Do not issue edit or apply_patch until a hashline_read result has been delivered",
    );
    expect(guidance).toContain("in this same session");
    expect(guidance).toContain(
      "neighboring lines outside the range remain, so do not repeat retained context such as a closing delimiter unless intentional.",
    );
    expect(guidance).toContain(
      "Every operation uses original immutable pre-batch coordinates; never shift later startLine/endLine/afterLine because of earlier operations and never target lines created by another operation.",
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

  test("binds only after an exact delivered read after-hook", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const sessionID = "delivered-read-only";
    const toolContext = context({ sessionID });
    const { value, historyCalls } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const pending = structured(await hashlineRead.execute({ filePath: "file.txt" }, toolContext));
    const args = replaceArgs("file.txt", String(pending.metadata.snapshotId));

    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=unbound");
    await expect(
      value["tool.execute.before"]?.({ tool: "edit", sessionID, callID: "edit-call" }, { args }),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await expect(edit.execute(args, toolContext)).rejects.toThrow("SNAPSHOT_REQUIRED:");

    await value["tool.execute.after"]?.(
      { tool: "hashline_read", sessionID, callID: "read-call", args: { filePath: "file.txt" } },
      pending,
    );

    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
    await expect(
      value["tool.execute.before"]?.({ tool: "edit", sessionID, callID: "edit-call" }, { args }),
    ).resolves.toBeUndefined();
    expect(historyCalls).toEqual([]);
  });

  test("does not bind or issue reads with invalid after-hook attestation", async () => {
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const after = value["tool.execute.after"];
    if (!after) throw new Error("Missing after hook");
    const scenarios = [
      "missing-pending",
      "wrong-kind",
      "wrong-session",
      "truncated",
      "digest-mutation",
      "snapshot-id-mutation",
    ] as const;

    for (const scenario of scenarios) {
      const sessionID = `attestation-${scenario}`;
      const filePath = `${scenario}.txt`;
      const witnessPath = `${scenario}-witness.txt`;
      await writeFile(join(root, filePath), "one\ntwo\n");
      await writeFile(join(root, witnessPath), "one\ntwo\n");
      const toolContext = context({ sessionID });
      const result = structured(await hashlineRead.execute({ filePath }, toolContext));
      const failedSnapshotId = String(result.metadata.snapshotId);
      let hookInput: Record<string, unknown> = {
        tool: "hashline_read",
        sessionID,
        callID: `read-${scenario}`,
        args: { filePath },
      };

      if (scenario === "missing-pending") delete result.metadata.hashlinePending;
      if (scenario === "wrong-kind") {
        hookInput = {
          tool: "edit",
          sessionID,
          callID: `read-${scenario}`,
          args: { readback: true },
        };
      }
      if (scenario === "wrong-session") hookInput.sessionID = `${sessionID}-other`;
      if (scenario === "truncated") result.metadata.truncated = true;
      if (scenario === "digest-mutation") result.output += "\nchanged by host";
      if (scenario === "snapshot-id-mutation") {
        result.metadata.snapshotId = "s_AAAAAAAAAAAAAAAAAAAAAA";
      }

      await after(hookInput as never, result);
      expect(result.metadata.hashlinePending).toBeUndefined();
      if (scenario === "wrong-kind") {
        expect(result.output).toBe(KIND_MISMATCH_OUTPUT);
        expect(result.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });
      }
      expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=unbound");

      await issueSnapshot(value, toolContext, witnessPath);
      await expect(
        edit.execute(replaceArgs(filePath, failedSnapshotId), toolContext),
      ).rejects.toThrow("SNAPSHOT_REQUIRED:");
      expect(await readFile(join(root, filePath), "utf8")).toBe("one\ntwo\n");
    }
  });

  test("sanitizes both pending-kind mismatch directions without claiming mutation success", async () => {
    await writeFile(join(root, "read-kind.txt"), "one\ntwo\n");
    await writeFile(join(root, "edit-kind.txt"), "one\ntwo\n");
    const sessionID = "pending-kind-mismatch";
    const toolContext = context({ sessionID });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const after = value["tool.execute.after"];
    if (!after) throw new Error("Missing after hook");

    const pendingRead = structured(
      await hashlineRead.execute({ filePath: "read-kind.txt" }, toolContext),
    );
    await after(
      { tool: "edit", sessionID, callID: "wrong-edit", args: { readback: true } },
      pendingRead,
    );
    expect(pendingRead.output).toBe(KIND_MISMATCH_OUTPUT);
    expect(pendingRead.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });

    const issued = await issueSnapshot(value, toolContext, "edit-kind.txt");
    const args = {
      ...replaceArgs("edit-kind.txt", String(issued.metadata.snapshotId)),
      readback: true,
    };
    const pendingEdit = structured(await edit.execute(args, toolContext));
    const expectedMetadata = { ...pendingEdit.metadata };
    delete expectedMetadata.hashlinePending;
    delete expectedMetadata.snapshotId;
    await after(
      {
        tool: "hashline_read",
        sessionID,
        callID: "wrong-read",
        args: { filePath: "edit-kind.txt" },
      },
      pendingEdit,
    );
    expect(pendingEdit.output).toBe(KIND_MISMATCH_OUTPUT);
    expect(pendingEdit.metadata).toEqual(expectedMetadata);
    expect(pendingEdit.metadata.hashlinePending).toBeUndefined();
    expect(pendingEdit.metadata.snapshotId).toBeUndefined();
    expect(await readFile(join(root, "edit-kind.txt"), "utf8")).toBe("one\nTWO\n");
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
        readbackOffset: 2,
        readbackLimit: 1,
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
      expect(result.output).not.toContain("1|one");
      expect(result.output).not.toContain("3|three");
      expect(result.output).toContain("partial=true");
      expect(result.metadata.hashlinePending).toBeUndefined();
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\nTWO\nthree\n");
      expect(asks.map(({ permission }) => permission)).toEqual(["read", "edit"]);
      expect(historyCalls).toEqual([]);
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
    expect(guidance).toContain(
      "Alias calls with disjoint complete source/destination path sets may run concurrently",
    );
    expect(guidance).toContain("alias calls with overlapping path sets serialize");
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

    expect(historyCalls).toEqual([]);
    expect(await readFile(join(root, "left.txt"), "utf8")).toBe("one\nLEFT\n");
    expect(await readFile(join(root, "right.txt"), "utf8")).toBe("one\nRIGHT\n");
  });

  test("requires a fresh delivered read after restart regardless of persisted rejection history", async () => {
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
    expect(second.historyCalls).toEqual([]);
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

  test("publishes lifecycle operations through both renderer surfaces", async () => {
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);

    await writeFile(join(root, "delete.txt"), "delete\n");
    const editContext = context();
    const deleteSnapshot = await issueSnapshot(value, editContext, "delete.txt");
    const deleted = structured(
      await tools.edit.execute(
        {
          filePath: "delete.txt",
          snapshotId: String(deleteSnapshot.metadata.snapshotId),
          operations: [{ op: "delete_file" }],
        },
        editContext,
      ),
    );
    expect(deleted.output).toContain("Deleted delete.txt.");
    expect(deleted.metadata).toMatchObject({
      diff: expect.stringContaining("-delete"),
      betterHashline: { operation: "delete_file" },
    });
    await expect(readFile(join(root, "delete.txt"))).rejects.toThrow();

    await writeFile(join(root, "move.txt"), "move\n");
    const patchContext = context();
    const moveSnapshot = await issueSnapshot(value, patchContext, "move.txt");
    const moved = structured(
      await tools.applyPatch.execute(
        {
          filePath: "move.txt",
          snapshotId: String(moveSnapshot.metadata.snapshotId),
          operations: [{ op: "move_file", destinationPath: "moved.txt" }],
        },
        patchContext,
      ),
    );
    expect(moved.output).toContain("Moved move.txt to moved.txt.");
    expect(moved.metadata).toMatchObject({
      files: [
        {
          filePath: join(root, "move.txt"),
          relativePath: "moved.txt",
          type: "move",
          movePath: join(root, "moved.txt"),
          additions: 0,
          deletions: 0,
        },
      ],
      betterHashline: {
        operation: "move_file",
        destinationPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(readFile(join(root, "move.txt"))).rejects.toThrow();
    expect(await readFile(join(root, "moved.txt"), "utf8")).toBe("move\n");
  });

  test("rejects move destination line breaks before permission or publication", async () => {
    if (process.platform === "win32") return;
    const { value } = await aliasHarness();
    const { applyPatch } = aliasRegistry(value);

    for (const [index, separator] of ["\n", "\r"].entries()) {
      const sourceName = `safe-source-${index}.txt`;
      const destinationName = `unsafe-${index}${separator}destination.txt`;
      const sourcePath = join(root, sourceName);
      const destinationPath = join(root, destinationName);
      await writeFile(sourcePath, "preserved\n");
      const asks: AskRecord[] = [];
      const metadata: Array<Record<string, unknown>> = [];
      const toolContext = context({ asks, metadata });
      const snapshot = await issueSnapshot(value, toolContext, sourceName);
      asks.length = 0;
      metadata.length = 0;

      await expect(
        applyPatch.execute(
          {
            filePath: sourceName,
            snapshotId: String(snapshot.metadata.snapshotId),
            operations: [{ op: "move_file", destinationPath: destinationName }],
          },
          toolContext,
        ),
      ).rejects.toThrow(
        "INVALID_ARGUMENT: filePath contains characters that cannot be represented safely in permission patterns.",
      );
      expect(asks).toEqual([]);
      expect(metadata).toEqual([]);
      expect(await readFile(sourcePath, "utf8")).toBe("preserved\n");
      await expect(readFile(destinationPath)).rejects.toThrow();
    }
  });

  test("recovers the same session after partial move publication and a fresh read", async () => {
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);
    const sourcePath = join(root, "partial-source.txt");
    const destinationPath = join(root, "partial-destination.txt");
    await writeFile(sourcePath, "preserved\n");
    await writeFile(join(root, "unrelated.txt"), "one\ntwo\n");
    await writeFile(join(root, "delayed.txt"), "one\ntwo\n");
    const toolContext = context({ sessionID: "partial-move" });
    const snapshot = await issueSnapshot(value, toolContext, "partial-source.txt");
    const unrelatedBefore = await issueSnapshot(value, toolContext, "unrelated.txt");
    const delayed = structured(
      await tools.hashlineRead.execute({ filePath: "delayed.txt" }, toolContext),
    );
    const delayedSnapshotId = String(delayed.metadata.snapshotId);
    const args = {
      filePath: "partial-source.txt",
      snapshotId: String(snapshot.metadata.snapshotId),
      operations: [{ op: "move_file" as const, destinationPath: "partial-destination.txt" }],
    };
    const realUnlink = fsPromises.unlink;
    const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      if (String(path) === sourcePath) throw new Error("simulated unlink failure");
      return realUnlink(path);
    });
    try {
      await expect(tools.applyPatch.execute(args, toolContext)).rejects.toThrow(
        "resume this same session",
      );
    } finally {
      unlinkMock.mockRestore();
    }

    expect(await readFile(sourcePath, "utf8")).toBe("preserved\n");
    expect(await readFile(destinationPath, "utf8")).toBe("preserved\n");
    expect(await systemGuidance(value, toolContext.sessionID)).toContain(
      "native-alias-session=unbound",
    );
    await expect(tools.edit.execute(args, toolContext)).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await deliverReadResult(value, toolContext, "delayed.txt", delayed, "delayed-after-partial");
    expect(delayed.output).toStartWith("SNAPSHOT_REQUIRED:");
    expect(delayed.metadata.snapshotId).toBeUndefined();

    const unrelated = await issueSnapshot(value, toolContext, "unrelated.txt");
    expect(unrelated.metadata.snapshotId).not.toBe(unrelatedBefore.metadata.snapshotId);
    await expect(
      tools.edit.execute(
        replaceArgs("unrelated.txt", String(unrelatedBefore.metadata.snapshotId), "STALE"),
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await expect(
      tools.edit.execute(replaceArgs("delayed.txt", delayedSnapshotId, "STALE"), toolContext),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await tools.edit.execute(
      replaceArgs("unrelated.txt", String(unrelated.metadata.snapshotId), "RECOVERED"),
      toolContext,
    );
    await expect(tools.edit.execute(args, toolContext)).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("one\nRECOVERED\n");
  });

  test("recovers the same session after partial parent publication and invalidates the target", async () => {
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);
    const toolContext = context({ sessionID: "partial-parent" });
    const targetPath = join(root, "partial-parent", "inner", "created.txt");
    await fsPromises.mkdir(join(root, "partial-parent", "inner"), { recursive: true });
    await writeFile(targetPath, "old\nvalue\n");
    const staleTarget = await issueSnapshot(value, toolContext, "partial-parent/inner/created.txt");
    await writeFile(join(root, "next.txt"), "one\ntwo\n");
    const staleNext = await issueSnapshot(value, toolContext, "next.txt");
    await rm(join(root, "partial-parent"), { recursive: true });

    const realMkdir = fsPromises.mkdir;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      throw new Error("simulated post-mkdir failure");
    });
    try {
      await expect(
        tools.hashlineWrite.execute(
          {
            filePath: "partial-parent/inner/created.txt",
            content: "created\n",
            createParents: true,
          },
          toolContext,
        ),
      ).rejects.toThrow("resume this same session");
    } finally {
      mkdirMock.mockRestore();
    }

    expect((await fsPromises.stat(join(root, "partial-parent"))).isDirectory()).toBe(true);
    expect(await systemGuidance(value, toolContext.sessionID)).toContain(
      "native-alias-session=unbound",
    );
    const nextSnapshot = await issueSnapshot(value, toolContext, "next.txt");
    expect(nextSnapshot.metadata.snapshotId).not.toBe(staleNext.metadata.snapshotId);
    await expect(
      tools.edit.execute(
        replaceArgs("next.txt", String(staleNext.metadata.snapshotId), "STALE"),
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await tools.edit.execute(
      replaceArgs("next.txt", String(nextSnapshot.metadata.snapshotId), "RECOVERED"),
      toolContext,
    );
    await expect(
      tools.edit.execute(
        replaceArgs("partial-parent/inner/created.txt", String(staleTarget.metadata.snapshotId)),
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(join(root, "next.txt"), "utf8")).toBe("one\nRECOVERED\n");
  });

  test("keeps snapshots session-scoped and permission denial side-effect free", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    await writeFile(join(root, "intruder.txt"), "one\ntwo\n");
    const owner = context({ sessionID: "owner" });
    const intruder = context({ sessionID: "intruder" });
    const { value } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const readResult = await issueSnapshot(value, owner, "file.txt");
    await issueSnapshot(value, intruder, "intruder.txt");
    const args = replaceArgs("file.txt", String(readResult.metadata.snapshotId));

    await expect(edit.execute(args, intruder)).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await expect(
      edit.execute(args, context({ sessionID: owner.sessionID, denyEdit: true })),
    ).rejects.toThrow("PERMISSION_DENIED:");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("invalidates byte-identical targets recreated by strict and parent-creating writes", async () => {
    const { value } = await aliasHarness();
    const { edit, hashlineWrite } = aliasRegistry(value);
    const cases = [
      { filePath: "strict-recreated.txt", createParents: false },
      { filePath: "parents/recreated.txt", createParents: true },
    ];

    for (const [index, entry] of cases.entries()) {
      const absolutePath = join(root, entry.filePath);
      await fsPromises.mkdir(join(absolutePath, ".."), { recursive: true });
      await writeFile(absolutePath, "one\ntwo\n");
      const toolContext = context({ sessionID: `recreated-${index}` });
      const stale = await issueSnapshot(value, toolContext, entry.filePath);
      if (entry.createParents) {
        await rm(join(root, "parents"), { recursive: true });
      } else {
        await rm(absolutePath);
      }

      await hashlineWrite.execute(
        {
          filePath: entry.filePath,
          content: "one\ntwo\n",
          ...(entry.createParents ? { createParents: true } : {}),
        },
        toolContext,
      );
      await expect(
        edit.execute(replaceArgs(entry.filePath, String(stale.metadata.snapshotId)), toolContext),
      ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
      expect(await readFile(absolutePath, "utf8")).toBe("one\ntwo\n");
    }
  });

  test("invalidates a write target when no-clobber publication loses a race", async () => {
    const { value } = await aliasHarness();
    const { edit, hashlineWrite } = aliasRegistry(value);
    const toolContext = context({ sessionID: "write-race" });
    const filePath = "raced-target.txt";
    const absolutePath = join(root, filePath);
    await writeFile(absolutePath, "one\ntwo\n");
    const stale = await issueSnapshot(value, toolContext, filePath);
    await rm(absolutePath);

    const linkMock = spyOn(fsPromises, "link").mockImplementation(async (_source, target) => {
      await writeFile(target, "raced\n");
      throw Object.assign(new Error("simulated target race"), { code: "EEXIST" });
    });
    try {
      await expect(
        hashlineWrite.execute({ filePath, content: "one\ntwo\n" }, toolContext),
      ).rejects.toThrow("TARGET_EXISTS:");
    } finally {
      linkMock.mockRestore();
    }

    await expect(
      edit.execute(replaceArgs(filePath, String(stale.metadata.snapshotId)), toolContext),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(absolutePath, "utf8")).toBe("raced\n");
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

describe("native alias live epoch recovery", () => {
  test("never fetches history while a fresh read, before-hook, and edit succeed", async () => {
    const sessionID = "history-endpoint-throws";
    const { value, historyCalls } = await aliasHarness({
      historyFetch() {
        throw new Error("history endpoint must not be called");
      },
    });
    const toolContext = context({ sessionID });
    await writeFile(join(root, "fresh.txt"), "one\ntwo\n");
    const snapshot = await issueSnapshot(value, toolContext, "fresh.txt");
    const args = replaceArgs("fresh.txt", String(snapshot.metadata.snapshotId), "FRESH");

    await expect(
      value["tool.execute.before"]?.({ tool: "edit", sessionID, callID: "edit-call" }, { args }),
    ).resolves.toBeUndefined();
    await aliasRegistry(value).edit.execute(args, toolContext);

    expect(historyCalls).toEqual([]);
    expect(await readFile(join(root, "fresh.txt"), "utf8")).toBe("one\nFRESH\n");
  });

  test("ignores oversized, malformed, sanitized, duplicated, and old forensic history live", async () => {
    const histories: Array<[string, unknown]> = [
      ["oversized", "x".repeat(2 * 1024 * 1024)],
      ["malformed", { messages: "not-an-array" }],
      [
        "sanitized",
        [{ parts: [{ type: "tool", tool: "edit", state: { status: "completed", metadata: {} } }] }],
      ],
      [
        "duplicated",
        [
          { parts: [{ id: "duplicate", type: "tool", tool: "edit" }] },
          { parts: [{ id: "duplicate", type: "tool", tool: "edit" }] },
        ],
      ],
      [
        "old-identity",
        [
          {
            parts: [
              {
                type: "tool",
                tool: "apply_patch",
                state: {
                  status: "completed",
                  metadata: {
                    betterHashline: {
                      protocol: "native-aliases/v1",
                      packageVersion: "0.0.0",
                      schemaSha256: "0".repeat(64),
                      hostVersion: "0.0.0",
                      surface: "apply_patch",
                    },
                  },
                },
              },
            ],
          },
        ],
      ],
    ];

    for (const [name, history] of histories) {
      const harness = await aliasHarness({ history });
      const toolContext = context({ sessionID: `irrelevant-${name}` });
      const filePath = `irrelevant-${name}.txt`;
      await writeFile(join(root, filePath), "one\ntwo\n");
      const snapshot = await issueSnapshot(harness.value, toolContext, filePath);
      await aliasRegistry(harness.value).edit.execute(
        replaceArgs(filePath, String(snapshot.metadata.snapshotId), "LIVE"),
        toolContext,
      );
      expect(harness.historyCalls).toEqual([]);
      expect(await readFile(join(root, filePath), "utf8")).toBe("one\nLIVE\n");
    }
  });

  test("rejects unknown, unissued, and cross-session snapshots in hooks and direct execution", async () => {
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const before = value["tool.execute.before"];
    if (!before) throw new Error("Missing before hook");
    const owner = context({ sessionID: "snapshot-owner" });
    await writeFile(join(root, "owned.txt"), "one\ntwo\n");
    await writeFile(join(root, "unissued.txt"), "one\ntwo\n");
    await writeFile(join(root, "intruder.txt"), "one\ntwo\n");
    const owned = await issueSnapshot(value, owner, "owned.txt");

    const unknown = replaceArgs("owned.txt", "s_AAAAAAAAAAAAAAAAAAAAAA");
    await expect(
      before({ tool: "edit", sessionID: owner.sessionID, callID: "unknown" }, { args: unknown }),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await expect(edit.execute(unknown, owner)).rejects.toThrow("SNAPSHOT_UNKNOWN:");

    const pending = structured(await hashlineRead.execute({ filePath: "unissued.txt" }, owner));
    const unissued = replaceArgs("unissued.txt", String(pending.metadata.snapshotId));
    await expect(
      before({ tool: "edit", sessionID: owner.sessionID, callID: "unissued" }, { args: unissued }),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await expect(edit.execute(unissued, owner)).rejects.toThrow("SNAPSHOT_REQUIRED:");

    const intruder = context({ sessionID: "snapshot-intruder" });
    await issueSnapshot(value, intruder, "intruder.txt");
    const crossSession = replaceArgs("owned.txt", String(owned.metadata.snapshotId));
    await expect(
      before(
        { tool: "edit", sessionID: intruder.sessionID, callID: "cross-session" },
        { args: crossSession },
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await expect(edit.execute(crossSession, intruder)).rejects.toThrow("SNAPSHOT_UNKNOWN:");

    const delivered = await issueSnapshot(value, owner, "unissued.txt");
    await edit.execute(
      replaceArgs("unissued.txt", String(delivered.metadata.snapshotId), "RECOVERED"),
      owner,
    );
    expect(await readFile(join(root, "unissued.txt"), "utf8")).toBe("one\nRECOVERED\n");
  });

  test("expires old IDs in hooks and direct execution and recovers with a new read", async () => {
    const baseTime = 10_000;
    const now = spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const { value } = await aliasHarness({ pluginOptions: { snapshotTtlMs: 1_000 } });
      const { edit } = aliasRegistry(value);
      const before = value["tool.execute.before"];
      if (!before) throw new Error("Missing before hook");
      const toolContext = context({ sessionID: "expired-snapshots" });
      await writeFile(join(root, "expired-hook.txt"), "one\ntwo\n");
      await writeFile(join(root, "expired-direct.txt"), "one\ntwo\n");
      const hookSnapshot = await issueSnapshot(value, toolContext, "expired-hook.txt");
      const directSnapshot = await issueSnapshot(value, toolContext, "expired-direct.txt");
      now.mockReturnValue(baseTime + 1_001);

      const hookArgs = replaceArgs("expired-hook.txt", String(hookSnapshot.metadata.snapshotId));
      await expect(
        before(
          { tool: "edit", sessionID: toolContext.sessionID, callID: "expired-hook" },
          { args: hookArgs },
        ),
      ).rejects.toThrow("SNAPSHOT_EXPIRED:");
      await expect(
        edit.execute(
          replaceArgs("expired-direct.txt", String(directSnapshot.metadata.snapshotId)),
          toolContext,
        ),
      ).rejects.toThrow("SNAPSHOT_EXPIRED:");

      const fresh = await issueSnapshot(value, toolContext, "expired-hook.txt");
      expect(fresh.metadata.snapshotId).not.toBe(hookSnapshot.metadata.snapshotId);
      await edit.execute(
        replaceArgs("expired-hook.txt", String(fresh.metadata.snapshotId), "RECOVERED"),
        toolContext,
      );
      expect(await readFile(join(root, "expired-hook.txt"), "utf8")).toBe("one\nRECOVERED\n");
    } finally {
      now.mockRestore();
    }
  });

  test("replaces a mismatched worktree epoch only after a fresh delivered read", async () => {
    const nestedWorktree = join(root, "nested-worktree");
    await fsPromises.mkdir(nestedWorktree);
    await writeFile(join(root, "root-file.txt"), "one\ntwo\n");
    await writeFile(join(nestedWorktree, "nested.txt"), "one\ntwo\n");
    const sessionID = "worktree-replacement";
    const { value } = await aliasHarness({ worktree: nestedWorktree });
    const { edit } = aliasRegistry(value);
    const rootContext = context({ sessionID, worktree: root });
    const rootSnapshot = await issueSnapshot(value, rootContext, "root-file.txt");
    const rootArgs = replaceArgs("root-file.txt", String(rootSnapshot.metadata.snapshotId));

    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=mismatch");
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID, callID: "root-worktree" },
        { args: rootArgs },
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");

    const nestedContext = context({ sessionID, worktree: nestedWorktree });
    const nestedSnapshot = await issueSnapshot(value, nestedContext, "nested-worktree/nested.txt");
    const nestedArgs = replaceArgs(
      "nested-worktree/nested.txt",
      String(nestedSnapshot.metadata.snapshotId),
      "NESTED",
    );
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID, callID: "nested-worktree" },
        { args: nestedArgs },
      ),
    ).resolves.toBeUndefined();
    await edit.execute(nestedArgs, nestedContext);
    await expect(edit.execute(rootArgs, nestedContext)).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(join(nestedWorktree, "nested.txt"), "utf8")).toBe("one\nNESTED\n");
  });

  test("distinguishes root mismatch from worktree inspection failure", async () => {
    const { value } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const args = replaceArgs("missing.txt", "s_AAAAAAAAAAAAAAAAAAAAAA");

    if (process.platform === "win32") {
      const currentDrive = root.slice(0, 2).toUpperCase();
      const otherRoot = currentDrive === "Z:" ? "Y:\\" : "Z:\\";
      const mismatch = await rejectionMessage(
        edit.execute(args, context({ sessionID: "root-mismatch", worktree: otherRoot })),
      );
      expect(mismatch).toContain("different filesystem roots");
      expect(mismatch).toContain("same session");
      expect(mismatch).not.toContain("could not be inspected");
    }

    const inspection = await rejectionMessage(
      edit.execute(
        args,
        context({
          sessionID: "inspection-failure",
          worktree: join(root, "missing-worktree"),
        }),
      ),
    );
    expect(inspection).toContain("worktree identity could not be inspected");
    expect(inspection).toContain("same session");
    expect(inspection).not.toContain("different filesystem roots");
  });

  test("requires a fresh current-process read after restart under the same session ID", async () => {
    await writeFile(join(root, "file.txt"), "one\ntwo\n");
    const toolContext = context({ sessionID: "same-session-restart" });
    const first = await aliasHarness();
    const staleRead = await issueSnapshot(first.value, toolContext, "file.txt");
    await first.value.dispose?.();

    const second = await aliasHarness({
      historyFetch() {
        throw new Error("history endpoint must not be called after restart");
      },
    });
    const { edit } = aliasRegistry(second.value);
    const staleArgs = replaceArgs("file.txt", String(staleRead.metadata.snapshotId));
    await expect(edit.execute(staleArgs, toolContext)).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await expect(
      second.value["tool.execute.before"]?.(
        { tool: "edit", sessionID: toolContext.sessionID, callID: "stale-after-restart" },
        { args: staleArgs },
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");

    const freshRead = await issueSnapshot(second.value, toolContext, "file.txt");
    const freshArgs = replaceArgs("file.txt", String(freshRead.metadata.snapshotId), "RESTARTED");
    await expect(
      second.value["tool.execute.before"]?.(
        { tool: "edit", sessionID: toolContext.sessionID, callID: "fresh-after-restart" },
        { args: freshArgs },
      ),
    ).resolves.toBeUndefined();
    await edit.execute(freshArgs, toolContext);

    expect(second.historyCalls).toEqual([]);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one\nRESTARTED\n");
  });

  test("shares one authority across concurrent same-fingerprint read deliveries", async () => {
    await writeFile(join(root, "concurrent-a.txt"), "one\ntwo\n");
    await writeFile(join(root, "concurrent-b.txt"), "one\ntwo\n");
    const sessionID = "concurrent-same-fingerprint";
    const toolContext = context({ sessionID });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const [pendingA, pendingB] = await Promise.all([
      hashlineRead.execute({ filePath: "concurrent-a.txt" }, toolContext).then(structured),
      hashlineRead.execute({ filePath: "concurrent-b.txt" }, toolContext).then(structured),
    ]);

    await deliverReadResult(value, toolContext, "concurrent-b.txt", pendingB, "read-b");
    await deliverReadResult(value, toolContext, "concurrent-a.txt", pendingA, "read-a");
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");

    await edit.execute(
      replaceArgs("concurrent-a.txt", String(pendingA.metadata.snapshotId), "A"),
      toolContext,
    );
    await edit.execute(
      replaceArgs("concurrent-b.txt", String(pendingB.metadata.snapshotId), "B"),
      toolContext,
    );
    expect(await readFile(join(root, "concurrent-a.txt"), "utf8")).toBe("one\nA\n");
    expect(await readFile(join(root, "concurrent-b.txt"), "utf8")).toBe("one\nB\n");
  });

  test("does not bind a read prepared before partial publication unbinds its session", async () => {
    await writeFile(join(root, "paused-before-stable.txt"), "one\ntwo\n");
    await writeFile(join(root, "partial-recovery.txt"), "one\ntwo\n");
    const sessionID = "partial-during-read";
    let markReadAuthorization = () => {};
    const readAuthorizationStarted = new Promise<void>((resolve) => {
      markReadAuthorization = resolve;
    });
    let releaseReadAuthorization = () => {};
    const readAuthorizationGate = new Promise<void>((resolve) => {
      releaseReadAuthorization = resolve;
    });
    let readPaused = false;
    const pausedContext = context({
      sessionID,
      async onAsk(request) {
        if (request.permission !== "read" || readPaused) return;
        readPaused = true;
        markReadAuthorization();
        await readAuthorizationGate;
      },
    });
    const toolContext = context({ sessionID });
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);
    const pendingRead = tools.hashlineRead
      .execute({ filePath: "paused-before-stable.txt" }, pausedContext)
      .then(structured);
    await readAuthorizationStarted;

    const realMkdir = fsPromises.mkdir;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      throw new Error("simulated post-mkdir failure");
    });
    try {
      await expect(
        tools.hashlineWrite.execute(
          {
            filePath: "partial-during-read/inner/created.txt",
            content: "created\n",
            createParents: true,
          },
          toolContext,
        ),
      ).rejects.toThrow("resume this same session");
    } finally {
      mkdirMock.mockRestore();
      releaseReadAuthorization();
    }

    const delayed = await pendingRead;
    const delayedSnapshotId = String(delayed.metadata.snapshotId);
    await deliverReadResult(
      value,
      pausedContext,
      "paused-before-stable.txt",
      delayed,
      "read-after-partial",
    );
    expect(delayed.output).toStartWith("SNAPSHOT_REQUIRED:");
    expect(delayed.metadata.snapshotId).toBeUndefined();
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=unbound");

    const fresh = await issueSnapshot(value, toolContext, "partial-recovery.txt");
    await expect(
      tools.edit.execute(
        replaceArgs("paused-before-stable.txt", delayedSnapshotId, "STALE"),
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await tools.edit.execute(
      replaceArgs("partial-recovery.txt", String(fresh.metadata.snapshotId), "RECOVERED"),
      toolContext,
    );
    expect(await readFile(join(root, "partial-recovery.txt"), "utf8")).toBe("one\nRECOVERED\n");
  });

  test("preserves the active epoch when a same-key prepared read fails", async () => {
    await writeFile(join(root, "same-key-active.txt"), "one\ntwo\n");
    await writeFile(join(root, "same-key-failed.txt"), "one\ntwo\n");
    const sessionID = "same-key-failed-read";
    const toolContext = context({ sessionID });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const active = await issueSnapshot(value, toolContext, "same-key-active.txt");
    const deniedContext = context({
      sessionID,
      onAsk(request) {
        if (request.permission === "read") throw new Error("read denied");
      },
    });

    await expect(
      hashlineRead.execute({ filePath: "same-key-failed.txt" }, deniedContext),
    ).rejects.toThrow("PERMISSION_DENIED:");
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
    await edit.execute(
      replaceArgs("same-key-active.txt", String(active.metadata.snapshotId), "ACTIVE"),
      toolContext,
    );
    expect(await readFile(join(root, "same-key-active.txt"), "utf8")).toBe("one\nACTIVE\n");
  });

  test("retires the active epoch when a differing-key prepared read fails", async () => {
    const nested = join(root, "failed-differing-worktree");
    await fsPromises.mkdir(nested);
    await writeFile(join(root, "differing-active.txt"), "one\ntwo\n");
    await writeFile(join(nested, "failed.txt"), "one\ntwo\n");
    const sessionID = "differing-key-failed-read";
    const rootContext = context({ sessionID, worktree: root });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const active = await issueSnapshot(value, rootContext, "differing-active.txt");
    const deniedNestedContext = context({
      sessionID,
      worktree: nested,
      onAsk(request) {
        if (request.permission === "read") throw new Error("read denied");
      },
    });

    await expect(
      hashlineRead.execute(
        { filePath: "failed-differing-worktree/failed.txt" },
        deniedNestedContext,
      ),
    ).rejects.toThrow("PERMISSION_DENIED:");
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=unbound");
    await expect(
      edit.execute(
        replaceArgs("differing-active.txt", String(active.metadata.snapshotId), "STALE"),
        rootContext,
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");

    const fresh = await issueSnapshot(value, rootContext, "differing-active.txt");
    expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
    await edit.execute(
      replaceArgs("differing-active.txt", String(fresh.metadata.snapshotId), "RECOVERED"),
      rootContext,
    );
    expect(await readFile(join(root, "differing-active.txt"), "utf8")).toBe("one\nRECOVERED\n");
  });

  test("does not roll a differing worktree candidate backward when hooks reorder", async () => {
    const nested = join(root, "reordered-worktree");
    await fsPromises.mkdir(nested);
    await writeFile(join(root, "reordered-root.txt"), "one\ntwo\n");
    await writeFile(join(nested, "nested.txt"), "one\ntwo\n");
    const sessionID = "reordered-worktrees";
    const rootContext = context({ sessionID, worktree: root });
    const nestedContext = context({ sessionID, worktree: nested });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const pendingRoot = structured(
      await hashlineRead.execute({ filePath: "reordered-root.txt" }, rootContext),
    );
    const rootSnapshotId = String(pendingRoot.metadata.snapshotId);
    const pendingNested = structured(
      await hashlineRead.execute({ filePath: "reordered-worktree/nested.txt" }, nestedContext),
    );

    await deliverReadResult(
      value,
      nestedContext,
      "reordered-worktree/nested.txt",
      pendingNested,
      "nested-last",
    );
    await deliverReadResult(value, rootContext, "reordered-root.txt", pendingRoot, "root-delayed");
    expect(pendingRoot.output).toStartWith("SNAPSHOT_REQUIRED:");
    expect(pendingRoot.metadata.snapshotId).toBeUndefined();
    await edit.execute(
      replaceArgs(
        "reordered-worktree/nested.txt",
        String(pendingNested.metadata.snapshotId),
        "NESTED",
      ),
      nestedContext,
    );
    await expect(
      edit.execute(replaceArgs("reordered-root.txt", rootSnapshotId, "STALE"), rootContext),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
  });

  test("never revives the first A authority after an A to B to A sequence", async () => {
    const nested = join(root, "aba-worktree");
    await fsPromises.mkdir(nested);
    await writeFile(join(root, "aba-root.txt"), "one\ntwo\n");
    await writeFile(join(nested, "nested.txt"), "one\ntwo\n");
    const sessionID = "a-b-a";
    const rootContext = context({ sessionID, worktree: root });
    const nestedContext = context({ sessionID, worktree: nested });
    const { value } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const firstA = await issueSnapshot(value, rootContext, "aba-root.txt");
    await issueSnapshot(value, nestedContext, "aba-worktree/nested.txt");
    const secondA = await issueSnapshot(value, rootContext, "aba-root.txt");

    expect(secondA.metadata.snapshotId).not.toBe(firstA.metadata.snapshotId);
    await expect(
      edit.execute(
        replaceArgs("aba-root.txt", String(firstA.metadata.snapshotId), "OLD-A"),
        rootContext,
      ),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    await edit.execute(
      replaceArgs("aba-root.txt", String(secondA.metadata.snapshotId), "NEW-A"),
      rootContext,
    );
    expect(await readFile(join(root, "aba-root.txt"), "utf8")).toBe("one\nNEW-A\n");
  });

  test("does not issue delayed edit readback after its authority retires", async () => {
    const nested = join(root, "readback-retirement");
    await fsPromises.mkdir(nested);
    await writeFile(join(root, "readback.txt"), "one\ntwo\n");
    await writeFile(join(nested, "nested.txt"), "one\ntwo\n");
    const sessionID = "delayed-readback-retirement";
    const rootContext = context({ sessionID, worktree: root });
    const nestedContext = context({ sessionID, worktree: nested });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const issued = await issueSnapshot(value, rootContext, "readback.txt");
    const args = {
      ...replaceArgs("readback.txt", String(issued.metadata.snapshotId)),
      readback: true,
    };
    const pendingEdit = structured(await edit.execute(args, rootContext));
    const successor = /@hashline snapshot=(s_[A-Za-z0-9_-]+)/.exec(pendingEdit.output)?.[1];
    expect(successor).toBeString();
    const replacementCandidate = structured(
      await hashlineRead.execute({ filePath: "readback-retirement/nested.txt" }, nestedContext),
    );

    await value["tool.execute.after"]?.(
      { tool: "edit", sessionID, callID: "delayed-edit", args },
      pendingEdit,
    );
    expect(pendingEdit.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=unavailable next=hashline_read",
    );
    expect(pendingEdit.metadata.hashlinePending).toBeUndefined();
    await deliverReadResult(
      value,
      nestedContext,
      "readback-retirement/nested.txt",
      replacementCandidate,
      "replacement-candidate",
    );
    await issueSnapshot(value, rootContext, "readback.txt");
    await expect(
      edit.execute(replaceArgs("readback.txt", String(successor), "STALE"), rootContext),
    ).rejects.toThrow("SNAPSHOT_REQUIRED:");
    expect(await readFile(join(root, "readback.txt"), "utf8")).toBe("one\nTWO\n");
  });

  test("fails pending read delivery after snapshot expiry", async () => {
    const baseTime = 50_000;
    const now = spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      await writeFile(join(root, "pending-expiry.txt"), "one\ntwo\n");
      const toolContext = context({ sessionID: "pending-expiry" });
      const { value } = await aliasHarness({ pluginOptions: { snapshotTtlMs: 1_000 } });
      const { hashlineRead } = aliasRegistry(value);
      const pending = structured(
        await hashlineRead.execute({ filePath: "pending-expiry.txt" }, toolContext),
      );
      now.mockReturnValue(baseTime + 1_001);

      await deliverReadResult(value, toolContext, "pending-expiry.txt", pending);
      expect(pending.output).toStartWith("SNAPSHOT_EXPIRED:");
      expect(pending.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });
      expect(await systemGuidance(value, toolContext.sessionID)).toContain(
        "native-alias-session=unbound",
      );
    } finally {
      now.mockRestore();
    }
  });

  test("fails evicted and replayed pending read markers without issuing them", async () => {
    await writeFile(join(root, "pending-eviction.txt"), "one\ntwo\n");
    const toolContext = context({ sessionID: "pending-eviction" });
    const { value } = await aliasHarness({
      pluginOptions: {
        maxSnapshots: 2,
        maxSnapshotsPerPath: 1,
        maxSnapshotsPerSession: 2,
      },
    });
    const { hashlineRead } = aliasRegistry(value);
    const evicted = structured(
      await hashlineRead.execute({ filePath: "pending-eviction.txt" }, toolContext),
    );
    await writeFile(join(root, "pending-eviction.txt"), "one\nchanged\n");
    const current = structured(
      await hashlineRead.execute({ filePath: "pending-eviction.txt" }, toolContext),
    );

    await deliverReadResult(value, toolContext, "pending-eviction.txt", evicted, "evicted");
    expect(evicted.output).toStartWith("SNAPSHOT_UNKNOWN:");
    expect(evicted.metadata.snapshotId).toBeUndefined();

    const replayedPendingId = String(current.metadata.hashlinePending);
    const replayedSnapshotId = String(current.metadata.snapshotId);
    await deliverReadResult(value, toolContext, "pending-eviction.txt", current, "current");
    current.metadata.hashlinePending = replayedPendingId;
    current.metadata.snapshotId = replayedSnapshotId;
    await deliverReadResult(value, toolContext, "pending-eviction.txt", current, "replayed");
    expect(current.output).toBe(
      "SNAPSHOT_REQUIRED: The delivered read did not match a live pending snapshot. Rerun hashline_read in this same session; old snapshot IDs cannot be revived.",
    );
    expect(current.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });
  });

  test("fails pending read delivery when worktree inspection disappears", async () => {
    const nested = join(root, "vanishing-worktree");
    await fsPromises.mkdir(nested);
    await writeFile(join(nested, "file.txt"), "one\ntwo\n");
    const toolContext = context({ sessionID: "vanishing-worktree", worktree: nested });
    const { value } = await aliasHarness();
    const { hashlineRead } = aliasRegistry(value);
    const pending = structured(
      await hashlineRead.execute({ filePath: "vanishing-worktree/file.txt" }, toolContext),
    );
    await rm(nested, { recursive: true });

    await deliverReadResult(value, toolContext, "vanishing-worktree/file.txt", pending);
    expect(pending.output).toContain("worktree identity could not be inspected");
    expect(pending.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });
  });

  test("fails pending read delivery after a canonical worktree symlink retarget", async () => {
    const first = join(root, "retarget-first");
    const second = join(root, "retarget-second");
    const linked = join(root, "retarget-worktree");
    await fsPromises.mkdir(first);
    await fsPromises.mkdir(second);
    await writeFile(join(first, "file.txt"), "one\nfirst\n");
    await writeFile(join(second, "file.txt"), "one\nsecond\n");
    try {
      await fsPromises.symlink(first, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOTSUP") return;
      throw error;
    }
    const toolContext = context({ sessionID: "retarget-worktree", worktree: linked });
    const { value } = await aliasHarness();
    const { hashlineRead } = aliasRegistry(value);
    const pending = structured(
      await hashlineRead.execute({ filePath: "retarget-worktree/file.txt" }, toolContext),
    );
    await fsPromises.unlink(linked);
    await fsPromises.symlink(second, linked, process.platform === "win32" ? "junction" : "dir");

    await deliverReadResult(value, toolContext, "retarget-worktree/file.txt", pending);
    expect(pending.output).toStartWith("SNAPSHOT_REQUIRED:");
    expect(pending.output).toContain("canonical worktree");
    expect(pending.metadata).toEqual({ nextOffset: undefined, displayedLines: 2 });
  });

  test("fences a mutation paused in authorization before publication", async () => {
    const nested = join(root, "authorization-retirement");
    await fsPromises.mkdir(nested);
    await writeFile(join(root, "paused.txt"), "one\ntwo\n");
    await writeFile(join(nested, "nested.txt"), "one\ntwo\n");
    const sessionID = "authorization-retirement";
    let signalAuthorization = () => {};
    const authorizationStarted = new Promise<void>((resolve) => {
      signalAuthorization = resolve;
    });
    let releaseAuthorization = () => {};
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let signaled = false;
    const pausedContext = context({
      sessionID,
      worktree: root,
      async onAsk(request) {
        if (request.permission !== "edit") return;
        if (!signaled) {
          signaled = true;
          signalAuthorization();
        }
        await authorizationGate;
      },
    });
    const nestedContext = context({ sessionID, worktree: nested });
    const { value } = await aliasHarness();
    const { hashlineRead, edit } = aliasRegistry(value);
    const issued = await issueSnapshot(value, pausedContext, "paused.txt");
    const mutation = edit.execute(
      replaceArgs("paused.txt", String(issued.metadata.snapshotId), "PUBLISHED"),
      pausedContext,
    );
    await authorizationStarted;
    const replacementCandidate = structured(
      await hashlineRead.execute(
        { filePath: "authorization-retirement/nested.txt" },
        nestedContext,
      ),
    );
    releaseAuthorization();

    await expect(mutation).rejects.toThrow("SNAPSHOT_REQUIRED:");
    expect(await readFile(join(root, "paused.txt"), "utf8")).toBe("one\ntwo\n");
    await deliverReadResult(
      value,
      nestedContext,
      "authorization-retirement/nested.txt",
      replacementCandidate,
    );
  });

  test("fences lifecycle mutations paused in authorization before publication", async () => {
    const { value } = await aliasHarness();
    const tools = aliasRegistry(value);
    const before = value["tool.execute.before"];
    if (!before) throw new Error("Missing before hook");
    const cases = [
      {
        operation: "delete_file" as const,
        surface: "edit" as const,
        filePath: "paused-delete.txt",
      },
      {
        operation: "move_file" as const,
        surface: "apply_patch" as const,
        filePath: "paused-move.txt",
        destinationPath: "moved-after-pause.txt",
      },
    ];

    for (const entry of cases) {
      const nestedName = `authorization-retirement-${entry.operation}`;
      const nested = join(root, nestedName);
      const sourcePath = join(root, entry.filePath);
      await fsPromises.mkdir(nested);
      await writeFile(sourcePath, "preserved\n");
      await writeFile(join(nested, "nested.txt"), "replacement\n");
      const originalBytes = await readFile(sourcePath);
      const sessionID = nestedName;
      let signalAuthorization = () => {};
      const authorizationStarted = new Promise<void>((resolve) => {
        signalAuthorization = resolve;
      });
      let releaseAuthorization = () => {};
      const authorizationGate = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      let signaled = false;
      const pausedContext = context({
        sessionID,
        worktree: root,
        async onAsk(request) {
          if (request.permission !== "edit") return;
          if (!signaled) {
            signaled = true;
            signalAuthorization();
          }
          await authorizationGate;
        },
      });
      const nestedContext = context({ sessionID, worktree: nested });
      const issued = await issueSnapshot(value, pausedContext, entry.filePath);
      const operation =
        entry.operation === "delete_file"
          ? { op: entry.operation }
          : { op: entry.operation, destinationPath: entry.destinationPath };
      const args = {
        filePath: entry.filePath,
        snapshotId: String(issued.metadata.snapshotId),
        operations: [operation],
      };

      expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
      await expect(
        before({ tool: entry.surface, sessionID, callID: `${entry.operation}-admitted` }, { args }),
      ).resolves.toBeUndefined();
      const mutation =
        entry.surface === "edit"
          ? tools.edit.execute(args, pausedContext)
          : tools.applyPatch.execute(args, pausedContext);
      await authorizationStarted;

      const candidatePath = `${nestedName}/nested.txt`;
      const replacementCandidate = structured(
        await tools.hashlineRead.execute({ filePath: candidatePath }, nestedContext),
      );
      expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=unbound");
      releaseAuthorization();

      expect(await rejectionMessage(mutation)).toBe(
        "SNAPSHOT_REQUIRED: The admitted native-alias read epoch retired before publication could begin. Rerun hashline_read in this same session and use only the snapshot ID returned by that read; old snapshot IDs cannot be revived.",
      );
      expect(await readFile(sourcePath)).toEqual(originalBytes);
      if (entry.operation === "move_file") {
        await expect(readFile(join(root, entry.destinationPath))).rejects.toThrow();
      }

      await deliverReadResult(
        value,
        nestedContext,
        candidatePath,
        replacementCandidate,
        `${entry.operation}-replacement`,
      );
      const recovered = await issueSnapshot(value, pausedContext, entry.filePath);
      expect(recovered.metadata.snapshotId).not.toBe(issued.metadata.snapshotId);
      expect(await systemGuidance(value, sessionID)).toContain("native-alias-session=bound");
      await expect(
        before(
          { tool: entry.surface, sessionID, callID: `${entry.operation}-recovered` },
          { args: { ...args, snapshotId: String(recovered.metadata.snapshotId) } },
        ),
      ).resolves.toBeUndefined();
    }
  });

  test("invalidates equivalent raw worktree spellings for the same session path", async () => {
    await writeFile(join(root, "equivalent-worktree.txt"), "one\ntwo\n");
    const sessionID = "equivalent-worktree-spellings";
    const directContext = context({ sessionID, worktree: root });
    const equivalentContext = context({ sessionID, worktree: `${root}/.` });
    const { value } = await aliasHarness();
    const { edit } = aliasRegistry(value);
    const direct = await issueSnapshot(value, directContext, "equivalent-worktree.txt");
    const equivalent = await issueSnapshot(value, equivalentContext, "equivalent-worktree.txt");

    await edit.execute(
      replaceArgs("equivalent-worktree.txt", String(direct.metadata.snapshotId), "DIRECT"),
      directContext,
    );
    await expect(
      edit.execute(
        replaceArgs(
          "equivalent-worktree.txt",
          String(equivalent.metadata.snapshotId),
          "EQUIVALENT",
        ),
        equivalentContext,
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(join(root, "equivalent-worktree.txt"), "utf8")).toBe("one\nDIRECT\n");
  });
});
