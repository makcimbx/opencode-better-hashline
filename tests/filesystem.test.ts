import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import {
  assertTargetAbsent,
  authorizeEdit,
  authorizeExternal,
  authorizeRead,
  publishNewFile,
  publishReplacement,
  readStableFile,
  resolveExistingFile,
  resolveNewFile,
  throwIfAborted,
  withPathLock,
} from "../src/filesystem.js";

const encoder = new TextEncoder();
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "better-hashline-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeContext(asks: unknown[]): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    async ask(input) {
      asks.push(input);
    },
  } as ToolContext;
}

describe("filesystem resolution and permissions", () => {
  test("resolves existing files, new-file parents, and stable bytes", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "file.txt"), "content");
    const existing = await resolveExistingFile("src/file.txt", root);
    expect(existing.canonicalPath).toEndWith(join("src", "file.txt"));
    expect(new TextDecoder().decode((await readStableFile(existing, 1024, true)).bytes)).toBe(
      "content",
    );

    const created = await resolveNewFile("src/new.txt", root);
    expect(created.canonicalPath).toEndWith(join("src", "new.txt"));
    await expect(assertTargetAbsent(created)).resolves.toBeUndefined();
  });

  test("rejects missing paths, directories, missing parents, and oversized files", async () => {
    await expect(resolveExistingFile("missing", root)).rejects.toThrow("PATH_NOT_FOUND:");
    await mkdir(join(root, "directory"));
    await expect(resolveExistingFile("directory", root)).rejects.toThrow("UNSUPPORTED_FILE:");
    await expect(resolveNewFile("missing/new.txt", root)).rejects.toThrow("PATH_NOT_FOUND:");
    await expect(resolveExistingFile("safe\n+++ forged", root)).rejects.toThrow(
      "INVALID_ARGUMENT:",
    );

    await writeFile(join(root, "large"), "large");
    const resolved = await resolveExistingFile("large", root);
    await expect(readStableFile(resolved, 2, true)).rejects.toThrow("UNSUPPORTED_FILE:");
  });

  test("inherits native external, read, and edit permission names", async () => {
    const asks: unknown[] = [];
    const context = fakeContext(asks);
    await writeFile(join(root, "inside"), "inside");
    const inside = await resolveExistingFile("inside", root);
    await authorizeExternal(context, inside);
    await authorizeRead(context, inside);
    await authorizeEdit(context, inside, "diff");
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({ permission: "read" });
    expect(asks[1]).toMatchObject({ permission: "edit", metadata: { diff: "diff" } });

    const outsideRoot = await mkdtemp(join(tmpdir(), "better-hashline-external-"));
    try {
      await writeFile(join(outsideRoot, "outside"), "outside");
      const outside = await resolveExistingFile(join(outsideRoot, "outside"), root);
      await authorizeExternal(context, outside);
      expect(asks[2]).toMatchObject({ permission: "external_directory" });
      const external = asks[2] as { patterns: string[]; always: string[] };
      expect(external.always).toEqual(external.patterns);
      expect(external.always).not.toContain("*");
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("rejects aborted reads and hard-linked edit targets", async () => {
    const path = join(root, "file");
    await writeFile(path, "content");
    await link(path, join(root, "alias"));
    const resolved = await resolveExistingFile("file", root);
    await expect(readStableFile(resolved, 1024, true)).rejects.toThrow("UNSUPPORTED_FILE:");
    await expect(readStableFile(resolved, 1024, false)).resolves.toMatchObject({
      bytes: encoder.encode("content"),
    });

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => throwIfAborted(controller.signal)).toThrow("stop");
    await expect(readStableFile(resolved, 1024, false, controller.signal)).rejects.toThrow("stop");
  });

  test("rejects a symlink retargeted after resolution", async () => {
    if (process.platform === "win32") return;
    await writeFile(join(root, "first"), "first");
    await writeFile(join(root, "second"), "second");
    await symlink("first", join(root, "alias"));
    const resolved = await resolveExistingFile("alias", root);
    await rm(join(root, "alias"));
    await symlink("second", join(root, "alias"));
    await expect(readStableFile(resolved, 1024, false)).rejects.toThrow("PATH_MISMATCH:");
  });

  test("rejects unsafe paths reached only through canonical symlink resolution", async () => {
    if (process.platform === "win32") return;
    const unsafeDirectory = join(root, "unsafe*parent");
    await mkdir(unsafeDirectory);
    await writeFile(join(unsafeDirectory, "file"), "content");
    await symlink(unsafeDirectory, join(root, "clean-parent"));
    await expect(resolveExistingFile("clean-parent/file", root)).rejects.toThrow(
      "UNSUPPORTED_FILE:",
    );
    await expect(resolveNewFile("clean-parent/new", root)).rejects.toThrow("UNSUPPORTED_FILE:");

    await writeFile(join(root, "unsafe\nname"), "content");
    await symlink("unsafe\nname", join(root, "clean-file"));
    await expect(resolveExistingFile("clean-file", root)).rejects.toThrow("UNSUPPORTED_FILE:");
  });
});

