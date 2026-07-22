import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PathLike, Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
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
  MAX_NEW_FILE_MISSING_DIRECTORIES,
  pathsAlias,
  publishDeletedFile,
  publishMovedFile,
  publishNewFile,
  publishNewFileWithParents,
  publishReplacement,
  readStableFile,
  resolveExistingFile,
  resolveMutableFile,
  resolveNewFile,
  resolveNewFileParentPlan,
  revalidateNewFileParentPlan,
  throwIfAborted,
  withPathLock,
  withPathLocks,
} from "../src/filesystem.js";

const encoder = new TextEncoder();
let root = "";

const stringPathFs = fsPromises as unknown as {
  lstat(path: PathLike): Promise<Stats>;
  realpath(path: PathLike): Promise<string>;
  stat(path: PathLike): Promise<Stats>;
};

function syscallError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

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
  test("uses platform path identity for lifecycle locks and alias rejection", () => {
    const upper = join(root, "Case.txt");
    const lower = join(root, "case.txt");
    expect(pathsAlias(upper, lower)).toBe(process.platform === "win32");
    expect(pathsAlias(upper, upper)).toBe(true);
  });

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

  test("resolves mutable entries and rejects terminal symlinks", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "file.txt"), "content");
    const resolved = await resolveMutableFile("src/file.txt", root);
    expect(resolved.canonicalPath).toEndWith(join("src", "file.txt"));
    expect(resolved.canonicalParent).toEndWith("src");

    if (process.platform !== "win32") {
      await symlink("file.txt", join(root, "src", "alias.txt"));
      await expect(resolveMutableFile("src/alias.txt", root)).rejects.toThrow("UNSUPPORTED_FILE:");
    }
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

