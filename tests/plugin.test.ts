import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import { betterHashlinePlugin } from "../src/plugin.js";

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

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "better-hashline-plugin-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(
  input: {
    asks?: AskRecord[];
    deny?: string;
    sessionID?: string;
    controller?: AbortController;
  } = {},
): ToolContext {
  const controller = input.controller ?? new AbortController();
  return {
    sessionID: input.sessionID ?? "session",
    messageID: "message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: controller.signal,
    metadata() {},
    async ask(request) {
      input.asks?.push(request as AskRecord);
      if (request.permission === input.deny) throw new Error(`denied ${request.permission}`);
    },
  } as ToolContext;
}

async function hooks(options?: Record<string, unknown>): Promise<Hooks> {
  return betterHashlinePlugin({} as never, options);
}

function structured(result: unknown): StructuredResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("output" in result) ||
    typeof result.output !== "string"
  ) {
    throw new Error("Expected a structured tool result");
  }
  const metadata = "metadata" in result && result.metadata ? result.metadata : {};
  const title = "title" in result && typeof result.title === "string" ? result.title : "";
  return {
    ...(result as Omit<StructuredResult, "title" | "metadata">),
    title,
    metadata: metadata as Record<string, unknown>,
  };
}

function registry(value: Hooks) {
  if (!value.tool) throw new Error("Plugin did not register tools");
  const hashlineRead = value.tool.hashline_read;
  const hashlineEdit = value.tool.hashline_edit;
  const hashlineWrite = value.tool.hashline_write;
  if (!hashlineRead || !hashlineEdit || !hashlineWrite) {
    throw new Error("Plugin tool registry is incomplete");
  }
  return { hashlineRead, hashlineEdit, hashlineWrite };
}

async function activateRead(value: Hooks, result: StructuredResult): Promise<void> {
  const after = value["tool.execute.after"];
  if (!after) throw new Error("Plugin did not register its after hook");
  await after(
    {
      tool: "hashline_read",
      sessionID: "session",
      callID: "call",
      args: {},
    },
    result,
  );
}

