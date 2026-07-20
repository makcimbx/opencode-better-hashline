import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
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

    if (process.platform !== "win32") {
      const wildcardRoot = join(tmpdir(), `better-hashline-external-${randomUUID()}-*?`);
      try {
        await mkdir(wildcardRoot);
        await writeFile(join(wildcardRoot, "outside"), "outside");
        const outside = await resolveExistingFile(join(wildcardRoot, "outside"), root);
        await authorizeExternal(context, outside);
        const external = asks.at(-1) as { patterns: string[]; always: string[] };
        expect(external.patterns).toHaveLength(1);
        expect(external.always).toEqual([]);
      } finally {
        await rm(wildcardRoot, { recursive: true, force: true });
      }
    }
  });

  test("does not treat OpenCode's root worktree sentinel as containment", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "better-hashline-sentinel-external-"));
    try {
      await writeFile(join(outsideRoot, "outside"), "outside");
      const resolved = await resolveExistingFile(join(outsideRoot, "outside"), root);
      const asks: unknown[] = [];
      const context = fakeContext(asks);
      context.worktree = "/";

      await authorizeExternal(context, resolved);

      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ permission: "external_directory" });
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

  test("accepts literal permission characters and rejects unsafe canonical normalization", async () => {
    const literalDirectory = join(root, "literal[slug]{value}!");
    await mkdir(literalDirectory);
    await writeFile(join(literalDirectory, "file"), "content");
    await expect(resolveExistingFile(join(literalDirectory, "file"), root)).resolves.toBeDefined();
    await expect(resolveNewFile(join(literalDirectory, "new"), root)).resolves.toBeDefined();

    if (process.platform === "win32") {
      await expect(resolveNewFile("bad?.txt", root)).rejects.toThrow("INVALID_ARGUMENT:");
      await expect(resolveNewFile("bad*.txt", root)).rejects.toThrow("INVALID_ARGUMENT:");
      return;
    }
    const wildcardDirectory = join(root, "wild*?parent");
    await mkdir(wildcardDirectory);
    await writeFile(join(wildcardDirectory, "file"), "content");
    await symlink(wildcardDirectory, join(root, "clean-parent"));
    await expect(resolveExistingFile("clean-parent/file", root)).resolves.toBeDefined();
    await expect(resolveNewFile("clean-parent/new", root)).resolves.toBeDefined();

    const backslashDirectory = join(root, "unsafe\\parent");
    await mkdir(backslashDirectory);
    await symlink(backslashDirectory, join(root, "backslash-parent"));
    await expect(resolveNewFile("backslash-parent/new", root)).rejects.toThrow("UNSUPPORTED_FILE:");

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
    expect((await stat(resolved.canonicalPath)).nlink).toBe(1);
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
    expect(
      String(
        (outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason,
      ),
    ).toContain("TARGET_EXISTS:");
    expect(["one", "two"]).toContain(await readFile(concurrent.canonicalPath, "utf8"));
  });

  test("maps unsupported replacement and create publication errors", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const path = join(root, `replace-${code}`);
      await writeFile(path, "old");
      const resolved = await resolveExistingFile(path, root);
      const expected = await readStableFile(resolved, 1024, true);
      const mock = spyOn(fsPromises, "rename").mockImplementation(async () => {
        throw Object.assign(new Error(`raw ${code}`), { code });
      });
      try {
        await expect(
          publishReplacement({
            resolved,
            expected,
            replacement: encoder.encode("new"),
            maxBytes: 1024,
            signal: new AbortController().signal,
            consume() {},
          }),
        ).rejects.toThrow("UNSUPPORTED_FILE:");
      } finally {
        mock.mockRestore();
      }
      expect(await readFile(path, "utf8")).toBe("old");
    }

    for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]) {
      const resolved = await resolveNewFile(`create-${code}`, root);
      const mock = spyOn(fsPromises, "link").mockImplementation(async () => {
        throw Object.assign(new Error(`raw ${code}`), { code });
      });
      try {
        await expect(
          publishNewFile({
            resolved,
            bytes: encoder.encode("new"),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("UNSUPPORTED_FILE:");
      } finally {
        mock.mockRestore();
      }
      await expect(assertTargetAbsent(resolved)).resolves.toBeUndefined();
    }
    expect((await readdir(root)).some((entry) => entry.includes(".hashline-"))).toBe(false);
  });

  test("detects post-link byte, identity, and hardlink changes without rollback", async () => {
    const realLink = fsPromises.link;

    const changed = await resolveNewFile("changed-after-link", root);
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
      await realLink(source, destination);
      await writeFile(destination, "changed");
    });
    try {
      await expect(
        publishNewFile({
          resolved: changed,
          bytes: encoder.encode("created"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RACE_AFTER_WRITE:");
    } finally {
      linkMock.mockRestore();
    }
    expect(await readFile(changed.canonicalPath, "utf8")).toBe("changed");

    const replaced = await resolveNewFile("replaced-after-link", root);
    const replacedMock = spyOn(fsPromises, "link").mockImplementation(
      async (source, destination) => {
        await realLink(source, destination);
        await rm(destination);
        await writeFile(destination, "created");
      },
    );
    try {
      await expect(
        publishNewFile({
          resolved: replaced,
          bytes: encoder.encode("created"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RACE_AFTER_WRITE:");
    } finally {
      replacedMock.mockRestore();
    }
    expect(await readFile(replaced.canonicalPath, "utf8")).toBe("created");

    const aliased = await resolveNewFile("aliased-after-link", root);
    const alias = join(root, "external-alias");
    const aliasMock = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
      await realLink(source, destination);
      await realLink(destination, alias);
    });
    try {
      await expect(
        publishNewFile({
          resolved: aliased,
          bytes: encoder.encode("created"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RACE_AFTER_WRITE:");
    } finally {
      aliasMock.mockRestore();
    }
    expect((await stat(aliased.canonicalPath)).nlink).toBe(2);
  });

  test("reports cancellation and cleanup failures after create commit", async () => {
    const realLink = fsPromises.link;
    const cancelled = await resolveNewFile("cancelled-after-link", root);
    const controller = new AbortController();
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
      await realLink(source, destination);
      controller.abort(new Error("cancelled after link"));
    });
    try {
      await expect(
        publishNewFile({
          resolved: cancelled,
          bytes: encoder.encode("committed"),
          signal: controller.signal,
        }),
      ).rejects.toThrow("RACE_AFTER_WRITE:");
    } finally {
      linkMock.mockRestore();
    }
    expect(await readFile(cancelled.canonicalPath, "utf8")).toBe("committed");

    const cleanupFailure = await resolveNewFile("cleanup-failed-after-link", root);
    const realRm = fsPromises.rm;
    let injected = false;
    const rmMock = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (!injected && String(path).includes(".hashline-")) {
        injected = true;
        throw Object.assign(new Error("raw EBUSY"), { code: "EBUSY" });
      }
      return realRm(path, options);
    });
    try {
      await expect(
        publishNewFile({
          resolved: cleanupFailure,
          bytes: encoder.encode("committed"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RACE_AFTER_WRITE:");
    } finally {
      rmMock.mockRestore();
    }
    expect(await readFile(cleanupFailure.canonicalPath, "utf8")).toBe("committed");
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