describe("filesystem publication", () => {
  test("serializes operations for the same canonical path", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPathLock(join(root, "file"), async () => {
      events.push("first:start");
      markStarted();
      await gate;
      events.push("first:end");
    });
    await started;
    const second = withPathLock(join(root, "file"), async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("publishes one replacement, preserves mode, and consumes at commit", async () => {
    const path = join(root, "script.sh");
    await writeFile(path, "old\n");
    if (process.platform !== "win32") await chmod(path, 0o751);
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    let consumed = false;
    await publishReplacement({
      resolved,
      expected,
      replacement: encoder.encode("new\n"),
      maxBytes: 1024,
      signal: new AbortController().signal,
      consume() {
        consumed = true;
      },
    });
    expect(consumed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("new\n");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o751);
  });

  test("rejects stale, read-only, and aborted replacements before publication", async () => {
    const path = join(root, "file");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    await writeFile(path, "changed");
    await expect(
      publishReplacement({
        resolved,
        expected,
        replacement: encoder.encode("new"),
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {},
      }),
    ).rejects.toThrow("RACE_BEFORE_WRITE:");
    expect(await readFile(path, "utf8")).toBe("changed");

    if (process.platform !== "win32") {
      await writeFile(path, "readonly");
      await chmod(path, 0o444);
      const readonly = await readStableFile(resolved, 1024, true);
      await expect(
        publishReplacement({
          resolved,
          expected: readonly,
          replacement: encoder.encode("new"),
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {},
        }),
      ).rejects.toThrow("UNSUPPORTED_FILE:");
      expect(await readFile(path, "utf8")).toBe("readonly");
      await chmod(path, 0o644);
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      publishReplacement({
        resolved,
        expected: await readStableFile(resolved, 1024, true),
        replacement: encoder.encode("new"),
        maxBytes: 1024,
        signal: controller.signal,
        consume() {},
      }),
    ).rejects.toThrow();
  });

  test("creates a file exclusively and rejects existing or concurrent targets", async () => {
    const resolved = await resolveNewFile("created.txt", root);
    await publishNewFile({
      resolved,
      bytes: encoder.encode("created"),
      signal: new AbortController().signal,
    });
    expect(await readFile(resolved.canonicalPath, "utf8")).toBe("created");
    await expect(assertTargetAbsent(resolved)).rejects.toThrow("TARGET_EXISTS:");
    await expect(
      publishNewFile({
        resolved,
        bytes: encoder.encode("other"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("TARGET_EXISTS:");

    const concurrent = await resolveNewFile("concurrent.txt", root);
    const outcomes = await Promise.allSettled([
      publishNewFile({
        resolved: concurrent,
        bytes: encoder.encode("one"),
        signal: new AbortController().signal,
      }),
      publishNewFile({
        resolved: concurrent,
        bytes: encoder.encode("two"),
        signal: new AbortController().signal,
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  test("does not create a file after cancellation", async () => {
    const resolved = await resolveNewFile("cancelled.txt", root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      publishNewFile({ resolved, bytes: encoder.encode("data"), signal: controller.signal }),
    ).rejects.toThrow();
    await expect(assertTargetAbsent(resolved)).resolves.toBeUndefined();
  });
});