describe("OpenCode plugin protocol", () => {
  test("issues refs only after delivery and applies an exact permitted edit", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const asks: AskRecord[] = [];
    const toolContext = context({ asks });
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    const snapshotId = String(readResult.metadata.snapshotId);
    expect(readResult.output).toContain("2|two");
    expect(asks.map(({ permission }) => permission)).toEqual(["read"]);

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");

    await activateRead(value, readResult);
    expect(readResult.metadata.hashlinePending).toBeUndefined();
    const editResult = structured(
      await hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    );
    expect(editResult.output).toContain("Applied 1 operation");
    expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree\n");
    expect(asks.at(-1)).toMatchObject({ permission: "edit" });
    expect(String(asks.at(-1)?.metadata?.diff)).toContain("-two");

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          rebase: "none",
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await value.dispose?.();
  });

  test("supports explicit unique relocation but keeps strict mode as default", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const snapshotId = String(readResult.metadata.snapshotId);
    await writeFile(file, "prefix\none\ntwo\nthree\n");

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          rebase: "none",
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("TARGET_CHANGED:");

    const result = structured(
      await hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          rebase: "unique",
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    );
    expect(result.metadata.rebased).toBe(true);
    expect(await readFile(file, "utf8")).toBe("prefix\none\nTWO\nthree\n");
  });

  test("rejects an edit whose composed result exceeds maxLines", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one");
    const asks: AskRecord[] = [];
    const value = await hooks({ maxFileBytes: 1024, maxCacheBytes: 3072, maxLines: 1 });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "insert", afterLine: 1, lines: ["two"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("UNSUPPORTED_FILE:");
    expect(await readFile(file, "utf8")).toBe("one");
    expect(asks.map(({ permission }) => permission)).toEqual(["read"]);
  });

  test("enforces issued pages and complete-file reads", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt", limit: 1 }, toolContext),
    );
    await activateRead(value, readResult);
    const snapshotId = String(readResult.metadata.snapshotId);
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          rebase: "none",
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          rebase: "none",
          operations: [{ op: "replace_file", lines: ["new"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
  });

  test("failed page delivery preserves older issued refs without issuing new ones", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();

    const issued = structured(
      await hashlineRead.execute({ filePath: "file.txt", limit: 1 }, toolContext),
    );
    await activateRead(value, issued);
    const snapshotId = String(issued.metadata.snapshotId);

    const truncated = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 2, limit: 1 }, toolContext),
    );
    truncated.metadata.truncated = true;
    await activateRead(value, truncated);
    expect(truncated.output).toContain("OpenCode truncated this result");
    expect(truncated.metadata.snapshotId).toBeUndefined();

    const missing = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 2, limit: 1 }, toolContext),
    );
    delete missing.metadata.hashlinePending;
    await activateRead(value, missing);
    expect(missing.output).toContain("did not preserve the snapshot marker");
    expect(missing.metadata.snapshotId).toBeUndefined();

    const changed = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 2, limit: 1 }, toolContext),
    );
    changed.output += "\nchanged by another hook";
    await activateRead(value, changed);
    expect(changed.output).toContain("Another hook changed this result");
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("ONE\ntwo\n");
  });

  test("pending-read eviction never revokes issued snapshots", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\n");
    const value = await hooks({
      maxFileBytes: 1024,
      maxLines: 10,
      maxCacheBytes: 3072,
      maxSnapshots: 1,
      maxSnapshotsPerPath: 1,
      maxSnapshotsPerSession: 1,
    });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const issued = structured(await hashlineRead.execute({ filePath: "file.txt" }, toolContext));
    await activateRead(value, issued);
    const snapshotId = String(issued.metadata.snapshotId);

    const evictedPending = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    const latestPending = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, evictedPending);
    expect(evictedPending.output).toContain("Rerun hashline_read");
    await activateRead(value, latestPending);

    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("ONE\n");
  });

  test("marker loss does not revoke another pending page for the same snapshot", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const lost = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 1, limit: 1 }, toolContext),
    );
    const delivered = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 2, limit: 1 }, toolContext),
    );
    expect(lost.metadata.snapshotId).toBe(delivered.metadata.snapshotId);

    delete lost.metadata.hashlinePending;
    await activateRead(value, lost);
    expect(lost.output).toContain("did not preserve the snapshot marker");
    await activateRead(value, delivered);

    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId: String(delivered.metadata.snapshotId),
        operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("one\nTWO\n");
  });

  test("pending cleanup preserves distinct issued revisions on the same path", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\n");
    const value = await hooks({
      maxFileBytes: 1024,
      maxLines: 10,
      maxCacheBytes: 4096,
      maxSnapshots: 2,
      maxSnapshotsPerPath: 2,
      maxSnapshotsPerSession: 2,
    });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const issued = structured(await hashlineRead.execute({ filePath: "file.txt" }, toolContext));
    await activateRead(value, issued);
    const issuedId = String(issued.metadata.snapshotId);

    await writeFile(file, "prefix\none\n");
    const evictedPending = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await hashlineRead.execute({ filePath: "file.txt" }, toolContext);
    await hashlineRead.execute({ filePath: "file.txt" }, toolContext);
    await activateRead(value, evictedPending);
    expect(evictedPending.output).toContain("Rerun hashline_read");

    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId: issuedId,
        rebase: "unique",
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("prefix\nONE\n");
  });

  test("permission denial writes nothing and leaves the snapshot retryable", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const allowed = context();
    const readResult = structured(await hashlineRead.execute({ filePath: "file.txt" }, allowed));
    await activateRead(value, readResult);
    const request = {
      filePath: "file.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      rebase: "none" as const,
      operations: [{ op: "replace" as const, startLine: 1, endLine: 1, lines: ["new"] }],
    };
    await expect(hashlineEdit.execute(request, context({ deny: "edit" }))).rejects.toThrow(
      "PERMISSION_DENIED:",
    );
    expect(await readFile(file, "utf8")).toBe("old\n");
    await hashlineEdit.execute(request, allowed);
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  test("rejects copied display prefixes unless explicitly opted in", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const base = {
      filePath: "file.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      rebase: "none" as const,
      operations: [{ op: "replace" as const, startLine: 1, endLine: 1, lines: ["1|old"] }],
    };
    await expect(hashlineEdit.execute(base, toolContext)).rejects.toThrow(
      "DISPLAY_PREFIX_REJECTED:",
    );
    await hashlineEdit.execute({ ...base, allowHashlinePrefixes: true }, toolContext);
    expect(await readFile(file, "utf8")).toBe("1|old\n");
  });

  test("never publishes an edit that its own reader would reject", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["\u0001"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("UNSUPPORTED_FILE:");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  test("validates the flat provider-compatible operation schema", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const common = {
      filePath: "file.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      rebase: "none" as const,
    };

    await expect(
      hashlineEdit.execute(
        { ...common, operations: [{ op: "replace", startLine: 1, lines: ["new"] }] },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    await expect(
      hashlineEdit.execute(
        {
          ...common,
          operations: [{ op: "insert", afterLine: 0, lines: [], finalNewline: true }],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    await expect(
      hashlineEdit.execute(
        { ...common, operations: [{ op: "replace_file", afterLine: 0, lines: ["new"] }] },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  test("validates complete tool arguments before permissions or filesystem access", async () => {
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit, hashlineWrite } = registry(value);
    const toolContext = context({ asks });

    await expect(
      hashlineRead.execute({ filePath: "missing.txt", unexpected: true } as never, toolContext),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    await expect(
      hashlineEdit.execute(
        {
          filePath: "missing.txt",
          snapshotId: "s_0000000000000000000000",
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: [], unexpected: true }],
        } as never,
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    await expect(
      hashlineEdit.execute(
        {
          filePath: "missing.txt",
          snapshotId: "s_0000000000000000000000",
          operations: [{ op: "replace", startLine: 1, lines: ["new"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    await expect(
      hashlineWrite.execute({ filePath: "new.txt", content: 1 } as never, toolContext),
    ).rejects.toThrow("INVALID_ARGUMENT:");
    expect(asks).toEqual([]);
    await expect(readFile(join(root, "new.txt"))).rejects.toThrow();
  });

  test("rejects semantic edit errors before external authorization", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "better-hashline-plugin-external-"));
    try {
      const file = join(externalRoot, "file.txt");
      await writeFile(file, "one\ntwo\n");
      const asks: AskRecord[] = [];
      const value = await hooks();
      const { hashlineRead, hashlineEdit } = registry(value);
      const toolContext = context({ asks });
      const readResult = structured(await hashlineRead.execute({ filePath: file }, toolContext));
      await activateRead(value, readResult);
      asks.length = 0;

      await expect(
        hashlineEdit.execute(
          {
            filePath: file,
            snapshotId: String(readResult.metadata.snapshotId),
            operations: [{ op: "replace", startLine: 2, endLine: 1, lines: ["invalid"] }],
          },
          toolContext,
        ),
      ).rejects.toThrow("INVALID_ARGUMENT:");
      expect(asks).toEqual([]);
      expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  test("creates new files exclusively through hashline_write", async () => {
    const asks: AskRecord[] = [];
    const value = await hooks({ maxFileBytes: 1024, maxCacheBytes: 3072 });
    const { hashlineWrite } = registry(value);
    const toolContext = context({ asks });
    const result = structured(
      await hashlineWrite.execute({ filePath: "new.txt", content: "created\n" }, toolContext),
    );
    expect(result.output).toContain("Created the file");
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created\n");
    expect(asks.at(-1)).toMatchObject({ permission: "edit" });
    await expect(
      hashlineWrite.execute({ filePath: "new.txt", content: "overwrite" }, toolContext),
    ).rejects.toThrow("TARGET_EXISTS:");
    await expect(
      hashlineWrite.execute({ filePath: "large.txt", content: "x".repeat(1025) }, toolContext),
    ).rejects.toThrow("UNSUPPORTED_FILE:");
    if (process.platform === "win32") {
      const askCount = asks.length;
      await expect(
        hashlineWrite.execute({ filePath: "bad?.txt", content: "invalid" }, toolContext),
      ).rejects.toThrow("INVALID_ARGUMENT:");
      expect(asks).toHaveLength(askCount);
    }
  });
});

describe("OpenCode hooks", () => {
  test("hides and blocks native mutators while retaining native read", async () => {
    const value = await hooks();
    const messageOutput = {
      message: { tools: { read: true } as Record<string, boolean> },
      parts: [],
    };
    await value["chat.message"]?.({} as never, messageOutput as never);
    expect(messageOutput.message.tools).toEqual({
      read: true,
      edit: false,
      write: false,
      apply_patch: false,
    });
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID: "session", callID: "call" },
        { args: {} },
      ),
    ).rejects.toThrow("NATIVE_TOOL_DISABLED:");
    await expect(
      value["tool.execute.before"]?.(
        { tool: "read", sessionID: "session", callID: "call" },
        { args: {} },
      ),
    ).resolves.toBeUndefined();
  });

  test("adds guidance and native-read annotation", async () => {
    const value = await hooks();
    const system = { system: [] as string[] };
    await value["experimental.chat.system.transform"]?.({} as never, system);
    expect(system.system.join("\n")).toContain("Native edit, write, and apply_patch are disabled");

    const definition = { description: "Read a file", parameters: {} };
    await value["tool.definition"]?.({ toolID: "read" }, definition as never);
    expect(definition.description).toContain("use hashline_read instead");
    await value["tool.definition"]?.({ toolID: "bash" }, definition as never);
    await value["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session", callID: "call", args: {} },
      { title: "bash", output: "ok", metadata: {} },
    );
  });

  test("supports migration mode and fails closed on invalid options", async () => {
    const value = await hooks({ enforce: false });
    const messageOutput = { message: { tools: {} }, parts: [] };
    await value["chat.message"]?.({} as never, messageOutput as never);
    expect(messageOutput.message.tools).toEqual({});
    await expect(
      value["tool.execute.before"]?.(
        { tool: "edit", sessionID: "session", callID: "call" },
        { args: {} },
      ),
    ).resolves.toBeUndefined();
    const system = { system: [] as string[] };
    await value["experimental.chat.system.transform"]?.({} as never, system);
    expect(system.system.join("\n")).toContain("remain enabled by configuration");

    const invalid = await hooks({ typo: true });
    const invalidMessage = { message: { tools: {} as Record<string, boolean> }, parts: [] };
    await invalid["chat.message"]?.({} as never, invalidMessage as never);
    expect(invalidMessage.message.tools).toEqual({
      edit: false,
      write: false,
      apply_patch: false,
    });
    await expect(
      invalid["tool.execute.before"]?.(
        { tool: "edit", sessionID: "session", callID: "call" },
        { args: {} },
      ),
    ).rejects.toThrow("CONFIG_INVALID:");
    const invalidSystem = { system: [] as string[] };
    await invalid["experimental.chat.system.transform"]?.({} as never, invalidSystem);
    expect(invalidSystem.system.join("\n")).toContain("configuration is invalid");
    const { hashlineRead } = registry(invalid);
    await expect(hashlineRead.execute({ filePath: "file.txt" }, context())).rejects.toThrow(
      "CONFIG_INVALID:",
    );
  });
});