describe("new-file parent planning", () => {
  test("keeps existing-parent creation compatible and exposes a frozen exact plan", async () => {
    const parent = join(root, "existing");
    await mkdir(parent);
    const resolved = await resolveNewFile("existing/file", root);
    const plan = await resolveNewFileParentPlan("existing/file", root);

    expect(plan).toMatchObject({
      requestedPath: resolved.requestedPath,
      requestedAbsolute: resolved.requestedAbsolute,
      requestedParent: resolved.requestedParent,
      canonicalParent: resolved.canonicalParent,
      canonicalPath: resolved.canonicalPath,
      missingDirectories: [],
    });
    expect(plan.anchor.canonicalPath).toBe(resolved.canonicalParent);
    expect(plan.mutationPaths).toEqual([resolved.canonicalPath]);
    expect(plan.lockPaths).toBe(plan.mutationPaths);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.anchor)).toBe(true);
    expect(Object.isFrozen(plan.anchor.canonicalIdentity)).toBe(true);
    expect(Object.isFrozen(plan.missingDirectories)).toBe(true);
    expect(Object.isFrozen(plan.mutationPaths)).toBe(true);
    await expect(revalidateNewFileParentPlan(plan)).resolves.toBeUndefined();

    const bytes = Uint8Array.of(0, 1, 127, 128, 255);
    await publishNewFileWithParents({
      plan,
      bytes,
      signal: new AbortController().signal,
    });
    expect(await readFile(resolved.canonicalPath)).toEqual(Buffer.from(bytes));
    await expect(
      publishNewFileWithParents({
        plan,
        bytes: encoder.encode("replacement"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("TARGET_EXISTS:");
    expect(await readFile(resolved.canonicalPath)).toEqual(Buffer.from(bytes));
  });

  test("computes exact requested and canonical paths root-to-leaf", async () => {
    const canonicalRoot = await realpath(root);
    const plan = await resolveNewFileParentPlan("one/two/target", root);
    const requestedDirectories = [join(root, "one"), join(root, "one", "two")] as const;
    const canonicalDirectories = [
      join(canonicalRoot, "one"),
      join(canonicalRoot, "one", "two"),
    ] as const;

    expect(plan.anchor.canonicalPath).toBe(canonicalRoot);
    expect(plan.missingDirectories.map((entry) => entry.requestedPath)).toEqual([
      ...requestedDirectories,
    ]);
    expect(plan.missingDirectories.map((entry) => entry.canonicalPath)).toEqual([
      ...canonicalDirectories,
    ]);
    expect(plan.missingDirectories.map((entry) => entry.requestedParent)).toEqual([
      root,
      requestedDirectories[0],
    ]);
    expect(plan.missingDirectories.map((entry) => entry.canonicalParent)).toEqual([
      canonicalRoot,
      canonicalDirectories[0],
    ]);
    expect(plan.mutationPaths).toEqual([
      ...canonicalDirectories,
      join(canonicalRoot, "one", "two", "target"),
    ]);
    expect(plan.lockPaths).toEqual(plan.mutationPaths);
    for (const entry of plan.missingDirectories) expect(Object.isFrozen(entry)).toBe(true);
  });

  test("accepts exactly the bounded missing depth and rejects one more", async () => {
    const accepted = Array.from(
      { length: MAX_NEW_FILE_MISSING_DIRECTORIES },
      (_, index) => `d${index}`,
    );
    const plan = await resolveNewFileParentPlan(join(...accepted, "target"), root);
    expect(plan.missingDirectories).toHaveLength(MAX_NEW_FILE_MISSING_DIRECTORIES);
    expect(plan.mutationPaths).toHaveLength(MAX_NEW_FILE_MISSING_DIRECTORIES + 1);

    await expect(
      resolveNewFileParentPlan(join("extra", ...accepted, "target"), root),
    ).rejects.toThrow("INVALID_ARGUMENT:");
  });

  test("rejects non-directories, dangling symlinks, existing targets, and unsafe paths", async () => {
    await writeFile(join(root, "blocker"), "not a directory");
    await expect(resolveNewFileParentPlan("blocker/child/target", root)).rejects.toThrow(
      "UNSUPPORTED_FILE:",
    );
    await writeFile(join(root, "existing"), "content");
    await expect(resolveNewFileParentPlan("existing", root)).rejects.toThrow("TARGET_EXISTS:");
    await expect(resolveNewFileParentPlan("unsafe\nparent/target", root)).rejects.toThrow(
      "INVALID_ARGUMENT:",
    );

    if (process.platform !== "win32") {
      await symlink("missing", join(root, "dangling"));
      await expect(resolveNewFileParentPlan("dangling/child/target", root)).rejects.toThrow(
        "UNSUPPORTED_FILE:",
      );

      const unsafeCanonicalParent = join(root, "unsafe\ncanonical");
      await mkdir(unsafeCanonicalParent);
      await symlink(unsafeCanonicalParent, join(root, "safe-alias"));
      await expect(resolveNewFileParentPlan("safe-alias/child/target", root)).rejects.toThrow(
        "UNSUPPORTED_FILE:",
      );
    } else {
      await expect(resolveNewFile("target.txt:stream", root)).rejects.toThrow("INVALID_ARGUMENT:");
      await expect(resolveNewFileParentPlan("parents/target.txt:stream", root)).rejects.toThrow(
        "INVALID_ARGUMENT:",
      );
    }
  });

  test("rejects anchor replacement without replanning or creating state", async () => {
    const anchor = join(root, "anchor");
    await mkdir(anchor);
    const plan = await resolveNewFileParentPlan("anchor/missing/target", root);
    await rename(anchor, join(root, "old-anchor"));
    await mkdir(anchor);

    await expect(revalidateNewFileParentPlan(plan)).rejects.toThrow("PATH_MISMATCH:");
    await expect(
      publishNewFileWithParents({
        plan,
        bytes: encoder.encode("content"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("PATH_MISMATCH:");
    await expect(stat(join(anchor, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "old-anchor", "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects symbolic-link anchor retargeting without replanning", async () => {
    if (process.platform === "win32") return;
    const firstAnchor = join(root, "first-anchor");
    const secondAnchor = join(root, "second-anchor");
    const requestedAnchor = join(root, "requested-anchor");
    await Promise.all([mkdir(firstAnchor), mkdir(secondAnchor)]);
    await symlink(firstAnchor, requestedAnchor);
    const plan = await resolveNewFileParentPlan("requested-anchor/missing/target", root);
    await unlink(requestedAnchor);
    await symlink(secondAnchor, requestedAnchor);

    await expect(revalidateNewFileParentPlan(plan)).rejects.toThrow("PATH_MISMATCH:");
    await expect(
      publishNewFileWithParents({
        plan,
        bytes: encoder.encode("content"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("PATH_MISMATCH:");
    await expect(lstat(join(firstAnchor, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(secondAnchor, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("distinguishes preflight races from ambiguous mkdir publication", async () => {
    const initialPlan = await resolveNewFileParentPlan("initial/deeper/target", root);
    const initialDirectory = initialPlan.missingDirectories[0];
    if (!initialDirectory) throw new Error("Expected an initial planned directory.");
    await mkdir(initialDirectory.canonicalPath);
    await expect(
      publishNewFileWithParents({
        plan: initialPlan,
        bytes: encoder.encode("content"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("RACE_BEFORE_WRITE:");
    expect((await stat(initialDirectory.canonicalPath)).isDirectory()).toBe(true);
    await expect(
      stat(initialPlan.missingDirectories[1]?.canonicalPath ?? ""),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const mkdirPlan = await resolveNewFileParentPlan("mkdir-race/deeper/target", root);
    const racedDirectory = mkdirPlan.missingDirectories[0];
    if (!racedDirectory) throw new Error("Expected a raced planned directory.");
    const realMkdir = fsPromises.mkdir;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      if (String(path) === racedDirectory.canonicalPath) {
        await realMkdir(path);
        throw syscallError("EEXIST");
      }
      await realMkdir(path);
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan: mkdirPlan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      mkdirMock.mockRestore();
    }
    expect((await stat(racedDirectory.canonicalPath)).isDirectory()).toBe(true);
    await expect(stat(mkdirPlan.missingDirectories[1]?.canonicalPath ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  test("serializes overlapping multi-path operations", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPathLocks([join(root, "a"), join(root, "b")], async () => {
      events.push("first:start");
      markStarted();
      await gate;
      events.push("first:end");
    });
    await started;
    const second = withPathLocks([join(root, "c"), join(root, "b")], async () => {
      events.push("second:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("releases acquired locks when a queued multi-path operation is canceled", async () => {
    const firstPath = join(root, "a");
    const independentPath = join(root, "b");
    let releaseFirst = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPathLock(firstPath, async () => {
      markStarted();
      await gate;
    });
    await started;

    const controller = new AbortController();
    const canceled = withPathLocks(
      [firstPath, independentPath],
      async () => {
        throw new Error("Canceled lock action must not run.");
      },
      controller.signal,
    );
    controller.abort(new Error("cancel queued move"));
    await expect(canceled).rejects.toThrow("cancel queued move");

    let independentRan = false;
    await withPathLock(independentPath, async () => {
      independentRan = true;
    });
    expect(independentRan).toBe(true);
    releaseFirst();
    await first;
  });

  test("releases earlier sorted locks when cancellation waits on a later key", async () => {
    const acquiredPath = join(root, "a-acquired");
    const blockedPath = join(root, "b-blocked");
    const laterPath = join(root, "c-later");
    const unrelatedPath = join(root, "d-unrelated");
    let releaseBlocked = () => {};
    let markBlockedStarted = () => {};
    const blockedStarted = new Promise<void>((resolve) => {
      markBlockedStarted = resolve;
    });
    const blockedGate = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const blocked = withPathLock(blockedPath, async () => {
      markBlockedStarted();
      await blockedGate;
    });
    await blockedStarted;

    const controller = new AbortController();
    let canceledActionRan = false;
    const canceled = withPathLocks(
      [laterPath, blockedPath, acquiredPath],
      async () => {
        canceledActionRan = true;
      },
      controller.signal,
    );
    let acquiredProbeRan = false;
    const acquiredProbe = withPathLock(acquiredPath, async () => {
      acquiredProbeRan = true;
    });
    let laterProbeRan = false;
    let unrelatedProbeRan = false;
    await Promise.all([
      withPathLock(laterPath, async () => {
        laterProbeRan = true;
      }),
      withPathLock(unrelatedPath, async () => {
        unrelatedProbeRan = true;
      }),
    ]);
    expect(acquiredProbeRan).toBe(false);
    expect(laterProbeRan).toBe(true);
    expect(unrelatedProbeRan).toBe(true);

    controller.abort(new Error("cancel after first sorted lock"));
    await expect(canceled).rejects.toThrow("cancel after first sorted lock");
    await acquiredProbe;
    expect(acquiredProbeRan).toBe(true);
    expect(canceledActionRan).toBe(false);

    releaseBlocked();
    await blocked;
    let blockedProbeRan = false;
    await withPathLock(blockedPath, async () => {
      blockedProbeRan = true;
    });
    expect(blockedProbeRan).toBe(true);
  });

  test("deletes one exact regular file and rejects stale publication", async () => {
    const path = join(root, "delete.txt");
    await writeFile(path, "content");
    const resolved = await resolveMutableFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    let consumed = false;
    await publishDeletedFile({
      resolved,
      expected,
      maxBytes: 1024,
      signal: new AbortController().signal,
      consume() {
        consumed = true;
      },
    });
    expect(consumed).toBe(true);
    await expect(readFile(path)).rejects.toThrow();

    await writeFile(path, "old");
    const staleResolved = await resolveMutableFile(path, root);
    const stale = await readStableFile(staleResolved, 1024, true);
    await writeFile(path, "changed");
    consumed = false;
    await expect(
      publishDeletedFile({
        resolved: staleResolved,
        expected: stale,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toThrow("RACE_BEFORE_WRITE:");
    expect(consumed).toBe(false);
    expect(await readFile(path, "utf8")).toBe("changed");
  });

  test("consumes delete provenance after a failed publication attempt", async () => {
    const path = join(root, "blocked-delete.txt");
    await writeFile(path, "content");
    const resolved = await resolveMutableFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async () => {
      throw Object.assign(new Error("raw EPERM"), { code: "EPERM" });
    });
    let consumed = false;
    try {
      await expect(
        publishDeletedFile({
          resolved,
          expected,
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {
            consumed = true;
          },
        }),
      ).rejects.toThrow("UNSUPPORTED_FILE: The filesystem could not delete the file.");
    } finally {
      unlinkMock.mockRestore();
    }
    expect(consumed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("content");
  });

  test("rejects a terminal symlink introduced after lifecycle resolution", async () => {
    if (process.platform === "win32") return;
    const sourcePath = join(root, "mutable-source.txt");
    const displacedPath = join(root, "displaced-source.txt");
    await writeFile(sourcePath, "content");
    const resolved = await resolveMutableFile(sourcePath, root);
    const expected = await readStableFile(resolved, 1024, true);
    await rename(sourcePath, displacedPath);
    await symlink("displaced-source.txt", sourcePath);

    let consumed = false;
    await expect(
      publishDeletedFile({
        resolved,
        expected,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toThrow("PATH_MISMATCH:");
    expect(consumed).toBe(false);
    expect(await readFile(displacedPath, "utf8")).toBe("content");
    expect(await readFile(sourcePath, "utf8")).toBe("content");
  });

  test("moves one exact file without overwriting the destination", async () => {
    await mkdir(join(root, "target"));
    const sourcePath = join(root, "source.txt");
    const destinationPath = join(root, "target", "moved.txt");
    await writeFile(sourcePath, "content");
    const source = await resolveMutableFile(sourcePath, root);
    const destination = await resolveNewFile(destinationPath, root);
    const expected = await readStableFile(source, 1024, true);
    let consumed = false;
    const verified = await publishMovedFile({
      source,
      destination,
      expected,
      maxBytes: 1024,
      signal: new AbortController().signal,
      consume() {
        consumed = true;
      },
    });
    expect(consumed).toBe(true);
    expect(new TextDecoder().decode(verified.bytes)).toBe("content");
    await expect(readFile(sourcePath)).rejects.toThrow();
    expect(await readFile(destinationPath, "utf8")).toBe("content");
    expect((await stat(destinationPath)).ino).toBe(expected.stats.ino);

    await writeFile(sourcePath, "new source");
    await writeFile(destinationPath, "existing");
    const blockedSource = await resolveMutableFile(sourcePath, root);
    const blockedDestination = await resolveNewFile(destinationPath, root);
    const blockedExpected = await readStableFile(blockedSource, 1024, true);
    consumed = false;
    await expect(
      publishMovedFile({
        source: blockedSource,
        destination: blockedDestination,
        expected: blockedExpected,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toThrow("TARGET_EXISTS:");
    expect(consumed).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe("new source");
    expect(await readFile(destinationPath, "utf8")).toBe("existing");
  });

  test("rejects cross-filesystem moves before publication", async () => {
    const sourcePath = join(root, "cross-device-source.txt");
    const destinationPath = join(root, "cross-device-destination.txt");
    await writeFile(sourcePath, "content");
    const source = await resolveMutableFile(sourcePath, root);
    const destination = await resolveNewFile(destinationPath, root);
    const expected = await readStableFile(source, 1024, true);
    destination.parentStats.dev = expected.stats.dev + 1;
    let consumed = false;

    await expect(
      publishMovedFile({
        source,
        destination,
        expected,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      }),
    ).rejects.toThrow("UNSUPPORTED_FILE: Moving files across filesystems is not supported.");
    expect(consumed).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe("content");
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  test("consumes move provenance after a link-time destination race", async () => {
    const sourcePath = join(root, "link-race-source.txt");
    const destinationPath = join(root, "link-race-destination.txt");
    await writeFile(sourcePath, "content");
    const source = await resolveMutableFile(sourcePath, root);
    const destination = await resolveNewFile(destinationPath, root);
    const expected = await readStableFile(source, 1024, true);
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async () => {
      throw Object.assign(new Error("raw EEXIST"), { code: "EEXIST" });
    });
    let consumed = false;
    try {
      await expect(
        publishMovedFile({
          source,
          destination,
          expected,
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {
            consumed = true;
          },
        }),
      ).rejects.toThrow("TARGET_EXISTS: The move destination already exists.");
    } finally {
      linkMock.mockRestore();
    }
    expect(consumed).toBe(true);
    expect(await readFile(sourcePath, "utf8")).toBe("content");
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  test("reports a partial move when source unlink fails", async () => {
    const sourcePath = join(root, "partial-source.txt");
    const destinationPath = join(root, "partial-destination.txt");
    await writeFile(sourcePath, "content");
    const source = await resolveMutableFile(sourcePath, root);
    const destination = await resolveNewFile(destinationPath, root);
    const expected = await readStableFile(source, 1024, true);
    const realUnlink = fsPromises.unlink;
    const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      if (String(path) === source.canonicalPath) {
        throw Object.assign(new Error("raw EBUSY"), { code: "EBUSY" });
      }
      return realUnlink(path);
    });
    try {
      await expect(
        publishMovedFile({
          source,
          destination,
          expected,
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {},
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      unlinkMock.mockRestore();
    }
    expect(await readFile(sourcePath, "utf8")).toBe("content");
    expect(await readFile(destinationPath, "utf8")).toBe("content");
  });

  test("publishes one replacement, preserves mode, and consumes at commit", async () => {
    const path = join(root, "script.sh");
    await writeFile(path, "old\n");
    if (process.platform !== "win32") await chmod(path, 0o751);
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    let consumed = false;
    const verified = await publishReplacement({
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
    expect(new TextDecoder().decode(verified.bytes)).toBe("new\n");
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

describe("new-file parent publication", () => {
  test("creates a nested chain root-to-leaf with exact bytes, identity, and mode", async () => {
    const plan = await resolveNewFileParentPlan("created/inner/target", root);
    const bytes = Uint8Array.of(0, 13, 10, 127, 128, 254, 255);
    const expectedMode = 0o777 & ~process.umask();

    await publishNewFileWithParents({
      plan,
      bytes,
      signal: new AbortController().signal,
    });

    let parentStats = await stat(plan.anchor.canonicalPath);
    for (const directory of plan.missingDirectories) {
      const requestedStats = await lstat(directory.requestedPath);
      const canonicalStats = await lstat(directory.canonicalPath);
      expect(requestedStats.isDirectory()).toBe(true);
      expect(requestedStats.isSymbolicLink()).toBe(false);
      expect(canonicalStats.isDirectory()).toBe(true);
      expect(requestedStats.dev).toBe(canonicalStats.dev);
      expect(requestedStats.ino).toBe(canonicalStats.ino);
      expect((await stat(directory.canonicalParent)).ino).toBe(parentStats.ino);
      if (process.platform !== "win32") expect(canonicalStats.mode & 0o777).toBe(expectedMode);
      parentStats = canonicalStats;
    }
    expect(await readFile(plan.canonicalPath)).toEqual(Buffer.from(bytes));
    const targetStats = await stat(plan.canonicalPath);
    expect(targetStats.isFile()).toBe(true);
    expect(targetStats.nlink).toBe(1);
    expect((await readdir(plan.canonicalParent)).some((name) => name.includes(".hashline-"))).toBe(
      false,
    );
  });

  test("pins the exact input bytes before parent creation begins", async () => {
    const plan = await resolveNewFileParentPlan("pinned-bytes/target", root);
    const bytes = Uint8Array.of(0, 1, 2, 127, 128, 254, 255);
    const expected = bytes.slice();
    const realMkdir = fsPromises.mkdir;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      bytes.fill(42);
    });
    try {
      await publishNewFileWithParents({ plan, bytes, signal: new AbortController().signal });
    } finally {
      mkdirMock.mockRestore();
    }

    expect(new Uint8Array(await readFile(plan.canonicalPath))).toEqual(expected);
  });

  test("leaves no state on cancellation or failure before the first mkdir", async () => {
    const cancelledPlan = await resolveNewFileParentPlan("cancelled/inner/target", root);
    const controller = new AbortController();
    controller.abort(new Error("cancel before parent creation"));
    await expect(
      publishNewFileWithParents({
        plan: cancelledPlan,
        bytes: encoder.encode("content"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel before parent creation");
    await expect(
      stat(cancelledPlan.missingDirectories[0]?.canonicalPath ?? ""),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const deniedPlan = await resolveNewFileParentPlan("denied/inner/target", root);
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async () => {
      throw syscallError("EACCES");
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan: deniedPlan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("UNSUPPORTED_FILE:");
    } finally {
      mkdirMock.mockRestore();
    }
    await expect(stat(deniedPlan.missingDirectories[0]?.canonicalPath ?? "")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  test("reports partial publication when the first mkdir creates state before failing", async () => {
    const plan = await resolveNewFileParentPlan("first-partial/inner/target", root);
    const firstDirectory = plan.missingDirectories[0];
    if (!firstDirectory) throw new Error("Expected a planned directory.");
    const realMkdir = fsPromises.mkdir;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      throw new Error("simulated post-mkdir failure");
    });
    let message = "";
    try {
      await publishNewFileWithParents({
        plan,
        bytes: encoder.encode("content"),
        signal: new AbortController().signal,
      });
    } catch (error) {
      message = String(error);
    } finally {
      mkdirMock.mockRestore();
    }

    expect(message).toContain("PARTIAL_PUBLICATION:");
    expect(message).not.toContain(root);
    expect(message).not.toContain(plan.anchor.canonicalPath);
    expect(message).not.toContain(plan.canonicalPath);
    expect((await lstat(firstDirectory.canonicalPath)).isDirectory()).toBe(true);
    await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports cancellation after the first mkdir as partial and retains the chain", async () => {
    const plan = await resolveNewFileParentPlan("cancel-after/inner/target", root);
    const firstDirectory = plan.missingDirectories[0];
    const secondDirectory = plan.missingDirectories[1];
    if (!firstDirectory || !secondDirectory) throw new Error("Expected two planned directories.");
    const controller = new AbortController();
    const realMkdir = fsPromises.mkdir;
    let calls = 0;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      calls += 1;
      if (calls === 1) controller.abort(new Error("cancel after parent creation"));
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan,
          bytes: encoder.encode("content"),
          signal: controller.signal,
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      mkdirMock.mockRestore();
    }
    expect((await lstat(firstDirectory.canonicalPath)).isDirectory()).toBe(true);
    await expect(lstat(secondDirectory.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("never rolls back directories after an exclusive mkdir race", async () => {
    const plan = await resolveNewFileParentPlan("partial-race/inner/target", root);
    const firstDirectory = plan.missingDirectories[0];
    const secondDirectory = plan.missingDirectories[1];
    if (!firstDirectory || !secondDirectory) throw new Error("Expected two planned directories.");
    const realMkdir = fsPromises.mkdir;
    let calls = 0;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      calls += 1;
      await realMkdir(path, { mode: 0o777, recursive: false });
      if (calls === 2) throw syscallError("EEXIST");
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      mkdirMock.mockRestore();
    }
    expect((await lstat(firstDirectory.canonicalPath)).isDirectory()).toBe(true);
    expect((await lstat(secondDirectory.canonicalPath)).isDirectory()).toBe(true);
    await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("detects parent replacement after mkdir and retains the detached directory", async () => {
    const anchorPath = join(root, "retarget-anchor");
    const displacedAnchor = join(root, "retarget-anchor-old");
    await mkdir(anchorPath);
    const plan = await resolveNewFileParentPlan("retarget-anchor/created/inner/target", root);
    const realMkdir = fsPromises.mkdir;
    let retargeted = false;
    const mkdirMock = spyOn(fsPromises, "mkdir").mockImplementation(async (path) => {
      await realMkdir(path, { mode: 0o777, recursive: false });
      if (!retargeted) {
        retargeted = true;
        await rename(anchorPath, displacedAnchor);
        await realMkdir(anchorPath);
      }
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      mkdirMock.mockRestore();
    }
    expect((await lstat(join(displacedAnchor, "created"))).isDirectory()).toBe(true);
    await expect(lstat(join(anchorPath, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not clobber a target that races staged publication", async () => {
    const plan = await resolveNewFileParentPlan("target-race/inner/target", root);
    const realLink = fsPromises.link;
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
      await writeFile(destination, "competitor");
      await realLink(source, destination);
    });
    try {
      await expect(
        publishNewFileWithParents({
          plan,
          bytes: encoder.encode("planned"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("PARTIAL_PUBLICATION:");
    } finally {
      linkMock.mockRestore();
    }
    expect(await readFile(plan.canonicalPath, "utf8")).toBe("competitor");
    for (const directory of plan.missingDirectories) {
      expect((await lstat(directory.canonicalPath)).isDirectory()).toBe(true);
    }
  });

  test("creates through a pinned symbolic-link or junction ancestor", async () => {
    const canonicalAnchor = join(root, "canonical-anchor");
    const requestedAnchor = join(root, "requested-anchor");
    await mkdir(canonicalAnchor);
    await symlink(
      canonicalAnchor,
      requestedAnchor,
      process.platform === "win32" ? "junction" : "dir",
    );
    const physicalAnchor = await realpath(canonicalAnchor);
    const plan = await resolveNewFileParentPlan("requested-anchor/created/target", root);
    const directory = plan.missingDirectories[0];
    if (!directory) throw new Error("Expected a planned directory.");

    expect(plan.anchor).toMatchObject({
      requestedPath: requestedAnchor,
      canonicalPath: physicalAnchor,
      requestedType: "symbolic-link",
    });
    expect(directory.requestedPath).toBe(join(requestedAnchor, "created"));
    expect(directory.canonicalPath).toBe(join(physicalAnchor, "created"));
    await publishNewFileWithParents({
      plan,
      bytes: encoder.encode("content"),
      signal: new AbortController().signal,
    });
    expect(await readFile(join(requestedAnchor, "created", "target"), "utf8")).toBe("content");
    expect(await readFile(join(canonicalAnchor, "created", "target"), "utf8")).toBe("content");
  });

  test("maps every staged handle failure to retained partial publication", async () => {
    const boundaryRoot = join(root, "handle-boundaries");
    await mkdir(boundaryRoot);
    const boundaries = ["writeFile", "sync", "stat", "close"] as const;

    for (const boundary of boundaries) {
      const plan = await resolveNewFileParentPlan(
        join("handle-boundaries", boundary, "target"),
        root,
      );
      const directory = plan.missingDirectories[0];
      if (!directory) throw new Error("Expected a planned directory.");
      const realOpen = fsPromises.open;
      const openMock = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await realOpen(path, flags, mode);
        if (!String(path).includes(".hashline-")) return handle;
        if (boundary === "writeFile") {
          spyOn(handle, "writeFile").mockImplementation(async () => {
            throw syscallError("EIO");
          });
        } else if (boundary === "sync") {
          spyOn(handle, "sync").mockImplementation(async () => {
            throw syscallError("EIO");
          });
        } else if (boundary === "stat") {
          spyOn(handle, "stat").mockImplementation(async () => {
            throw syscallError("EIO");
          });
        } else {
          const realClose = handle.close.bind(handle);
          let injected = false;
          spyOn(handle, "close").mockImplementation(async () => {
            if (!injected) {
              injected = true;
              await realClose();
              throw syscallError("EIO");
            }
            await realClose();
          });
        }
        return handle;
      });
      try {
        await expect(
          publishNewFileWithParents({
            plan,
            bytes: encoder.encode("content"),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("PARTIAL_PUBLICATION:");
      } finally {
        openMock.mockRestore();
      }
      expect((await lstat(directory.canonicalPath)).isDirectory()).toBe(true);
      await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(directory.canonicalPath)).some((name) => name.includes(".hashline-")),
      ).toBe(false);
    }
  });

  test("maps every path-level staged boundary to retained partial publication", async () => {
    const boundaryRoot = join(root, "path-boundaries");
    await mkdir(boundaryRoot);
    const boundaries = [
      "mkdir-verification",
      "stage-open",
      "stage-path-stat",
      "parent-revalidation",
      "link",
      "post-link-lstat",
      "cleanup",
      "readback",
      "final-chain",
    ] as const;
    const committedBoundaries = new Set(["post-link-lstat", "cleanup", "readback", "final-chain"]);

    for (const boundary of boundaries) {
      const plan = await resolveNewFileParentPlan(
        join("path-boundaries", boundary, "target"),
        root,
      );
      const directory = plan.missingDirectories[0];
      if (!directory) throw new Error("Expected a planned directory.");
      let restore = () => {};

      if (boundary === "mkdir-verification") {
        const realRealpath = stringPathFs.realpath;
        const mock = spyOn(stringPathFs, "realpath").mockImplementation(async (path) => {
          const resolved = await realRealpath(path);
          if (pathsAlias(resolved, directory.canonicalPath)) throw syscallError("EIO");
          return resolved;
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "stage-open") {
        const mock = spyOn(fsPromises, "open").mockImplementation(async () => {
          throw syscallError("EACCES");
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "stage-path-stat") {
        const realStat = stringPathFs.stat;
        const mock = spyOn(stringPathFs, "stat").mockImplementation(async (path) => {
          if (String(path).includes(".hashline-")) throw syscallError("EIO");
          return realStat(path);
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "parent-revalidation") {
        const realRealpath = stringPathFs.realpath;
        const mock = spyOn(stringPathFs, "realpath").mockImplementation(async (path) => {
          const resolved = await realRealpath(path);
          if (pathsAlias(resolved, directory.canonicalPath)) {
            const names = await readdir(directory.canonicalPath);
            if (names.some((name) => name.includes(".hashline-"))) throw syscallError("EIO");
          }
          return resolved;
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "link") {
        const mock = spyOn(fsPromises, "link").mockImplementation(async () => {
          throw syscallError("EPERM");
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "post-link-lstat") {
        const realLstat = stringPathFs.lstat;
        const mock = spyOn(stringPathFs, "lstat").mockImplementation(async (path) => {
          const stats = await realLstat(path);
          if (pathsAlias(await fsPromises.realpath(path), plan.canonicalPath)) {
            throw syscallError("EIO");
          }
          return stats;
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "cleanup") {
        const realRm = fsPromises.rm;
        let injected = false;
        const mock = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
          if (!injected && String(path).includes(".hashline-")) {
            injected = true;
            throw syscallError("EBUSY");
          }
          return realRm(path, options);
        });
        restore = () => mock.mockRestore();
      } else if (boundary === "readback") {
        const realOpen = fsPromises.open;
        const mock = spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
          if (flags === "r" && pathsAlias(await fsPromises.realpath(path), plan.canonicalPath)) {
            throw syscallError("EIO");
          }
          return realOpen(path, flags, mode);
        });
        restore = () => mock.mockRestore();
      } else {
        const realRealpath = stringPathFs.realpath;
        const realLstat = stringPathFs.lstat;
        let parentChecksAfterCommit = 0;
        const mock = spyOn(stringPathFs, "realpath").mockImplementation(async (path) => {
          const resolved = await realRealpath(path);
          if (pathsAlias(resolved, directory.canonicalPath)) {
            try {
              await realLstat(plan.canonicalPath);
              parentChecksAfterCommit += 1;
              if (parentChecksAfterCommit === 2) throw syscallError("EIO");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          return resolved;
        });
        restore = () => mock.mockRestore();
      }

      try {
        await expect(
          publishNewFileWithParents({
            plan,
            bytes: encoder.encode("content"),
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow("PARTIAL_PUBLICATION:");
      } finally {
        restore();
      }
      expect((await lstat(directory.canonicalPath)).isDirectory()).toBe(true);
      if (committedBoundaries.has(boundary)) {
        expect(await readFile(plan.canonicalPath, "utf8")).toBe("content");
      } else {
        await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(
        (await readdir(directory.canonicalPath)).some((name) => name.includes(".hashline-")),
      ).toBe(false);
    }
  });
});
