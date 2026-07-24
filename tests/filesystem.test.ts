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
import { HashlineError } from "../src/errors.js";
import {
  assertTargetAbsent,
  authorizeEdit,
  authorizeExternal,
  authorizeRead,
  canonicalizeRoot,
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
  stabilizeNewFileParentPlan,
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

  test("keeps a persistent stable-read race model-visible", async () => {
    const path = join(root, "raced-read");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const realStat = fsPromises.stat;
    let race = 0;
    const statMock = spyOn(fsPromises, "stat").mockImplementation((async (target: PathLike) => {
      if (String(target) === resolved.canonicalPath) {
        race += 1;
        await writeFile(path, "x".repeat(race + 3));
      }
      return realStat(target);
    }) as typeof fsPromises.stat);
    try {
      await expect(readStableFile(resolved, 1024, true)).rejects.toThrow(
        "RACE_BEFORE_WRITE: The file changed while it was being read. This read published nothing; run a fresh hashline_read and, before mutating, replan against the newly delivered snapshot.",
      );
    } finally {
      statMock.mockRestore();
    }
  });

  test("recovers when a read race settles within the bounded observation window", async () => {
    const path = join(root, "settled-read");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const realStat = fsPromises.stat;
    let injected = false;
    const statMock = spyOn(fsPromises, "stat").mockImplementation((async (target: PathLike) => {
      if (!injected && String(target) === resolved.canonicalPath) {
        injected = true;
        await writeFile(path, "settled");
      }
      return realStat(target);
    }) as typeof fsPromises.stat);
    try {
      const stable = await readStableFile(resolved, 1024, true);
      expect(new TextDecoder().decode(stable.bytes)).toBe("settled");
    } finally {
      statMock.mockRestore();
    }
  });

  test("retries a transient close failure on the same stable-read handle", async () => {
    const path = join(root, "close-retry-read.txt");
    await writeFile(path, "content");
    const resolved = await resolveExistingFile(path, root);
    const realOpen = fsPromises.open;
    let readOpens = 0;
    let closeAttempts = 0;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target) === resolved.canonicalPath && flags === "r") {
        readOpens += 1;
        const realClose = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation((async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw syscallError("EBUSY");
          await realClose();
        }) as typeof handle.close);
      }
      return handle;
    });
    try {
      const stable = await readStableFile(resolved, 1024, true);
      expect(new TextDecoder().decode(stable.bytes)).toBe("content");
    } finally {
      openMock.mockRestore();
    }
    expect(readOpens).toBe(1);
    expect(closeAttempts).toBe(2);
  });

  test("cancels a bounded canonical-root retry while it is waiting", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel canonical root");
    const realRealpath = fsPromises.realpath;
    let attempts = 0;
    const realpathMock = spyOn(fsPromises, "realpath").mockImplementation((async (target) => {
      if (String(target) === root) {
        attempts += 1;
        setTimeout(() => controller.abort(reason), 1);
        throw syscallError("EBUSY");
      }
      return realRealpath(target);
    }) as typeof fsPromises.realpath);
    try {
      await expect(canonicalizeRoot(root, controller.signal)).rejects.toBe(reason);
    } finally {
      realpathMock.mockRestore();
    }
    expect(attempts).toBe(1);
  });

  test("normalizes exhausted filesystem observations to a stable prepublication error", async () => {
    const realRealpath = fsPromises.realpath;
    let attempts = 0;
    const realpathMock = spyOn(fsPromises, "realpath").mockImplementation((async (target) => {
      if (String(target) === root) {
        attempts += 1;
        throw syscallError("EBUSY");
      }
      return realRealpath(target);
    }) as typeof fsPromises.realpath);
    try {
      await expect(canonicalizeRoot(root)).rejects.toThrow(
        "RACE_BEFORE_WRITE: A filesystem observation could not be completed safely. No publication occurred;",
      );
    } finally {
      realpathMock.mockRestore();
    }
    expect(attempts).toBe(3);
  });

  test("preserves stable observation recovery during parent planning", async () => {
    const unavailableParent = join(root, "unavailable-parent");
    const realLstat = fsPromises.lstat;
    let attempts = 0;
    const lstatMock = spyOn(fsPromises, "lstat").mockImplementation((async (target) => {
      if (String(target) === unavailableParent) {
        attempts += 1;
        throw syscallError("EBUSY");
      }
      return realLstat(target);
    }) as typeof fsPromises.lstat);
    try {
      await expect(
        resolveNewFileParentPlan(join(unavailableParent, "target.txt"), root),
      ).rejects.toThrow(
        "RACE_BEFORE_WRITE: A filesystem observation could not be completed safely. No publication occurred;",
      );
    } finally {
      lstatMock.mockRestore();
    }
    expect(attempts).toBe(3);
  });

  test("rejects a non-directory parent chain without retrying as uncertainty", async () => {
    const blocker = join(root, "parent-chain-blocker");
    const blockedParent = join(blocker, "missing");
    await writeFile(blocker, "not a directory");
    const realLstat = fsPromises.lstat;
    let inspections = 0;
    const lstatMock = spyOn(fsPromises, "lstat").mockImplementation((async (target) => {
      if (String(target) === blockedParent) {
        inspections += 1;
        throw syscallError("ENOTDIR");
      }
      return realLstat(target);
    }) as typeof fsPromises.lstat);

    try {
      await expect(
        resolveNewFileParentPlan(join(blockedParent, "target.txt"), root),
      ).rejects.toThrow("UNSUPPORTED_FILE: A path in the target parent chain is not a directory.");
    } finally {
      lstatMock.mockRestore();
    }
    expect(inspections).toBe(1);
  });

  test("bounds persistent close pressure without reopening a stable read", async () => {
    const path = join(root, "close-exhausted-read.txt");
    await writeFile(path, "content");
    const resolved = await resolveExistingFile(path, root);
    const realOpen = fsPromises.open;
    let readOpens = 0;
    let closeAttempts = 0;
    let cleanupClose: (() => Promise<void>) | undefined;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target) === resolved.canonicalPath && flags === "r") {
        readOpens += 1;
        cleanupClose = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation((async () => {
          closeAttempts += 1;
          throw syscallError("EBUSY");
        }) as typeof handle.close);
      }
      return handle;
    });
    try {
      await expect(readStableFile(resolved, 1024, true)).rejects.toThrow(
        "RACE_BEFORE_WRITE: An internal file handle could not be closed safely.",
      );
    } finally {
      openMock.mockRestore();
      await cleanupClose?.();
    }
    expect(readOpens).toBe(1);
    expect(closeAttempts).toBe(3);
  });

  test("requires a fresh delivered read when file size changes during the read", async () => {
    const path = join(root, "resized-read");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const realOpen = fsPromises.open;
    const openMock = spyOn(fsPromises, "open").mockImplementation((async (
      target: PathLike,
      flags: string | number,
    ) => {
      const handle = await realOpen(target, flags);
      let resized = false;
      return new Proxy(handle, {
        get(current, property) {
          if (property === "read") {
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(current.read, current, args);
              if (!resized) {
                resized = true;
                await fsPromises.appendFile(path, "!");
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(current, property, current);
          return typeof value === "function" ? value.bind(current) : value;
        },
      });
    }) as typeof fsPromises.open);
    try {
      await expect(readStableFile(resolved, 1024, true)).rejects.toThrow(
        "RACE_BEFORE_WRITE: The file changed size while it was being read. This read published nothing; run a fresh hashline_read and, before mutating, replan against the newly delivered snapshot.",
      );
    } finally {
      openMock.mockRestore();
    }
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
    const realRealpath = fsPromises.realpath;
    const requestedParent = join(root, "blocker", "child");
    const realpathMock = spyOn(fsPromises, "realpath").mockImplementation((async (
      target: PathLike,
    ) => {
      if (String(target) === requestedParent) throw syscallError("ENOTDIR");
      return realRealpath(target);
    }) as typeof fsPromises.realpath);
    try {
      await expect(resolveNewFile("blocker/child/target", root)).rejects.toThrow(
        "UNSUPPORTED_FILE: Parent path for blocker/child/target contains a non-directory component. No publication occurred; correct the parent path before retrying.",
      );
    } finally {
      realpathMock.mockRestore();
    }
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

  test("adopts an exact concurrently created directory prefix under the original locks", async () => {
    const plan = await resolveNewFileParentPlan("shared/deeper/target", root);
    const adopted = plan.missingDirectories[0];
    const remaining = plan.missingDirectories[1];
    if (!adopted || !remaining) throw new Error("Expected two planned directories.");
    await mkdir(adopted.canonicalPath);

    const stabilized = await stabilizeNewFileParentPlan(plan);
    expect(stabilized.anchor.canonicalPath).toBe(adopted.canonicalPath);
    expect(stabilized.missingDirectories.map((entry) => entry.canonicalPath)).toEqual([
      remaining.canonicalPath,
    ]);
    expect(stabilized.mutationPaths).toEqual([remaining.canonicalPath, plan.canonicalPath]);
    expect(stabilized.lockPaths).toEqual(plan.lockPaths);
    expect(Object.isFrozen(stabilized)).toBe(true);

    await publishNewFileWithParents({
      plan: stabilized,
      bytes: encoder.encode("content"),
      signal: new AbortController().signal,
    });
    expect(await readFile(plan.canonicalPath, "utf8")).toBe("content");
  });

  test("rejects an inconsistent appeared parent prefix instead of adopting uncertainty", async () => {
    if (process.platform === "win32") return;
    const canonicalAnchor = join(root, "prefix-anchor");
    const requestedAnchor = join(root, "prefix-alias");
    await mkdir(canonicalAnchor);
    await symlink(canonicalAnchor, requestedAnchor);
    const plan = await resolveNewFileParentPlan(
      join(requestedAnchor, "missing", "target.txt"),
      root,
    );
    const appeared = plan.missingDirectories[0];
    if (!appeared || appeared.requestedPath === appeared.canonicalPath) {
      throw new Error("Expected distinct requested and canonical parent paths.");
    }
    await mkdir(appeared.canonicalPath);

    const realLstat = fsPromises.lstat;
    let requestedChecks = 0;
    const lstatMock = spyOn(fsPromises, "lstat").mockImplementation((async (target) => {
      if (String(target) === appeared.requestedPath) {
        requestedChecks += 1;
        throw syscallError("ENOENT");
      }
      return realLstat(target);
    }) as typeof fsPromises.lstat);
    try {
      await expect(stabilizeNewFileParentPlan(plan)).rejects.toThrow(
        "RACE_BEFORE_WRITE: A planned parent appeared with an inconsistent path identity. No publication occurred.",
      );
    } finally {
      lstatMock.mockRestore();
    }
    expect(requestedChecks).toBe(1);
    await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
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

  test("fences queued overlapping mutations after partial publication", async () => {
    const path = join(root, "partial-fence.txt");
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPathLock(path, async () => {
      markFirstStarted();
      await firstGate;
      throw new HashlineError("PARTIAL_PUBLICATION", "The first publication is ambiguous.");
    });
    await firstStarted;

    let queuedRan = false;
    const queued = withPathLock(path, async () => {
      queuedRan = true;
    });
    releaseFirst();
    const [firstOutcome, queuedOutcome] = await Promise.allSettled([first, queued]);
    expect(String((firstOutcome as PromiseRejectedResult).reason)).toContain(
      "PARTIAL_PUBLICATION:",
    );
    expect(String((queuedOutcome as PromiseRejectedResult).reason)).toContain("RACE_BEFORE_WRITE:");
    expect(queuedRan).toBe(false);

    let freshRan = false;
    await withPathLock(path, async () => {
      freshRan = true;
    });
    expect(freshRan).toBe(true);
  });

  test("propagates a partial-publication fence across every reserved lock path", async () => {
    const firstPath = join(root, "partial-fence-a");
    const secondPath = join(root, "partial-fence-b");
    const unrelatedPath = join(root, "partial-fence-c");
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPathLocks([firstPath, secondPath], async () => {
      markFirstStarted();
      await firstGate;
      throw new HashlineError("PARTIAL_PUBLICATION", "The first publication is ambiguous.");
    });
    await firstStarted;

    let firstQueuedRan = false;
    let secondQueuedRan = false;
    const firstQueued = withPathLock(firstPath, async () => {
      firstQueuedRan = true;
    });
    const secondQueued = withPathLock(secondPath, async () => {
      secondQueuedRan = true;
    });
    await expect(withPathLock(unrelatedPath, async () => "unrelated")).resolves.toBe("unrelated");

    releaseFirst();
    const outcomes = await Promise.allSettled([first, firstQueued, secondQueued]);
    expect(String((outcomes[0] as PromiseRejectedResult).reason)).toContain("PARTIAL_PUBLICATION:");
    expect(String((outcomes[1] as PromiseRejectedResult).reason)).toContain("RACE_BEFORE_WRITE:");
    expect(String((outcomes[2] as PromiseRejectedResult).reason)).toContain("RACE_BEFORE_WRITE:");
    expect(firstQueuedRan).toBe(false);
    expect(secondQueuedRan).toBe(false);

    let freshRan = false;
    await withPathLocks([firstPath, secondPath], async () => {
      freshRan = true;
    });
    expect(freshRan).toBe(true);
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

  test("recovers a transient final absence observation after delete", async () => {
    const path = join(root, "delete-observation.txt");
    await writeFile(path, "content");
    const resolved = await resolveMutableFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const realLstat = stringPathFs.lstat;
    let consumed = false;
    let injected = false;
    const lstatMock = spyOn(stringPathFs, "lstat").mockImplementation(async (target) => {
      try {
        return await realLstat(target);
      } catch (error) {
        if (
          consumed &&
          !injected &&
          String(target) === resolved.canonicalPath &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          injected = true;
          throw syscallError("EBUSY");
        }
        throw error;
      }
    });
    try {
      await publishDeletedFile({
        resolved,
        expected,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      });
    } finally {
      lstatMock.mockRestore();
    }
    expect(injected).toBe(true);
    await expect(readFile(path)).rejects.toThrow();
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
      try {
        expect(unlinkMock).toHaveBeenCalledTimes(1);
      } finally {
        unlinkMock.mockRestore();
      }
    }
    expect(consumed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("content");
  });

  test("distinguishes delete disappearance from ambiguous syscall errors", async () => {
    const cases = [
      {
        code: "ENOENT",
        message:
          "RACE_BEFORE_WRITE: The file disappeared during delete publication. This call did not remove it, but the snapshot was consumed; inspect the path and take a fresh read before replanning.",
      },
      {
        code: "EIO",
        message:
          "RACE_AFTER_WRITE: Delete publication returned an unexpected filesystem error. Deletion may have occurred; inspect the path and take a fresh read before replanning. Do not blindly retry.",
      },
    ] as const;

    for (const { code, message } of cases) {
      const path = join(root, `delete-${code}.txt`);
      await writeFile(path, "content");
      const resolved = await resolveMutableFile(path, root);
      const expected = await readStableFile(resolved, 1024, true);
      const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async () => {
        throw Object.assign(new Error(`raw ${code}`), { code });
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
        ).rejects.toThrow(message);
      } finally {
        try {
          expect(unlinkMock).toHaveBeenCalledTimes(1);
        } finally {
          unlinkMock.mockRestore();
        }
      }
      expect(consumed).toBe(true);
      expect(await readFile(path, "utf8")).toBe("content");
    }
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

  test("recovers a transient final source observation after move", async () => {
    const sourcePath = join(root, "move-observation-source.txt");
    const destinationPath = join(root, "move-observation-destination.txt");
    await writeFile(sourcePath, "content");
    const source = await resolveMutableFile(sourcePath, root);
    const destination = await resolveNewFile(destinationPath, root);
    const expected = await readStableFile(source, 1024, true);
    const realLstat = stringPathFs.lstat;
    let consumed = false;
    let injected = false;
    const lstatMock = spyOn(stringPathFs, "lstat").mockImplementation(async (target) => {
      try {
        return await realLstat(target);
      } catch (error) {
        if (
          consumed &&
          !injected &&
          String(target) === source.canonicalPath &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          injected = true;
          throw syscallError("EBUSY");
        }
        throw error;
      }
    });
    try {
      await publishMovedFile({
        source,
        destination,
        expected,
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {
          consumed = true;
        },
      });
    } finally {
      lstatMock.mockRestore();
    }
    expect(injected).toBe(true);
    await expect(readFile(sourcePath)).rejects.toThrow();
    expect(await readFile(destinationPath, "utf8")).toBe("content");
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
      ).rejects.toThrow(
        "TARGET_EXISTS: The move destination appeared before no-replace publication. No move link was published, but the source snapshot was consumed; inspect the destination, choose an absent path, and take a fresh source read before retrying.",
      );
    } finally {
      try {
        expect(linkMock).toHaveBeenCalledTimes(1);
      } finally {
        linkMock.mockRestore();
      }
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
      try {
        expect(unlinkMock).toHaveBeenCalledTimes(1);
      } finally {
        unlinkMock.mockRestore();
      }
    }
    expect(await readFile(sourcePath, "utf8")).toBe("content");
    expect(await readFile(destinationPath, "utf8")).toBe("content");
  });

  test("distinguishes unsupported and ambiguous move link failures", async () => {
    const cases = [
      {
        code: "EPERM",
        message:
          "UNSUPPORTED_FILE: The filesystem cannot publish a no-replace file move. No move was reported, but the source snapshot was consumed; take a fresh source read before another workflow.",
      },
      {
        code: "EIO",
        message:
          "PARTIAL_PUBLICATION: The destination link operation returned an unexpected filesystem error, so the destination may exist.",
      },
    ] as const;

    for (const { code, message } of cases) {
      const sourcePath = join(root, `move-${code}-source.txt`);
      const destinationPath = join(root, `move-${code}-destination.txt`);
      await writeFile(sourcePath, "content");
      const source = await resolveMutableFile(sourcePath, root);
      const destination = await resolveNewFile(destinationPath, root);
      const expected = await readStableFile(source, 1024, true);
      const linkMock = spyOn(fsPromises, "link").mockImplementation(async () => {
        throw Object.assign(new Error(`raw ${code}`), { code });
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
        ).rejects.toThrow(message);
      } finally {
        try {
          expect(linkMock).toHaveBeenCalledTimes(1);
        } finally {
          linkMock.mockRestore();
        }
      }
      expect(consumed).toBe(true);
      expect(await readFile(sourcePath, "utf8")).toBe("content");
      await expect(readFile(destinationPath)).rejects.toThrow();
    }
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

  test("does not publish a replacement canceled after its final proof", async () => {
    const path = join(root, "cancel-before-rename.txt");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const controller = new AbortController();
    const reason = new Error("cancel before rename");
    const realOpen = fsPromises.open;
    const realRename = fsPromises.rename;
    let targetReadOpens = 0;
    let injected = false;
    let renameCalls = 0;
    let consumed = false;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (flags === "r" && String(target) === resolved.canonicalPath) {
        targetReadOpens += 1;
        if (targetReadOpens === 2) {
          const realClose = handle.close.bind(handle);
          spyOn(handle, "close").mockImplementation((async () => {
            await realClose();
            injected = true;
            controller.abort(reason);
          }) as typeof handle.close);
        }
      }
      return handle;
    });
    const renameMock = spyOn(fsPromises, "rename").mockImplementation(
      async (source, destination) => {
        renameCalls += 1;
        await realRename(source, destination);
      },
    );
    try {
      await expect(
        publishReplacement({
          resolved,
          expected,
          replacement: encoder.encode("new"),
          maxBytes: 1024,
          signal: controller.signal,
          consume() {
            consumed = true;
          },
        }),
      ).rejects.toBe(reason);
    } finally {
      renameMock.mockRestore();
      openMock.mockRestore();
    }
    expect(injected).toBe(true);
    expect(targetReadOpens).toBe(2);
    expect(consumed).toBe(false);
    expect(renameCalls).toBe(0);
    expect(await readFile(path, "utf8")).toBe("old");
    expect((await readdir(root)).some((entry) => entry.includes(".hashline-"))).toBe(false);
  });

  test("normalizes every post-rename verification failure as RACE_AFTER_WRITE", async () => {
    for (const boundary of ["abort", "open", "metadata"] as const) {
      const path = join(root, `post-rename-${boundary}.txt`);
      await writeFile(path, "old");
      const resolved = await resolveExistingFile(path, root);
      const expected = await readStableFile(resolved, 1024, true);
      const controller = new AbortController();
      const realRename = fsPromises.rename;
      const realOpen = fsPromises.open;
      let published = false;
      let consumed = false;
      const renameMock = spyOn(fsPromises, "rename").mockImplementation(
        async (source, destination) => {
          await realRename(source, destination);
          published = true;
          if (boundary === "abort") controller.abort(new Error("post-rename abort"));
        },
      );
      const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
        if (!published || flags !== "r" || String(target) !== resolved.canonicalPath) {
          return realOpen(target, flags, mode);
        }
        if (boundary === "open") throw syscallError("EIO");
        const handle = await realOpen(target, flags, mode);
        if (boundary === "metadata") {
          const realStat = handle.stat.bind(handle);
          let statCalls = 0;
          spyOn(handle, "stat").mockImplementation((async () => {
            const stats = await realStat();
            statCalls += 1;
            return statCalls === 2 ? ({ ...stats, mtimeMs: stats.mtimeMs + 1 } as Stats) : stats;
          }) as typeof handle.stat);
        }
        return handle;
      });
      try {
        await expect(
          publishReplacement({
            resolved,
            expected,
            replacement: encoder.encode("new"),
            maxBytes: 1024,
            signal: controller.signal,
            consume() {
              consumed = true;
            },
          }),
        ).rejects.toThrow(
          "RACE_AFTER_WRITE: Replacement was published, but post-publication verification failed. Inspect the target and take a fresh read before replanning. Do not blindly retry.",
        );
      } finally {
        openMock.mockRestore();
        renameMock.mockRestore();
      }
      expect(consumed).toBe(true);
      expect(await readFile(path, "utf8")).toBe("new");
    }
  });

  test("recovers a transient exact proof failure after replacement", async () => {
    const path = join(root, "replacement-observation.txt");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const realRename = fsPromises.rename;
    const realOpen = fsPromises.open;
    let published = false;
    let injected = false;
    const renameMock = spyOn(fsPromises, "rename").mockImplementation(
      async (source, destination) => {
        await realRename(source, destination);
        published = true;
      },
    );
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      if (published && !injected && flags === "r" && String(target) === resolved.canonicalPath) {
        injected = true;
        throw syscallError("EBUSY");
      }
      return realOpen(target, flags, mode);
    });
    try {
      const verified = await publishReplacement({
        resolved,
        expected,
        replacement: encoder.encode("new"),
        maxBytes: 1024,
        signal: new AbortController().signal,
        consume() {},
      });
      expect(new TextDecoder().decode(verified.bytes)).toBe("new");
    } finally {
      openMock.mockRestore();
      renameMock.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe("new");
  });

  test("preserves the primary replacement error when staging cleanup also fails", async () => {
    const path = join(root, "replacement-cleanup-failure.txt");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const renameMock = spyOn(fsPromises, "rename").mockImplementation(async () => {
      throw syscallError("EPERM");
    });
    const realUnlink = fsPromises.unlink;
    const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
      if (String(target).includes(".hashline-")) throw syscallError("EBUSY");
      return realUnlink(target);
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
      ).rejects.toThrow(
        "UNSUPPORTED_FILE: The filesystem could not atomically replace the target. No replacement was published, but the snapshot was consumed; take a fresh read before choosing another workflow. Staging cleanup also failed; an owned internal temporary file may remain.",
      );
    } finally {
      unlinkMock.mockRestore();
      renameMock.mockRestore();
    }
    expect(await readFile(path, "utf8")).toBe("old");
    const staging = (await readdir(root)).filter((entry) => entry.includes(".hashline-"));
    expect(staging).toHaveLength(1);
    await rm(join(root, staging[0] as string), { force: true });
  });

  test("preserves stable observation recovery during writability checks", async () => {
    const path = join(root, "writability-pressure.txt");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    let attempts = 0;
    let consumed = false;
    const accessMock = spyOn(fsPromises, "access").mockImplementation(async () => {
      attempts += 1;
      throw syscallError("EBUSY");
    });
    try {
      await expect(
        publishReplacement({
          resolved,
          expected,
          replacement: encoder.encode("new"),
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {
            consumed = true;
          },
        }),
      ).rejects.toThrow(
        "RACE_BEFORE_WRITE: A filesystem observation could not be completed safely. No publication occurred;",
      );
    } finally {
      accessMock.mockRestore();
    }
    expect(attempts).toBe(3);
    expect(consumed).toBe(false);
    expect(await readFile(path, "utf8")).toBe("old");
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

  test("bounds exclusive staging-name collisions before publication", async () => {
    const resolved = await resolveNewFile("staging-collisions.txt", root);
    const realOpen = fsPromises.open;
    let collisions = 0;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      if (String(target).includes(".hashline-") && flags === "wx") {
        collisions += 1;
        throw syscallError("EEXIST");
      }
      return realOpen(target, flags, mode);
    });
    try {
      await expect(
        publishNewFile({
          resolved,
          bytes: encoder.encode("created"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("RACE_BEFORE_WRITE: Internal staging names were already occupied.");
    } finally {
      openMock.mockRestore();
    }
    expect(collisions).toBe(3);
    await expect(readFile(resolved.canonicalPath)).rejects.toThrow();
  });

  test("reports an opened staging path whose identity cannot be proved", async () => {
    const resolved = await resolveNewFile("staging-unproved.txt", root);
    const realOpen = fsPromises.open;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target).includes(".hashline-") && flags === "wx") {
        spyOn(handle, "stat").mockRejectedValue(syscallError("EIO"));
      }
      return handle;
    });
    try {
      await expect(
        publishNewFile({
          resolved,
          bytes: encoder.encode("created"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        "RACE_BEFORE_WRITE: A filesystem observation could not be completed safely. No publication occurred; wait for transient filesystem pressure to settle or restore path access before retrying. Staging ownership could not be proved, so an internal temporary path may remain.",
      );
    } finally {
      openMock.mockRestore();
    }
    await expect(readFile(resolved.canonicalPath)).rejects.toThrow();
    expect((await readdir(root)).filter((entry) => entry.includes(".hashline-"))).toHaveLength(1);
  });

  test("bounds persistent owned-staging cleanup observations", async () => {
    const path = join(root, "staging-cleanup-observation.txt");
    await writeFile(path, "old");
    const resolved = await resolveExistingFile(path, root);
    const expected = await readStableFile(resolved, 1024, true);
    const realOpen = fsPromises.open;
    const realLstat = stringPathFs.lstat;
    let cleanupObservations = 0;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target).includes(".hashline-") && flags === "wx") {
        spyOn(handle, "writeFile").mockRejectedValue(syscallError("EIO"));
      }
      return handle;
    });
    const lstatMock = spyOn(stringPathFs, "lstat").mockImplementation(async (target) => {
      if (String(target).includes(".hashline-")) {
        cleanupObservations += 1;
        throw syscallError("EBUSY");
      }
      return realLstat(target);
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
      ).rejects.toThrow(
        "RACE_BEFORE_WRITE: Replacement preparation failed before publication. No publication occurred; wait for transient filesystem pressure to settle or restore filesystem access before retrying. Staging cleanup also failed; an owned internal temporary file may remain.",
      );
    } finally {
      lstatMock.mockRestore();
      openMock.mockRestore();
    }
    expect(cleanupObservations).toBe(3);
    expect(await readFile(path, "utf8")).toBe("old");
    expect((await readdir(root)).filter((entry) => entry.includes(".hashline-"))).toHaveLength(1);
  });

  test("reports persistent staging handle cleanup failures", async () => {
    for (const kind of ["replacement", "create"] as const) {
      const path = join(root, `staging-handle-cleanup-${kind}.txt`);
      if (kind === "replacement") await writeFile(path, "old");
      const realOpen = fsPromises.open;
      let closeAttempts = 0;
      let releaseStagingHandle: (() => Promise<void>) | undefined;
      const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await realOpen(target, flags, mode);
        if (String(target).includes(".hashline-") && flags === "wx") {
          releaseStagingHandle = handle.close.bind(handle);
          spyOn(handle, "writeFile").mockRejectedValue(syscallError("EIO"));
          spyOn(handle, "close").mockImplementation((async () => {
            closeAttempts += 1;
            throw syscallError("EBUSY");
          }) as typeof handle.close);
        }
        return handle;
      });
      try {
        const publication =
          kind === "replacement"
            ? (async () => {
                const resolved = await resolveExistingFile(path, root);
                const expected = await readStableFile(resolved, 1024, true);
                await publishReplacement({
                  resolved,
                  expected,
                  replacement: encoder.encode("new"),
                  maxBytes: 1024,
                  signal: new AbortController().signal,
                  consume() {},
                });
              })()
            : publishNewFile({
                resolved: await resolveNewFile(path, root),
                bytes: encoder.encode("new"),
                signal: new AbortController().signal,
              });
        await expect(publication).rejects.toThrow(
          "Staging handle cleanup also failed; an internal file descriptor may remain open.",
        );
      } finally {
        openMock.mockRestore();
        await releaseStagingHandle?.();
      }
      expect(closeAttempts).toBe(3);
      if (kind === "replacement") {
        expect(await readFile(path, "utf8")).toBe("old");
      } else {
        await expect(readFile(path)).rejects.toThrow();
      }
      for (const entry of await readdir(root)) {
        if (entry.includes(".hashline-")) await rm(join(root, entry), { force: true });
      }
    }
  });

  test("preserves readonly cancellation errors while reporting handle cleanup", async () => {
    for (const kind of ["replacement", "create"] as const) {
      const path = join(root, `readonly-abort-cleanup-${kind}.txt`);
      if (kind === "replacement") await writeFile(path, "old");
      const controller = new AbortController();
      const realOpen = fsPromises.open;
      const realLstat = stringPathFs.lstat;
      let closeAttempts = 0;
      let cleanupObservations = 0;
      let releaseStagingHandle: (() => Promise<void>) | undefined;
      const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await realOpen(target, flags, mode);
        if (String(target).includes(".hashline-") && flags === "wx") {
          releaseStagingHandle = handle.close.bind(handle);
          spyOn(handle, "writeFile").mockImplementation(async () => {
            controller.abort();
            throw controller.signal.reason;
          });
          spyOn(handle, "close").mockImplementation((async () => {
            closeAttempts += 1;
            throw syscallError("EBUSY");
          }) as typeof handle.close);
        }
        return handle;
      });
      const lstatMock = spyOn(stringPathFs, "lstat").mockImplementation(async (target) => {
        if (String(target).includes(".hashline-")) cleanupObservations += 1;
        return realLstat(target);
      });
      let publicationError: unknown;
      try {
        const publication =
          kind === "replacement"
            ? (async () => {
                const resolved = await resolveExistingFile(path, root);
                const expected = await readStableFile(resolved, 1024, true);
                await publishReplacement({
                  resolved,
                  expected,
                  replacement: encoder.encode("new"),
                  maxBytes: 1024,
                  signal: controller.signal,
                  consume() {},
                });
              })()
            : publishNewFile({
                resolved: await resolveNewFile(path, root),
                bytes: encoder.encode("new"),
                signal: controller.signal,
              });
        await publication;
      } catch (error) {
        publicationError = error;
      } finally {
        lstatMock.mockRestore();
        openMock.mockRestore();
        await releaseStagingHandle?.();
      }
      expect(publicationError).toBeInstanceOf(Error);
      expect((publicationError as Error).message).toContain(
        "Staging handle cleanup also failed; an internal file descriptor may remain open.",
      );
      expect((publicationError as Error).message).not.toContain("TypeError");
      expect(closeAttempts).toBe(3);
      expect(cleanupObservations).toBeGreaterThan(0);
      if (kind === "replacement") {
        expect(await readFile(path, "utf8")).toBe("old");
      } else {
        await expect(readFile(path)).rejects.toThrow();
      }
      for (const entry of await readdir(root)) {
        if (entry.includes(".hashline-")) await rm(join(root, entry), { force: true });
      }
    }
  });

  test("retries a transient staging close on the same owned handle", async () => {
    const resolved = await resolveNewFile("staging-close-retry.txt", root);
    const realOpen = fsPromises.open;
    let stagingOpens = 0;
    let closeAttempts = 0;
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await realOpen(target, flags, mode);
      if (String(target).includes(".hashline-") && flags === "wx") {
        stagingOpens += 1;
        const realClose = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation((async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw syscallError("EBUSY");
          await realClose();
        }) as typeof handle.close);
      }
      return handle;
    });
    try {
      await publishNewFile({
        resolved,
        bytes: encoder.encode("created"),
        signal: new AbortController().signal,
      });
    } finally {
      openMock.mockRestore();
    }
    expect(stagingOpens).toBe(1);
    expect(closeAttempts).toBe(2);
    expect(await readFile(resolved.canonicalPath, "utf8")).toBe("created");
    expect((await readdir(root)).some((entry) => entry.includes(".hashline-"))).toBe(false);
  });

  test("classifies staged growth as a pre-publication race", async () => {
    for (const kind of ["replacement", "create"] as const) {
      const path = join(root, `staging-growth-${kind}.txt`);
      if (kind === "replacement") await writeFile(path, "old");
      const realOpen = fsPromises.open;
      let grew = false;
      const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
        if (!grew && String(target).includes(".hashline-") && flags === "r") {
          grew = true;
          await fsPromises.appendFile(target, "!");
        }
        return realOpen(target, flags, mode);
      });
      try {
        if (kind === "replacement") {
          const resolved = await resolveExistingFile(path, root);
          const expected = await readStableFile(resolved, 1024, true);
          let consumed = false;
          await expect(
            publishReplacement({
              resolved,
              expected,
              replacement: encoder.encode("new"),
              maxBytes: 1024,
              signal: new AbortController().signal,
              consume() {
                consumed = true;
              },
            }),
          ).rejects.toThrow("RACE_BEFORE_WRITE:");
          expect(consumed).toBe(false);
          expect(await readFile(path, "utf8")).toBe("old");
        } else {
          const resolved = await resolveNewFile(path, root);
          await expect(
            publishNewFile({
              resolved,
              bytes: encoder.encode("new"),
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow("RACE_BEFORE_WRITE:");
          await expect(readFile(path)).rejects.toThrow();
        }
      } finally {
        openMock.mockRestore();
      }
      expect(grew).toBe(true);
      expect((await readdir(root)).some((entry) => entry.includes(".hashline-"))).toBe(false);
    }
  });

  test("recovers a transient exact proof failure after create", async () => {
    const resolved = await resolveNewFile("create-observation.txt", root);
    const realLink = fsPromises.link;
    const realOpen = fsPromises.open;
    let published = false;
    let injected = false;
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
      await realLink(source, destination);
      if (String(destination) === resolved.canonicalPath) published = true;
    });
    const openMock = spyOn(fsPromises, "open").mockImplementation(async (target, flags, mode) => {
      if (published && !injected && flags === "r" && String(target) === resolved.canonicalPath) {
        injected = true;
        throw syscallError("EBUSY");
      }
      return realOpen(target, flags, mode);
    });
    try {
      await publishNewFile({
        resolved,
        bytes: encoder.encode("created"),
        signal: new AbortController().signal,
      });
    } finally {
      openMock.mockRestore();
      linkMock.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(resolved.canonicalPath, "utf8")).toBe("created");
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
        try {
          expect(mock).toHaveBeenCalledTimes(1);
        } finally {
          mock.mockRestore();
        }
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
        try {
          expect(mock).toHaveBeenCalledTimes(1);
        } finally {
          mock.mockRestore();
        }
      }
      await expect(assertTargetAbsent(resolved)).resolves.toBeUndefined();
    }
    expect((await readdir(root)).some((entry) => entry.includes(".hashline-"))).toBe(false);
  });

  test("normalizes unexpected replacement and create publication errors", async () => {
    const replacementPath = join(root, "replace-EIO.txt");
    await writeFile(replacementPath, "old");
    const replacementResolved = await resolveExistingFile(replacementPath, root);
    const replacementExpected = await readStableFile(replacementResolved, 1024, true);
    const renameMock = spyOn(fsPromises, "rename").mockImplementation(async () => {
      throw Object.assign(new Error("raw EIO"), { code: "EIO" });
    });
    let consumed = false;
    try {
      await expect(
        publishReplacement({
          resolved: replacementResolved,
          expected: replacementExpected,
          replacement: encoder.encode("new"),
          maxBytes: 1024,
          signal: new AbortController().signal,
          consume() {
            consumed = true;
          },
        }),
      ).rejects.toThrow(
        "RACE_AFTER_WRITE: Replacement publication returned an unexpected filesystem error. Publication may have occurred; inspect the target and take a fresh read before replanning. Do not blindly retry.",
      );
    } finally {
      try {
        expect(renameMock).toHaveBeenCalledTimes(1);
      } finally {
        renameMock.mockRestore();
      }
    }
    expect(consumed).toBe(true);
    expect(await readFile(replacementPath, "utf8")).toBe("old");

    const createResolved = await resolveNewFile("create-EIO.txt", root);
    const linkMock = spyOn(fsPromises, "link").mockImplementation(async () => {
      throw Object.assign(new Error("raw EIO"), { code: "EIO" });
    });
    try {
      await expect(
        publishNewFile({
          resolved: createResolved,
          bytes: encoder.encode("new"),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        "RACE_AFTER_WRITE: The target link operation returned an unexpected filesystem error. The target file may already be committed; inspect it before retrying. If it exists, take a fresh hashline_read before editing; if it is absent, rebuild the creation plan. Do not blindly retry.",
      );
    } finally {
      try {
        expect(linkMock).toHaveBeenCalledTimes(1);
      } finally {
        linkMock.mockRestore();
      }
    }
    await expect(assertTargetAbsent(createResolved)).resolves.toBeUndefined();
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

  test("reports cancellation but recovers transient cleanup failures after create commit", async () => {
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
    const realUnlink = fsPromises.unlink;
    let injected = false;
    const unlinkMock = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
      if (!injected && String(path).includes(".hashline-")) {
        injected = true;
        throw Object.assign(new Error("raw EBUSY"), { code: "EBUSY" });
      }
      return realUnlink(path);
    });
    try {
      await expect(
        publishNewFile({
          resolved: cleanupFailure,
          bytes: encoder.encode("committed"),
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    } finally {
      unlinkMock.mockRestore();
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
      try {
        expect(mkdirMock).toHaveBeenCalledTimes(1);
      } finally {
        mkdirMock.mockRestore();
      }
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
      try {
        expect(mkdirMock).toHaveBeenCalledTimes(1);
      } finally {
        mkdirMock.mockRestore();
      }
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
    const recoveredBoundaries = new Set(["stat"]);

    for (const boundary of boundaries) {
      const plan = await resolveNewFileParentPlan(
        join("handle-boundaries", boundary, "target"),
        root,
      );
      const directory = plan.missingDirectories[0];
      if (!directory) throw new Error("Expected a planned directory.");
      let statInjected = false;
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
          const realStat = handle.stat.bind(handle);
          spyOn(handle, "stat").mockImplementation((async () => {
            if (!statInjected) {
              statInjected = true;
              throw syscallError("EBUSY");
            }
            return realStat();
          }) as typeof handle.stat);
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
        const publication = publishNewFileWithParents({
          plan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        });
        if (recoveredBoundaries.has(boundary)) {
          await publication.catch((error) => {
            throw new Error(`Expected ${boundary} to recover: ${String(error)}`);
          });
        } else {
          await expect(publication).rejects.toThrow("PARTIAL_PUBLICATION:");
        }
      } finally {
        openMock.mockRestore();
      }
      expect((await lstat(directory.canonicalPath)).isDirectory()).toBe(true);
      if (recoveredBoundaries.has(boundary)) {
        expect(await readFile(plan.canonicalPath, "utf8")).toBe("content");
      } else {
        await expect(lstat(plan.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
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
    const recoveredBoundaries = new Set(["cleanup"]);

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
        const realUnlink = fsPromises.unlink;
        let injected = false;
        const mock = spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
          if (!injected && String(path).includes(".hashline-")) {
            injected = true;
            throw syscallError("EBUSY");
          }
          return realUnlink(path);
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
        const publication = publishNewFileWithParents({
          plan,
          bytes: encoder.encode("content"),
          signal: new AbortController().signal,
        });
        if (recoveredBoundaries.has(boundary)) {
          await expect(publication).resolves.toBeUndefined();
        } else {
          await expect(publication).rejects.toThrow("PARTIAL_PUBLICATION:");
        }
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
