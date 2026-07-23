import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  betterHashlinePlugin,
  hashlineEditArgumentsSchema,
  hashlineEditDescription,
  hashlineWriteArgumentsSchema,
} from "../src/plugin.js";

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

type EditOperationInput = {
  op:
    | "replace"
    | "insert"
    | "replace_file"
    | "copy_range"
    | "move_range"
    | "delete_file"
    | "move_file";
  startLine?: number;
  endLine?: number;
  afterLine?: number;
  lines?: string[];
  finalNewline?: boolean;
  destinationPath?: string;
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
    onAsk?: (request: AskRecord) => void | Promise<void>;
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
      const record = request as AskRecord;
      input.asks?.push(record);
      await input.onAsk?.(record);
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

async function rejectedMessage(result: Promise<unknown>): Promise<string> {
  try {
    await result;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the promise to reject.");
}

describe("OpenCode plugin protocol", () => {
  test("keeps the production registry on unique tool IDs", async () => {
    const value = await hooks();
    expect(Object.keys(value.tool ?? {}).sort()).toEqual([
      "hashline_edit",
      "hashline_read",
      "hashline_write",
    ]);
    await value.dispose?.();
  });

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
    expect(editResult.output).toBe(
      "Applied 1 operation.\n@hashline-edit previous=consumed successor=none next=hashline_read",
    );
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

  test("reports preview-only lines as aggregate unissued coverage before mutation", async () => {
    const file = join(root, "preview.txt");
    const initial = "x".repeat(3000);
    await writeFile(file, initial);
    const value = await hooks({ maxOutputBytes: 1024 });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "preview.txt" }, toolContext),
    );
    expect(readResult.output).toContain("1!|");
    await activateRead(value, readResult);

    const message = await rejectedMessage(
      hashlineEdit.execute(
        {
          filePath: "preview.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        toolContext,
      ),
    );
    expect(message).toContain("RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 1.");
    expect(message).toContain("preview-only N!| lines remain unissued");
    expect(await readFile(file, "utf8")).toBe(initial);
    await value.dispose?.();
  });

  test("attests a post-edit successor before a dependent edit", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const value = await hooks({ maxSnapshotsPerPath: 1 });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const originalId = String(readResult.metadata.snapshotId);
    const args = {
      filePath: "file.txt",
      snapshotId: originalId,
      readback: true,
      operations: [{ op: "replace" as const, startLine: 2, endLine: 2, lines: ["TWO"] }],
    };
    const editResult = structured(await hashlineEdit.execute(args, toolContext));
    const successorId = /@hashline snapshot=(s_[A-Za-z0-9_-]{22})/u.exec(editResult.output)?.[1];
    expect(successorId).toBeDefined();
    expect(editResult.output).toContain(
      "@hashline-edit previous=consumed successor=attached\n@hashline snapshot=",
    );
    expect(editResult.output).toContain("2|TWO");
    expect(editResult.output).not.toContain("partial=true");

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: successorId,
          operations: [{ op: "replace", startLine: 3, endLine: 3, lines: ["THREE"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");

    await value["tool.execute.after"]?.(
      { tool: "hashline_edit", sessionID: "session", callID: "edit-call", args },
      editResult,
    );
    expect(editResult.metadata.hashlinePending).toBeUndefined();
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: originalId,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId: successorId,
        operations: [{ op: "replace", startLine: 3, endLine: 3, lines: ["THREE"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("one\nTWO\nTHREE\n");
    await value.dispose?.();
  });

  test("issues only an explicit contiguous post-edit readback window", async () => {
    const file = join(root, "window.txt");
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await writeFile(file, `${lines.join("\n")}\n`);
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "window.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const args = {
      filePath: "window.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      readback: true,
      readbackOffset: 8,
      readbackLimit: 5,
      operations: [{ op: "replace" as const, startLine: 10, endLine: 10, lines: ["changed"] }],
    };
    const editResult = structured(await hashlineEdit.execute(args, toolContext));
    const successorId = String(
      /@hashline snapshot=(s_[A-Za-z0-9_-]{22})/u.exec(editResult.output)?.[1],
    );
    expect(editResult.output).toContain("lines=20 partial=true");
    expect(editResult.output).toContain("8|line-8");
    expect(editResult.output).toContain("10|changed");
    expect(editResult.output).toContain("12|line-12");
    expect(editResult.output).not.toContain("7|line-7");
    expect(editResult.output).not.toContain("13|line-13");

    await value["tool.execute.after"]?.(
      { tool: "hashline_edit", sessionID: "session", callID: "window-readback", args },
      editResult,
    );
    await expect(
      hashlineEdit.execute(
        {
          filePath: "window.txt",
          snapshotId: successorId,
          operations: [{ op: "replace", startLine: 13, endLine: 13, lines: ["outside"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
    await hashlineEdit.execute(
      {
        filePath: "window.txt",
        snapshotId: successorId,
        operations: [{ op: "replace", startLine: 8, endLine: 8, lines: ["inside"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toContain("inside\nline-9\nchanged\n");
    await value.dispose?.();
  });

  test("attests beyond-EOF readback without issuing file lines", async () => {
    const file = join(root, "beyond-eof.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "beyond-eof.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const args = {
      filePath: "beyond-eof.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      readback: true,
      readbackOffset: 99,
      readbackLimit: 2,
      operations: [{ op: "replace" as const, startLine: 2, endLine: 2, lines: ["TWO"] }],
    };
    const editResult = structured(await hashlineEdit.execute(args, toolContext));
    const successorId = String(
      /@hashline snapshot=(s_[A-Za-z0-9_-]{22})/u.exec(editResult.output)?.[1],
    );
    expect(editResult.output).toContain("lines=3 partial=true\n@eof");
    expect(editResult.output).not.toMatch(/\n\d+[|!]/u);
    expect(editResult.metadata.hashlinePending).toBeString();

    await value["tool.execute.after"]?.(
      { tool: "hashline_edit", sessionID: "session", callID: "beyond-eof-readback", args },
      editResult,
    );
    expect(editResult.metadata.hashlinePending).toBeUndefined();
    await expect(
      hashlineEdit.execute(
        {
          filePath: "beyond-eof.txt",
          snapshotId: successorId,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe("one\nTWO\nthree\n");
    await value.dispose?.();
  });

  test("marks bounded readback partial before whole-file replacement", async () => {
    const file = join(root, "file.txt");
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(file, `${lines.join("\n")}\n`);
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const args = {
      filePath: "file.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      readback: true,
      operations: [{ op: "replace" as const, startLine: 10, endLine: 10, lines: ["changed"] }],
    };
    const editResult = structured(await hashlineEdit.execute(args, toolContext));
    const successorId = String(
      /@hashline snapshot=(s_[A-Za-z0-9_-]{22})/u.exec(editResult.output)?.[1],
    );
    expect(editResult.output).toContain("lines=12 partial=true");
    expect(editResult.output).toContain("7|line-7");
    expect(editResult.output).toContain("10|changed");
    expect(editResult.output).toContain("11|line-11");

    await value["tool.execute.after"]?.(
      { tool: "hashline_edit", sessionID: "session", callID: "partial-readback", args },
      editResult,
    );
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: successorId,
          operations: [{ op: "replace_file", lines: ["only"], finalNewline: true }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 1-6; BOF boundary. Suggested reads: hashline_read(offset=1, limit=6).",
    );
    await value.dispose?.();
  });

  test("fails post-edit readback closed without misreporting the applied edit", async () => {
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const cases = ["truncated", "mutated", "missing-marker"] as const;

    for (const mode of cases) {
      const filePath = `${mode}.txt`;
      const file = join(root, filePath);
      await writeFile(file, "one\ntwo\n");
      const readResult = structured(await hashlineRead.execute({ filePath }, toolContext));
      await activateRead(value, readResult);
      const args = {
        filePath,
        snapshotId: String(readResult.metadata.snapshotId),
        readback: true,
        operations: [{ op: "replace" as const, startLine: 2, endLine: 2, lines: ["TWO"] }],
      };
      const editResult = structured(await hashlineEdit.execute(args, toolContext));
      const successorId = /@hashline snapshot=(s_[A-Za-z0-9_-]{22})/u.exec(editResult.output)?.[1];
      expect(successorId).toBeDefined();
      if (mode === "truncated") editResult.metadata.truncated = true;
      if (mode === "mutated") editResult.output += "\nchanged by another hook";
      if (mode === "missing-marker") delete editResult.metadata.hashlinePending;

      await value["tool.execute.after"]?.(
        { tool: "hashline_edit", sessionID: "session", callID: mode, args },
        editResult,
      );
      expect(editResult.output).toBe(
        "Applied 1 operation.\n@hashline-edit previous=consumed successor=unavailable next=hashline_read",
      );
      expect(editResult.metadata.hashlinePending).toBeUndefined();
      expect(await readFile(file, "utf8")).toBe("one\nTWO\n");
      await expect(
        hashlineEdit.execute(
          {
            filePath,
            snapshotId: successorId,
            operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
          },
          toolContext,
        ),
      ).rejects.toThrow("RANGE_NOT_FULLY_ISSUED:");
    }
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

  test("diagnoses EOL-only unique relocation failure before edit permission", async () => {
    const file = join(root, "eol-only.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "eol-only.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    await writeFile(file, "one\r\ntwo\r\nthree\r\n");

    await expect(
      hashlineEdit.execute(
        {
          filePath: "eol-only.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          rebase: "unique",
          operations: [{ op: "replace", startLine: 2, endLine: 2, lines: ["TWO"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "TARGET_CHANGED: Lines 2-2 are no longer unchanged. Exact line delimiters changed; reread the file before retrying.",
    );
    expect(asks.map(({ permission }) => permission)).toEqual(["read"]);
    expect(await readFile(file, "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
    await value.dispose?.();
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

  test("accepts requested read limits above 1000 up to the absolute ceiling", async () => {
    const file = join(root, "many-lines.txt");
    await writeFile(file, `${Array.from({ length: 1500 }, () => "x").join("\n")}\n`);
    const value = await hooks({ maxOutputBytes: 46_080 });
    const { hashlineRead } = registry(value);
    const toolContext = context();
    const readShape = hashlineRead.args;
    if (!readShape) throw new Error("hashline_read schema is unavailable");
    const schema = z.toJSONSchema(z.object(readShape).strict()) as {
      properties?: { limit?: { description?: string; maximum?: number } };
    };

    expect(schema.properties?.limit?.maximum).toBe(100_000);
    expect(schema.properties?.limit?.description).toContain("maxOutputBytes");
    expect(schema.properties?.limit?.description).toContain("@more");
    expect(schema.properties?.limit?.description).toContain("@eof");
    expect(schema.properties?.limit?.description).toContain("partial=true");
    const result = structured(
      await hashlineRead.execute({ filePath: "many-lines.txt", limit: 2000 }, toolContext),
    );
    expect(result.metadata.displayedLines).toBe(1500);
    expect(result.output.split("\n").filter((line) => /^\d+\|x$/u.test(line))).toHaveLength(1500);
    expect(result.output).toContain("@eof");
    await expect(
      hashlineRead.execute({ filePath: "many-lines.txt", limit: 100_001 }, toolContext),
    ).rejects.toThrow("INVALID_ARGUMENT: limit exceeds its maximum of 100000.");
    await value.dispose?.();
  });

  test("keeps very large requested read limits byte bounded", async () => {
    const file = join(root, "byte-bounded.txt");
    await writeFile(file, `${Array.from({ length: 5000 }, () => "x").join("\n")}\n`);
    const value = await hooks({ maxOutputBytes: 1024 });
    const { hashlineRead } = registry(value);
    const result = structured(
      await hashlineRead.execute({ filePath: "byte-bounded.txt", limit: 100_000 }, context()),
    );

    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.output).toContain("partial=true");
    expect(result.output).toContain("@more offset=");
    expect(result.metadata.displayedLines).toBeLessThan(5000);
    await value.dispose?.();
  });

  test("accepts readback limits above 1000 while keeping the result byte bounded", async () => {
    const file = join(root, "bounded-readback.txt");
    await writeFile(file, `${Array.from({ length: 2000 }, () => "x").join("\n")}\n`);
    const value = await hooks({ maxOutputBytes: 1024 });
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "bounded-readback.txt", limit: 1 }, toolContext),
    );
    await activateRead(value, readResult);

    const editResult = structured(
      await hashlineEdit.execute(
        {
          filePath: "bounded-readback.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          readback: true,
          readbackOffset: 1,
          readbackLimit: 2000,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["changed"] }],
        },
        toolContext,
      ),
    );

    expect(Buffer.byteLength(editResult.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(editResult.output).toContain("partial=true");
    expect(editResult.output).toContain("@more offset=");
    expect(await readFile(file, "utf8")).toStartWith("changed\n");
    await value.dispose?.();
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

  test("rejects every display prefix, permits safe similarities, and requires explicit opt-in", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const snapshotId = String(readResult.metadata.snapshotId);
    const blocked = [
      { operation: { op: "replace", startLine: 1, endLine: 1, lines: ["1|old"] }, prefix: "N|" },
      { operation: { op: "insert", afterLine: 0, lines: ["17!|old"] }, prefix: "N!|" },
      { operation: { op: "replace_file", lines: ["@hashline snapshot=s_x"] }, prefix: "@hashline" },
      {
        operation: { op: "replace", startLine: 1, endLine: 1, lines: ["@more offset=2"] },
        prefix: "@more",
      },
      { operation: { op: "insert", afterLine: 1, lines: ["@eof"] }, prefix: "@eof" },
      { operation: { op: "replace_file", lines: ["@note line not issued"] }, prefix: "@note" },
      {
        operation: {
          op: "replace",
          startLine: 1,
          endLine: 1,
          lines: ["@hashline-edit previous=consumed"],
        },
        prefix: "@hashline-edit",
      },
    ];

    for (const { operation, prefix } of blocked) {
      await expect(
        hashlineEdit.execute(
          { filePath: "file.txt", snapshotId, operations: [operation] },
          toolContext,
        ),
      ).rejects.toThrow(`operations[0].lines[0] starts with ${JSON.stringify(prefix)}`);
    }

    const safeLines = ["N|literal", "0|literal", "01|literal", "@hashline-style", " @hashline"];
    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId,
        operations: [{ op: "replace_file", lines: safeLines, finalNewline: true }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe(`${safeLines.join("\n")}\n`);

    const intentionalRead = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, intentionalRead);
    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId: String(intentionalRead.metadata.snapshotId),
        allowHashlinePrefixes: true,
        operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["@hashline"] }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toStartWith("@hashline\n");
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

  test("rejects every missing and forbidden operation field", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "old\n");
    const value = await hooks({ maxFileBytes: 1024, maxCacheBytes: 3072 });
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
    const replaceMessage =
      "replace requires startLine, endLine, and lines, and does not accept afterLine or finalNewline.";
    const insertMessage =
      "insert requires afterLine and lines, and does not accept startLine, endLine, or finalNewline.";
    const replaceFileMessage = "replace_file requires lines and does not accept line coordinates.";
    const transferMessage = (op: "copy_range" | "move_range") =>
      `${op} requires startLine, endLine, and afterLine, and does not accept lines or finalNewline.`;
    type OperationField = Exclude<keyof EditOperationInput, "op">;
    const shapes: Array<{
      valid: EditOperationInput;
      required: OperationField[];
      forbidden: Partial<Omit<EditOperationInput, "op">>;
      message: string;
    }> = [
      {
        valid: { op: "replace", startLine: 1, endLine: 1, lines: ["new"] },
        required: ["startLine", "endLine", "lines"],
        forbidden: { afterLine: 0, finalNewline: false },
        message: replaceMessage,
      },
      {
        valid: { op: "insert", afterLine: 0, lines: ["new"] },
        required: ["afterLine", "lines"],
        forbidden: { startLine: 1, endLine: 1, finalNewline: false },
        message: insertMessage,
      },
      {
        valid: { op: "replace_file", lines: ["new"] },
        required: ["lines"],
        forbidden: { startLine: 1, endLine: 1, afterLine: 0 },
        message: replaceFileMessage,
      },
      {
        valid: { op: "copy_range", startLine: 1, endLine: 1, afterLine: 1 },
        required: ["startLine", "endLine", "afterLine"],
        forbidden: { lines: ["new"], finalNewline: false },
        message: transferMessage("copy_range"),
      },
      {
        valid: { op: "move_range", startLine: 1, endLine: 1, afterLine: 1 },
        required: ["startLine", "endLine", "afterLine"],
        forbidden: { lines: ["new"], finalNewline: false },
        message: transferMessage("move_range"),
      },
    ];

    for (const shape of shapes) {
      for (const field of shape.required) {
        const operation = { ...shape.valid };
        delete operation[field];
        await expect(
          hashlineEdit.execute({ ...common, operations: [operation] }, toolContext),
        ).rejects.toThrow(`INVALID_ARGUMENT: ${shape.message}`);
      }
      for (const [field, value] of Object.entries(shape.forbidden)) {
        const operation = { ...shape.valid, [field]: value };
        await expect(
          hashlineEdit.execute({ ...common, operations: [operation] }, toolContext),
        ).rejects.toThrow(`INVALID_ARGUMENT: ${shape.message}`);
      }
    }

    const oversizedLegacy = {
      op: "replace" as const,
      startLine: 1,
      endLine: 1,
      lines: ["x".repeat(1025)],
    };
    const malformedLegacy = { op: "insert" as const, lines: ["new"] };
    for (const operations of [
      [oversizedLegacy, malformedLegacy],
      [malformedLegacy, oversizedLegacy],
    ]) {
      await expect(hashlineEdit.execute({ ...common, operations }, toolContext)).rejects.toThrow(
        "UNSUPPORTED_FILE: Replacement payload exceeds maxFileBytes=1024 or maxLines=100000. No publication occurred and the snapshot was not consumed; reduce the payload before retrying.",
      );
    }
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  test("validates strict lifecycle operation shapes before publication", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    const common = {
      filePath: "file.txt",
      snapshotId: String(readResult.metadata.snapshotId),
      rebase: "none" as const,
    };
    const invalid: Array<{ args: Record<string, unknown>; message: string }> = [
      {
        args: { ...common, operations: [{ op: "delete_file", destinationPath: "other.txt" }] },
        message: "delete_file does not accept destinationPath.",
      },
      {
        args: { ...common, operations: [{ op: "move_file" }] },
        message: "move_file requires destinationPath.",
      },
      {
        args: {
          ...common,
          operations: [{ op: "move_file", destinationPath: "other.txt", lines: [] }],
        },
        message: "move_file does not accept line coordinates, lines, or finalNewline.",
      },
      {
        args: {
          ...common,
          operations: [
            { op: "delete_file" },
            { op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] },
          ],
        },
        message: "File lifecycle operations must be the only operation.",
      },
      {
        args: { ...common, rebase: "unique", operations: [{ op: "delete_file" }] },
        message: "delete_file does not support unique rebase.",
      },
      {
        args: {
          ...common,
          readback: true,
          readbackOffset: 1,
          readbackLimit: 1,
          operations: [{ op: "move_file", destinationPath: "other.txt" }],
        },
        message:
          "move_file does not accept readback, readbackOffset, or readbackLimit. Remove them and retry with the same snapshot.",
      },
      {
        args: {
          ...common,
          readbackOffset: 1,
          operations: [{ op: "move_file", destinationPath: "other.txt" }],
        },
        message:
          "move_file does not accept readback, readbackOffset, or readbackLimit. Remove them and retry with the same snapshot.",
      },
      {
        args: {
          ...common,
          readbackLimit: 1,
          operations: [{ op: "delete_file" }],
        },
        message:
          "delete_file does not accept readback, readbackOffset, or readbackLimit. Remove them and retry with the same snapshot.",
      },
      {
        args: {
          ...common,
          readbackOffset: 1,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: ["ONE"] }],
        },
        message: "readbackOffset and readbackLimit require readback:true.",
      },
      {
        args: {
          ...common,
          operations: [
            {
              op: "replace",
              startLine: 1,
              endLine: 1,
              lines: ["ONE"],
              destinationPath: "other.txt",
            },
          ],
        },
        message: "destinationPath is only accepted by move_file.",
      },
    ];

    const askCount = asks.length;
    for (const entry of invalid) {
      await expect(hashlineEdit.execute(entry.args as never, toolContext)).rejects.toThrow(
        `INVALID_ARGUMENT: ${entry.message}`,
      );
    }
    expect(asks).toHaveLength(askCount);
    expect(await readFile(file, "utf8")).toBe("one\ntwo\n");

    await writeFile(join(root, "partial.txt"), "one\ntwo\n");
    const partial = structured(
      await hashlineRead.execute({ filePath: "partial.txt", limit: 1 }, toolContext),
    );
    await activateRead(value, partial);
    await expect(
      hashlineEdit.execute(
        {
          filePath: "partial.txt",
          snapshotId: String(partial.metadata.snapshotId),
          operations: [{ op: "delete_file" }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "RANGE_NOT_FULLY_ISSUED: delete_file needs a complete snapshot. Read the file from offset=1 through @eof with the same snapshotId, then retry.",
    );
    await value.dispose?.();
  });

  test("accepts every documented minimal operation shape without explicit rebase", async () => {
    const cases: Array<{
      initial: string;
      operation: EditOperationInput;
      expected: string;
    }> = [
      {
        initial: "a\nb\n",
        operation: { op: "replace", startLine: 1, endLine: 1, lines: ["A"] },
        expected: "A\nb\n",
      },
      {
        initial: "a\nb\n",
        operation: { op: "insert", afterLine: 0, lines: ["before"] },
        expected: "before\na\nb\n",
      },
      {
        initial: "a\nb\n",
        operation: { op: "replace_file", lines: ["whole"], finalNewline: true },
        expected: "whole\n",
      },
      {
        initial: "a\n",
        operation: { op: "replace_file", lines: [], finalNewline: false },
        expected: "",
      },
      {
        initial: "a\nb\n",
        operation: { op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 },
        expected: "a\nb\na\n",
      },
      {
        initial: "a\nb\n",
        operation: { op: "move_range", startLine: 1, endLine: 1, afterLine: 2 },
        expected: "b\na\n",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const filePath = `valid-${index}.txt`;
      await writeFile(join(root, filePath), entry.initial);
      const value = await hooks();
      const { hashlineRead, hashlineEdit } = registry(value);
      const toolContext = context();
      const readResult = structured(await hashlineRead.execute({ filePath }, toolContext));
      await activateRead(value, readResult);
      await hashlineEdit.execute(
        {
          filePath,
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [entry.operation],
        },
        toolContext,
      );
      expect(await readFile(join(root, filePath), "utf8")).toBe(entry.expected);
      await value.dispose?.();
    }
  });

  test("enforces documented payload limits through the public tool", async () => {
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
    };

    for (const [line, message] of [
      ["bad\nline", "Logical line 1 contains a newline character."],
      ["bad\rline", "Logical line 1 contains a newline character."],
      ["bad\0line", "Logical line 1 contains a NUL character."],
      ["\ud800", "Logical line 1 has invalid Unicode."],
    ]) {
      await expect(
        hashlineEdit.execute(
          {
            ...common,
            operations: [{ op: "replace", startLine: 1, endLine: 1, lines: [line] }],
          },
          toolContext,
        ),
      ).rejects.toThrow(`INVALID_ARGUMENT: ${message}`);
    }

    const tooManyLines = Array.from({ length: 20_001 }, () => "x");
    await expect(
      hashlineEdit.execute(
        {
          ...common,
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: tooManyLines }],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT: replace accepts at most 20,000 replacement lines.");
    await expect(
      hashlineEdit.execute(
        {
          ...common,
          operations: [{ op: "insert", afterLine: 0, lines: tooManyLines }],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT: insert requires between 1 and 20,000 lines.");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  test("rejects invalid public replace_file combinations consistently", async () => {
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
    };

    await expect(
      hashlineEdit.execute(
        {
          ...common,
          rebase: "unique",
          operations: [{ op: "replace_file", lines: ["new"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT: replace_file does not support unique rebase.");
    await expect(
      hashlineEdit.execute(
        {
          ...common,
          operations: [
            { op: "replace_file", lines: ["new"] },
            { op: "insert", afterLine: 0, lines: ["before"] },
          ],
        },
        toolContext,
      ),
    ).rejects.toThrow("INVALID_ARGUMENT: replace_file must be the only operation.");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  test("publishes the intended flat transfer schema and coordinate guidance", () => {
    type SchemaProperty = { description?: string; enum?: string[]; maximum?: number };
    const schema = z.toJSONSchema(hashlineEditArgumentsSchema) as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: {
        allowHashlinePrefixes?: SchemaProperty;
        filePath?: SchemaProperty;
        readback?: SchemaProperty;
        readbackLimit?: SchemaProperty;
        readbackOffset?: SchemaProperty;
        rebase?: SchemaProperty;
        snapshotId?: SchemaProperty;
        operations?: {
          description?: string;
          items?: {
            additionalProperties?: boolean;
            description?: string;
            properties?: Record<string, SchemaProperty>;
            required?: string[];
          };
        };
      };
    };
    const operation = schema.properties?.operations?.items;

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["filePath", "snapshotId", "operations"]);
    expect(schema.properties?.filePath?.description).toContain("same canonical file");
    expect(schema.properties?.snapshotId?.description).toContain("do not invent it or reuse it");
    expect(schema.properties?.operations?.description).toContain("1..100");
    expect(schema.properties?.operations?.description).toContain("original immutable snapshot");
    expect(operation?.additionalProperties).toBe(false);
    expect(operation?.properties?.op?.enum).toEqual([
      "replace",
      "insert",
      "replace_file",
      "copy_range",
      "move_range",
      "delete_file",
      "move_file",
    ]);
    expect(operation?.required).toEqual(["op"]);
    expect(operation?.description).toBe(
      "Fields not listed for the selected op are invalid; replace_file and file lifecycle operations must be sole. One move_range may compose with pairwise-disjoint replace operations wholly inside its intervening corridor and outside its source; the complete corridor must be issued and unchanged.",
    );
    expect(operation?.properties?.op?.description).toBe(
      "Required: replace(startLine,endLine,lines); insert(afterLine,lines); replace_file(lines); copy_range/move_range(startLine,endLine,afterLine); delete_file; move_file(destinationPath). Optional only: replace_file(finalNewline). All other fields are forbidden.",
    );
    expect(operation?.properties?.startLine?.description).toContain(
      "Only for replace, copy_range, and move_range",
    );
    expect(operation?.properties?.endLine?.description).toContain(
      "Only for replace, copy_range, and move_range",
    );
    expect(operation?.properties?.afterLine?.description).toContain(
      "Only for insert, copy_range, and move_range",
    );
    expect(operation?.properties?.afterLine?.description).toContain(
      "move forbids destinations strictly inside its source",
    );
    expect(operation?.properties?.lines?.description).toContain(
      "Only for replace, insert, and replace_file",
    );
    expect(operation?.properties?.lines?.description).toContain("insert 1..20,000");
    expect(operation?.properties?.lines?.description).toContain("without CR, LF, NUL");
    expect(operation?.properties?.finalNewline?.description).toContain("Only for replace_file");
    expect(operation?.properties?.finalNewline?.description).toContain(
      "an empty file requires false",
    );
    expect(schema.properties?.rebase?.description).toContain(
      "replace_file, delete_file, and move_file forbid unique",
    );
    expect(schema.properties?.rebase?.description).toContain("still-retained snapshot");
    expect(schema.properties?.allowHashlinePrefixes?.description).toContain("Column-0 prefixes");
    expect(schema.properties?.allowHashlinePrefixes?.description).toContain("initial call");
    expect(schema.properties?.readback?.description).toContain("verification or follow-up");
    expect(schema.properties?.readback?.description).toContain("attachment can be unavailable");
    expect(schema.properties?.readback?.description).toContain(
      "Lifecycle operations reject readback, readbackOffset, and readbackLimit",
    );
    expect(schema.properties?.readbackOffset?.description).toContain("post-edit file");
    expect(schema.properties?.readbackOffset?.description).toContain("first hunk");
    expect(schema.properties?.readbackLimit?.description).toContain("contiguous successor page");
    expect(schema.properties?.readbackLimit?.description).toContain("defaults to 1000");
    expect(schema.properties?.readbackLimit?.maximum).toBe(100_000);
    expect(schema.properties?.readbackLimit?.description).toContain("maxOutputBytes");
    expect(schema.properties?.readbackLimit?.description).toContain("@more");
    expect(schema.properties?.readbackLimit?.description).toContain("@eof");
    expect(schema.properties?.readbackLimit?.description).toContain("partial=true");
    const validEditArguments = {
      filePath: "file.txt",
      snapshotId: "s_0000000000000000000000",
      readback: true,
      operations: [{ op: "replace" as const, startLine: 1, endLine: 1, lines: ["new"] }],
    };
    expect(
      hashlineEditArgumentsSchema.safeParse({ ...validEditArguments, readbackLimit: 100_000 })
        .success,
    ).toBe(true);
    expect(
      hashlineEditArgumentsSchema.safeParse({ ...validEditArguments, readbackLimit: 100_001 })
        .success,
    ).toBe(false);
    expect(hashlineEditDescription).toContain(
      "replace removes the one-based inclusive startLine..endLine range; lines is the complete replacement; neighboring lines outside the range remain, so do not repeat retained context such as a closing delimiter unless intentional.",
    );
    expect(hashlineEditDescription).toContain(
      "Every operation uses original immutable pre-batch coordinates; never shift later startLine/endLine/afterLine because of earlier operations and never target lines created by another operation.",
    );
    expect(hashlineEditDescription).toContain("copy reads pre-edit source");
    expect(hashlineEditDescription).toContain("may touch a destructive endpoint");
    expect(hashlineEditDescription).toContain("readback:true requests one successor page");
    expect(hashlineEditDescription).not.toContain("readbackOffset selects");
    expect(hashlineEditDescription).not.toContain("maxOutputBytes");
    expect(hashlineEditDescription).toContain("Text batches publish one atomic replacement");
    expect(hashlineEditDescription).toContain("move_file is nontransactional");
    expect(hashlineEditDescription).toContain("PARTIAL_PUBLICATION");
    expect(hashlineEditDescription).toContain("attachment can be unavailable");
    expect(hashlineEditDescription).not.toContain("@eof");
    expect(hashlineEditDescription).not.toContain("finalNewline is replace_file-only");
    expect(hashlineEditDescription).not.toContain("replace lines:[] deletes");
  });

  test("validates complete tool arguments before permissions or filesystem access", async () => {
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit, hashlineWrite } = registry(value);
    const toolContext = context({ asks });

    await expect(
      hashlineRead.execute({ filePath: "missing.txt", unexpected: true } as never, toolContext),
    ).rejects.toThrow("INVALID_ARGUMENT: unexpected is not accepted by hashline_read.");
    await expect(
      hashlineEdit.execute(
        {
          filePath: "missing.txt",
          snapshotId: "s_0000000000000000000000",
          operations: [{ op: "replace", startLine: 1, endLine: 1, lines: [], unexpected: true }],
        } as never,
        toolContext,
      ),
    ).rejects.toThrow(
      "INVALID_ARGUMENT: operations[0].unexpected is not accepted by hashline_edit.",
    );
    await expect(
      hashlineEdit.execute(
        {
          filePath: "missing.txt",
          snapshotId: "s_0000000000000000000000",
          operations: [{ op: "replace", startLine: 1, lines: ["new"] }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "INVALID_ARGUMENT: replace requires startLine, endLine, and lines, and does not accept afterLine or finalNewline.",
    );
    await expect(
      hashlineWrite.execute({ filePath: "new.txt", content: 1 } as never, toolContext),
    ).rejects.toThrow("INVALID_ARGUMENT: content must be a string.");
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

  test("publishes one exact mixed transfer batch through the real plugin path", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "1|literal\nbeta\ngamma\ndelta\nepsilon\nzeta\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);

    const editResult = structured(
      await hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [
            { op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 },
            { op: "move_range", startLine: 5, endLine: 5, afterLine: 3 },
          ],
        },
        toolContext,
      ),
    );

    expect(editResult.output).toContain("Applied 2 operations");
    expect(await readFile(file, "utf8")).toBe(
      "1|literal\nbeta\n1|literal\ngamma\nepsilon\ndelta\nzeta\n",
    );
    expect(asks.map(({ permission }) => permission)).toEqual(["read", "edit"]);
    expect(String(asks.at(-1)?.metadata?.diff)).toContain("+1|literal");
  });

  test("composes a move with a disjoint replacement inside its corridor", async () => {
    const file = join(root, "move-replace.txt");
    const initial = Array.from({ length: 13 }, (_, index) => `L${index + 1}`);
    await writeFile(file, `${initial.join("\n")}\n`);
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "move-replace.txt" }, toolContext),
    );
    await activateRead(value, readResult);

    const result = structured(
      await hashlineEdit.execute(
        {
          filePath: "move-replace.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [
            { op: "move_range", startLine: 2, endLine: 3, afterLine: 13 },
            { op: "replace", startLine: 5, endLine: 5, lines: ["R5"] },
          ],
        },
        toolContext,
      ),
    );

    expect(result.output).toContain("Applied 2 operations");
    expect(await readFile(file, "utf8")).toBe(
      ["L1", "L4", "R5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13", "L2", "L3", ""].join(
        "\n",
      ),
    );
    expect(asks.map(({ permission }) => permission)).toEqual(["read", "edit"]);
  });

  test("publishes mixed-EOL transfers without changing the BOM or positional delimiters", async () => {
    const file = join(root, "file.txt");
    const initial = Uint8Array.of(
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("one\r\ntwo\nthree\rfour\r\n"),
    );
    const expected = Uint8Array.of(
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("one\r\nthree\ntwo\rfour\r\nfour\r\n"),
    );
    await writeFile(file, initial);
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);

    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId: String(readResult.metadata.snapshotId),
        operations: [
          { op: "move_range", startLine: 3, endLine: 3, afterLine: 1 },
          { op: "copy_range", startLine: 4, endLine: 4, afterLine: 4 },
        ],
      },
      toolContext,
    );

    expect(new Uint8Array(await readFile(file))).toEqual(expected);
  });

  test("requires issued copy source and both destination neighbors or edge authority", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\nfive\nsix\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const first = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 1, limit: 2 }, toolContext),
    );
    await activateRead(value, first);
    const snapshotId = String(first.metadata.snapshotId);

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "copy_range", startLine: 1, endLine: 1, afterLine: 6 }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "REF_NOT_ISSUED: Missing issued coverage: line gaps: 6; EOF boundary. Suggested reads: hashline_read(offset=6, limit=1).",
    );

    const fourth = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 4, limit: 1 }, toolContext),
    );
    await activateRead(value, fourth);
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "copy_range", startLine: 1, endLine: 1, afterLine: 4 }],
        },
        toolContext,
      ),
    ).rejects.toThrow(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 5. Suggested reads: hashline_read(offset=5, limit=1).",
    );

    const fifth = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 5, limit: 1 }, toolContext),
    );
    await activateRead(value, fifth);
    await hashlineEdit.execute(
      {
        filePath: "file.txt",
        snapshotId,
        operations: [{ op: "copy_range", startLine: 1, endLine: 1, afterLine: 4 }],
      },
      toolContext,
    );
    expect(await readFile(file, "utf8")).toBe("one\ntwo\nthree\nfour\none\nfive\nsix\n");
  });

  test("preserves exact edge codes for insert, copy, and move coverage", async () => {
    await writeFile(join(root, "edge-bof.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    await writeFile(join(root, "edge-eof.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const diagnosticSuffix =
      " Only fully rendered N| lines issue coverage; preview-only N!| lines remain unissued. Reuse the old snapshotId only if every suggested read returns that same ID; otherwise replan the full batch from the new snapshot.";

    const bofSource = structured(
      await hashlineRead.execute({ filePath: "edge-bof.txt", offset: 2, limit: 1 }, toolContext),
    );
    await activateRead(value, bofSource);
    const bofSnapshotId = String(bofSource.metadata.snapshotId);
    for (const operation of [
      { op: "insert" as const, afterLine: 0, lines: ["inserted"] },
      { op: "copy_range" as const, startLine: 2, endLine: 2, afterLine: 0 },
    ]) {
      const message = await rejectedMessage(
        hashlineEdit.execute(
          { filePath: "edge-bof.txt", snapshotId: bofSnapshotId, operations: [operation] },
          toolContext,
        ),
      );
      expect(message).toBe(
        `REF_NOT_ISSUED: Missing issued coverage: line gaps: 1; BOF boundary. Suggested reads: hashline_read(offset=1, limit=1).${diagnosticSuffix}`,
      );
    }

    const bofMoveSource = structured(
      await hashlineRead.execute({ filePath: "edge-bof.txt", offset: 6, limit: 1 }, toolContext),
    );
    await activateRead(value, bofMoveSource);
    const bofMoveMessage = await rejectedMessage(
      hashlineEdit.execute(
        {
          filePath: "edge-bof.txt",
          snapshotId: bofSnapshotId,
          operations: [{ op: "move_range", startLine: 6, endLine: 6, afterLine: 0 }],
        },
        toolContext,
      ),
    );
    expect(bofMoveMessage).toBe(
      `RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 1, 3-5; BOF boundary. Suggested reads: hashline_read(offset=1, limit=1), hashline_read(offset=3, limit=3).${diagnosticSuffix}`,
    );

    const eofSource = structured(
      await hashlineRead.execute({ filePath: "edge-eof.txt", offset: 1, limit: 1 }, toolContext),
    );
    await activateRead(value, eofSource);
    const eofSnapshotId = String(eofSource.metadata.snapshotId);
    for (const operation of [
      { op: "insert" as const, afterLine: 6, lines: ["inserted"] },
      { op: "copy_range" as const, startLine: 1, endLine: 1, afterLine: 6 },
    ]) {
      const message = await rejectedMessage(
        hashlineEdit.execute(
          { filePath: "edge-eof.txt", snapshotId: eofSnapshotId, operations: [operation] },
          toolContext,
        ),
      );
      expect(message).toBe(
        `REF_NOT_ISSUED: Missing issued coverage: line gaps: 6; EOF boundary. Suggested reads: hashline_read(offset=6, limit=1).${diagnosticSuffix}`,
      );
    }

    const eofMoveMessage = await rejectedMessage(
      hashlineEdit.execute(
        {
          filePath: "edge-eof.txt",
          snapshotId: eofSnapshotId,
          operations: [{ op: "move_range", startLine: 1, endLine: 1, afterLine: 6 }],
        },
        toolContext,
      ),
    );
    expect(eofMoveMessage).toBe(
      `RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 2-6; EOF boundary. Suggested reads: hashline_read(offset=2, limit=5).${diagnosticSuffix}`,
    );
  });

  test("reports all transfer-batch gaps in canonical order", async () => {
    const file = join(root, "file.txt");
    const initial = `${Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
    await writeFile(file, initial);
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 1, limit: 1 }, toolContext),
    );
    await activateRead(value, readResult);
    const snapshotId = String(readResult.metadata.snapshotId);
    const first = { op: "copy_range" as const, startLine: 3, endLine: 3, afterLine: 1 };
    const second = { op: "copy_range" as const, startLine: 10, endLine: 10, afterLine: 6 };
    const third = { op: "replace" as const, startLine: 12, endLine: 12, lines: ["LAST"] };
    const messages: string[] = [];

    for (const operations of [
      [first, second, third],
      [third, second, first],
    ]) {
      messages.push(
        await rejectedMessage(
          hashlineEdit.execute({ filePath: "file.txt", snapshotId, operations }, toolContext),
        ),
      );
    }
    expect(messages[1]).toBe(messages[0]);
    expect(messages[0]).toContain(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 2-3, 6-7, 10, 12. Suggested reads: hashline_read(offset=2, limit=2), hashline_read(offset=6, limit=2), hashline_read(offset=10, limit=1), hashline_read(offset=12, limit=1).",
    );
    expect(messages[0]).toContain(
      "Reuse the old snapshotId only if every suggested read returns that same ID; otherwise replan the full batch from the new snapshot.",
    );
    expect(await readFile(file, "utf8")).toBe(initial);
    await value.dispose?.();
  });

  test("requires the complete move corridor and reports identity moves as no-ops", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\nfive\nsix\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context();
    const source = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 5, limit: 1 }, toolContext),
    );
    await activateRead(value, source);
    const snapshotId = String(source.metadata.snapshotId);
    const destination = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 2, limit: 2 }, toolContext),
    );
    await activateRead(value, destination);

    const move = {
      filePath: "file.txt",
      snapshotId,
      operations: [{ op: "move_range" as const, startLine: 5, endLine: 5, afterLine: 2 }],
    };
    await expect(hashlineEdit.execute(move, toolContext)).rejects.toThrow(
      "RANGE_NOT_FULLY_ISSUED: Missing issued coverage: line gaps: 4. Suggested reads: hashline_read(offset=4, limit=1).",
    );

    const corridor = structured(
      await hashlineRead.execute({ filePath: "file.txt", offset: 4, limit: 1 }, toolContext),
    );
    await activateRead(value, corridor);
    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId,
          operations: [{ op: "move_range", startLine: 4, endLine: 4, afterLine: 4 }],
        },
        toolContext,
      ),
    ).rejects.toThrow("NO_CHANGE:");

    await hashlineEdit.execute(move, toolContext);
    expect(await readFile(file, "utf8")).toBe("one\ntwo\nfive\nthree\nfour\nsix\n");
  });

  test("relocates all transfer anchors before requesting one exact permission", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "a\nb\nc\nd\ne\nf\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });
    const readResult = structured(
      await hashlineRead.execute({ filePath: "file.txt" }, toolContext),
    );
    await activateRead(value, readResult);
    await writeFile(file, "top\na\nb\nc\nd\ne\nf\n");

    const result = structured(
      await hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          rebase: "unique",
          operations: [{ op: "move_range", startLine: 5, endLine: 5, afterLine: 2 }],
        },
        toolContext,
      ),
    );
    expect(result.metadata.rebased).toBe(true);
    expect(await readFile(file, "utf8")).toBe("top\na\nb\ne\nc\nd\nf\n");
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(1);
  });

  test("binds transfer permission to one plan and never replans after a race", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "a\nb\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const readResult = structured(await hashlineRead.execute({ filePath: "file.txt" }, context()));
    await activateRead(value, readResult);
    const asks: AskRecord[] = [];
    const racing = context({
      asks,
      async onAsk(request) {
        if (request.permission === "edit") await writeFile(file, "raced\n");
      },
    });

    await expect(
      hashlineEdit.execute(
        {
          filePath: "file.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "copy_range", startLine: 1, endLine: 1, afterLine: 2 }],
        },
        racing,
      ),
    ).rejects.toThrow("RACE_BEFORE_WRITE:");
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe("raced\n");
  });

  test("deletes and moves exact files without overwriting", async () => {
    const deletePath = join(root, "delete.txt");
    const movePath = join(root, "move.txt");
    const occupiedPath = join(root, "occupied.txt");
    await writeFile(deletePath, "delete me\n");
    await writeFile(movePath, "move me\n");
    await writeFile(occupiedPath, "keep me\n");
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const toolContext = context({ asks });

    const deleteRead = structured(
      await hashlineRead.execute({ filePath: "delete.txt" }, toolContext),
    );
    await activateRead(value, deleteRead);
    const deleted = structured(
      await hashlineEdit.execute(
        {
          filePath: "delete.txt",
          snapshotId: String(deleteRead.metadata.snapshotId),
          operations: [{ op: "delete_file" }],
        },
        toolContext,
      ),
    );
    expect(deleted.output).toContain("Deleted delete.txt.");
    expect(deleted.metadata).toMatchObject({ operation: "delete_file" });
    await expect(readFile(deletePath)).rejects.toThrow();

    const moveRead = structured(await hashlineRead.execute({ filePath: "move.txt" }, toolContext));
    await activateRead(value, moveRead);
    const moveRequest = {
      filePath: "move.txt",
      snapshotId: String(moveRead.metadata.snapshotId),
      operations: [{ op: "move_file" as const, destinationPath: "occupied.txt" }],
    };
    await expect(hashlineEdit.execute(moveRequest, toolContext)).rejects.toThrow("TARGET_EXISTS:");
    expect(await readFile(movePath, "utf8")).toBe("move me\n");
    expect(await readFile(occupiedPath, "utf8")).toBe("keep me\n");

    const moved = structured(
      await hashlineEdit.execute(
        {
          ...moveRequest,
          operations: [{ op: "move_file", destinationPath: "moved.txt" }],
        },
        toolContext,
      ),
    );
    expect(moved.output).toContain("Moved move.txt to moved.txt.");
    const canonicalRoot = await realpath(root);
    expect(moved.metadata).toMatchObject({
      operation: "move_file",
      destinationPath: join(canonicalRoot, "moved.txt"),
    });
    await expect(readFile(movePath)).rejects.toThrow();
    expect(await readFile(join(root, "moved.txt"), "utf8")).toBe("move me\n");
    expect(asks.at(-1)?.patterns).toEqual(["move.txt", "moved.txt"]);
    await value.dispose?.();
  });

  test("rejects lifecycle source line breaks before permission or mutation", async () => {
    if (process.platform === "win32") return;
    const value = await hooks();
    const { hashlineRead } = registry(value);

    for (const [index, separator] of ["\n", "\r"].entries()) {
      const fileName = `unsafe-${index}${separator}source.txt`;
      const filePath = join(root, fileName);
      await writeFile(filePath, "preserved\n");
      const asks: AskRecord[] = [];

      await expect(hashlineRead.execute({ filePath: fileName }, context({ asks }))).rejects.toThrow(
        "INVALID_ARGUMENT: filePath contains characters that cannot be represented safely in permission patterns.",
      );
      expect(asks).toEqual([]);
      expect(await readFile(filePath, "utf8")).toBe("preserved\n");
    }

    await value.dispose?.();
  });

  test("never replans a move when the destination appears after approval", async () => {
    const sourcePath = join(root, "source.txt");
    const destinationPath = join(root, "destination.txt");
    await writeFile(sourcePath, "source\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit } = registry(value);
    const readResult = structured(
      await hashlineRead.execute({ filePath: "source.txt" }, context()),
    );
    await activateRead(value, readResult);
    const asks: AskRecord[] = [];
    const racing = context({
      asks,
      async onAsk(request) {
        if (request.permission === "edit") await writeFile(destinationPath, "raced\n");
      },
    });

    await expect(
      hashlineEdit.execute(
        {
          filePath: "source.txt",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "move_file", destinationPath: "destination.txt" }],
        },
        racing,
      ),
    ).rejects.toThrow("TARGET_EXISTS:");
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(1);
    expect(await readFile(sourcePath, "utf8")).toBe("source\n");
    expect(await readFile(destinationPath, "utf8")).toBe("raced\n");
    await value.dispose?.();
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
      await expect(
        hashlineWrite.execute({ filePath: "bad.txt:stream", content: "invalid" }, toolContext),
      ).rejects.toThrow("INVALID_ARGUMENT:");
      await expect(
        hashlineWrite.execute(
          {
            filePath: "missing/bad.txt:stream",
            content: "invalid",
            createParents: true,
          },
          toolContext,
        ),
      ).rejects.toThrow("INVALID_ARGUMENT:");
      expect(asks).toHaveLength(askCount);
      expect(await readdir(root)).toEqual(["new.txt"]);
    }
  });

  test("creates missing parents only through an explicit fixed plan", async () => {
    expect(
      hashlineWriteArgumentsSchema.safeParse({
        filePath: "nested/inner/new.txt",
        content: "created\n",
        createParents: true,
      }).success,
    ).toBe(true);
    expect(
      hashlineWriteArgumentsSchema.safeParse({
        filePath: "nested/inner/new.txt",
        content: "created\n",
        createParents: "yes",
      }).success,
    ).toBe(false);

    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineWrite } = registry(value);
    const toolContext = context({ asks });
    await expect(
      hashlineWrite.execute({ filePath: "strict/inner.txt", content: "strict\n" }, toolContext),
    ).rejects.toThrow(
      "PATH_NOT_FOUND: Parent directory for strict/inner.txt does not exist. Missing parents are not created by default; pass createParents:true only if this write should create them.",
    );
    await expect(
      hashlineWrite.execute(
        { filePath: "strict/inner.txt", content: "strict\n", createParents: false },
        toolContext,
      ),
    ).rejects.toThrow(
      "PATH_NOT_FOUND: Parent directory for strict/inner.txt does not exist. Missing parents are not created by default; pass createParents:true only if this write should create them.",
    );
    expect(asks).toHaveLength(0);

    const result = structured(
      await hashlineWrite.execute(
        {
          filePath: "nested/inner/new.txt",
          content: "created\n",
          createParents: true,
        },
        toolContext,
      ),
    );
    expect(result.output).toContain("Created 2 parent directories and the file");
    expect(result.metadata.createdDirectories).toEqual(["nested", join("nested", "inner")]);
    expect(await readFile(join(root, "nested", "inner", "new.txt"), "utf8")).toBe("created\n");
    expect(asks).toHaveLength(1);
    const canonicalRoot = await realpath(root);
    expect(asks[0]).toMatchObject({
      permission: "edit",
      patterns: [join("nested", "inner", "new.txt"), "nested", join("nested", "inner")],
      metadata: {
        createdDirectories: [join(canonicalRoot, "nested"), join(canonicalRoot, "nested", "inner")],
        filepaths: [
          join(canonicalRoot, "nested", "inner", "new.txt"),
          join(canonicalRoot, "nested"),
          join(canonicalRoot, "nested", "inner"),
        ],
      },
    });
    await value.dispose?.();
  });

  test("invalidates snapshots for every path created by a parent plan", async () => {
    const parentPath = join(root, "former-file");
    await writeFile(parentPath, "original\n");
    const value = await hooks();
    const { hashlineRead, hashlineEdit, hashlineWrite } = registry(value);
    const readResult = structured(
      await hashlineRead.execute({ filePath: "former-file" }, context()),
    );
    await activateRead(value, readResult);
    await rm(parentPath);

    await hashlineWrite.execute(
      {
        filePath: "former-file/created.txt",
        content: "created\n",
        createParents: true,
      },
      context(),
    );
    await rm(parentPath, { recursive: true });
    await writeFile(parentPath, "original\n");

    await expect(
      hashlineEdit.execute(
        {
          filePath: "former-file",
          snapshotId: String(readResult.metadata.snapshotId),
          operations: [{ op: "replace_file", lines: ["changed"], finalNewline: true }],
        },
        context(),
      ),
    ).rejects.toThrow("SNAPSHOT_UNKNOWN:");
    expect(await readFile(parentPath, "utf8")).toBe("original\n");
    await value.dispose?.();
  });

  test("authorizes an external parent plan before approval or mutation", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "better-hashline-plugin-parents-"));
    const value = await hooks();
    try {
      const { hashlineWrite } = registry(value);
      const deniedAsks: AskRecord[] = [];
      let externalAskCount = 0;
      await expect(
        hashlineWrite.execute(
          {
            filePath: join(externalRoot, "denied", "inner", "new.txt"),
            content: "denied\n",
            createParents: true,
          },
          context({
            asks: deniedAsks,
            onAsk(request) {
              if (request.permission === "external_directory") {
                externalAskCount += 1;
                if (externalAskCount === 3) throw new Error("denied external parent chain");
              }
            },
          }),
        ),
      ).rejects.toThrow("PERMISSION_DENIED:");
      expect(deniedAsks.map(({ permission }) => permission)).toEqual([
        "external_directory",
        "external_directory",
        "external_directory",
      ]);
      expect(await readdir(externalRoot)).toEqual([]);

      const canonicalExternalRoot = await realpath(externalRoot);
      const firstDirectory = join(canonicalExternalRoot, "allowed");
      const secondDirectory = join(firstDirectory, "inner");
      const target = join(secondDirectory, "new.txt");
      const plannedPaths = [target, firstDirectory, secondDirectory];
      const expectedPatterns = [
        [join(secondDirectory, "*")],
        [join(canonicalExternalRoot, "*")],
        [join(firstDirectory, "*")],
      ];
      const allowedAsks: AskRecord[] = [];
      await hashlineWrite.execute(
        {
          filePath: target,
          content: "allowed\n",
          createParents: true,
        },
        context({ asks: allowedAsks }),
      );

      const externalAsks = allowedAsks.filter(
        ({ permission }) => permission === "external_directory",
      );
      expect(allowedAsks.map(({ permission }) => permission)).toEqual([
        "external_directory",
        "external_directory",
        "external_directory",
        "edit",
      ]);
      expect(externalAsks.map(({ metadata }) => metadata?.filepath)).toEqual(plannedPaths);
      expect(externalAsks.map(({ patterns }) => patterns)).toEqual(expectedPatterns);
      expect(externalAsks.map(({ always }) => always)).toEqual(expectedPatterns);
      expect(allowedAsks.at(-1)).toMatchObject({
        permission: "edit",
        metadata: {
          filepaths: plannedPaths,
          createdDirectories: [firstDirectory, secondDirectory],
        },
      });
      expect(await readFile(target, "utf8")).toBe("allowed\n");
    } finally {
      await value.dispose?.();
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  test("preserves existing-parent behavior for explicit false and zero-missing true", async () => {
    await mkdir(join(root, "existing-parent"));
    const asks: AskRecord[] = [];
    const value = await hooks();
    const { hashlineWrite } = registry(value);
    const toolContext = context({ asks });

    const strict = structured(
      await hashlineWrite.execute(
        {
          filePath: "existing-parent/strict.txt",
          content: "strict\n",
          createParents: false,
        },
        toolContext,
      ),
    );
    const planned = structured(
      await hashlineWrite.execute(
        {
          filePath: "existing-parent/planned.txt",
          content: "planned\n",
          createParents: true,
        },
        toolContext,
      ),
    );

    expect(strict.output).toContain("Created the file");
    expect(planned.output).toContain("Created the file");
    expect(planned.metadata.createdDirectories).toEqual([]);
    expect(await readFile(join(root, "existing-parent", "strict.txt"), "utf8")).toBe("strict\n");
    expect(await readFile(join(root, "existing-parent", "planned.txt"), "utf8")).toBe("planned\n");
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(2);
    await value.dispose?.();
  });

  test("does not replan parents that appear during write approval", async () => {
    const value = await hooks();
    const { hashlineWrite } = registry(value);
    const asks: AskRecord[] = [];
    const toolContext = context({
      asks,
      async onAsk(request) {
        if (request.permission === "edit") await mkdir(join(root, "raced"));
      },
    });
    await expect(
      hashlineWrite.execute(
        {
          filePath: "raced/inner/new.txt",
          content: "planned\n",
          createParents: true,
        },
        toolContext,
      ),
    ).rejects.toThrow("RACE_BEFORE_WRITE:");
    await expect(readFile(join(root, "raced", "inner", "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(asks.filter(({ permission }) => permission === "edit")).toHaveLength(1);
    await value.dispose?.();
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
    expect(system.system.join("\n")).toContain(
      "neighboring lines outside the range remain, so do not repeat retained context such as a closing delimiter unless intentional.",
    );
    expect(system.system.join("\n")).toContain(
      "Every operation uses original immutable pre-batch coordinates; never shift later startLine/endLine/afterLine because of earlier operations and never target lines created by another operation.",
    );

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
    const migrationGuidance = system.system.join("\n");
    expect(migrationGuidance).toContain("two separate workflows");
    expect(migrationGuidance).toContain("hashline_read followed by hashline_edit");
    expect(migrationGuidance).toContain("first use native read");
    expect(migrationGuidance).toContain(
      "Never pass hashline output or snapshot IDs to native mutators",
    );
    const migrationRead = { description: "Read a file", parameters: {} };
    await value["tool.definition"]?.({ toolID: "read" }, migrationRead as never);
    expect(migrationRead.description).toContain(
      "Migration mode has two separate workflows: use native read before a native mutator changes an existing file",
    );
    expect(migrationRead.description).toContain(
      "native write or apply_patch may create an absent target without a preceding read",
    );
    expect(migrationRead.description).toContain("Use hashline_read only with hashline_edit");

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
    expect(invalidSystem.system.join("\n")).toContain(
      "Do not bypass this state with shell commands or another mutation tool",
    );
    const { hashlineRead } = registry(invalid);
    await expect(hashlineRead.execute({ filePath: "file.txt" }, context())).rejects.toThrow(
      "CONFIG_INVALID:",
    );
  });
});
