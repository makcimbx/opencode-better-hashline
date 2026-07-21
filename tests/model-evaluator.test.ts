import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExactTree } from "../benchmarks/model/evaluator.js";
import type { ModelTask } from "../benchmarks/model/tasks.js";

describe("model benchmark exact tree evaluator", () => {
  let root: string;
  const task: ModelTask = {
    id: "fixture",
    category: "test",
    prompt: "test",
    files: { "src/a.txt": "before\n" },
    expectedFiles: { "src/a.txt": "after\n" },
    absentFiles: ["absent.txt"],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "better-hashline-evaluator-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "after\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("accepts only the exact expected regular-file tree", async () => {
    expect(await evaluateExactTree(root, task)).toEqual({ exactFiles: true, mismatches: [] });
  });

  test("rejects hardlinks and unexpected empty directories", async () => {
    await link(join(root, "src", "a.txt"), join(root, "linked.txt"));
    await mkdir(join(root, "empty"));
    const result = await evaluateExactTree(root, task);
    expect(result.exactFiles).toBe(false);
    expect(result.mismatches).toContain("src/a.txt: hard links are not allowed");
    expect(result.mismatches).toContain("linked.txt: hard links are not allowed");
    expect(result.mismatches).toContain("empty: unexpected directory");
  });

  test("rejects symbolic links or junctions without traversing them", async () => {
    const external = await mkdtemp(join(tmpdir(), "better-hashline-evaluator-external-"));
    try {
      await writeFile(join(external, "secret.txt"), "secret\n");
      await symlink(external, join(root, "linked-directory"), "junction");
      const result = await evaluateExactTree(root, task);
      expect(result.exactFiles).toBe(false);
      expect(result.mismatches).toContain("linked-directory: symbolic link is not allowed");
      expect(result.mismatches.some((value) => value.includes("secret.txt"))).toBe(false);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("rejects a linked fixture root and unsafe manifest paths", async () => {
    const linkedRoot = `${root}-link`;
    try {
      await symlink(root, linkedRoot, "junction");
      expect(await evaluateExactTree(linkedRoot, task)).toEqual({
        exactFiles: false,
        mismatches: [".: fixture root is not a plain directory"],
      });
    } finally {
      await rm(linkedRoot, { force: true, recursive: true });
    }

    await expect(
      evaluateExactTree(root, { ...task, expectedFiles: { "../outside.txt": "no\n" } }),
    ).rejects.toThrow("Unsafe benchmark task path");
  });

  test("rejects a file identity swap between traversal and read", async () => {
    const replacement = join(root, "..", `${root.split(/[\\/]/).at(-1)}-replacement.txt`);
    await writeFile(replacement, "after\n");
    try {
      const result = await evaluateExactTree(root, task, {
        beforeRead: async (path) => {
          if (path !== "src/a.txt") return;
          await unlink(join(root, path));
          await link(replacement, join(root, path));
        },
      });
      expect(result.exactFiles).toBe(false);
      expect(result.mismatches).toContain("src/a.txt: identity changed before read");
    } finally {
      await rm(replacement, { force: true });
    }
  });

  test("reports content, absence, and missing-file mismatches", async () => {
    await writeFile(join(root, "src", "a.txt"), "wrong\n");
    await writeFile(join(root, "absent.txt"), "present\n");
    const changed = await evaluateExactTree(root, task);
    expect(changed.mismatches).toContain("src/a.txt: content mismatch");
    expect(changed.mismatches).toContain("absent.txt: should not exist");

    await unlink(join(root, "src", "a.txt"));
    const missing = await evaluateExactTree(root, task);
    expect(missing.mismatches).toContain("src/a.txt: missing");
  });

  test("rejects NTFS alternate data streams", async () => {
    if (process.platform !== "win32") return;
    await writeFile(`${join(root, "src", "a.txt")}:hidden`, "secret\n");
    const result = await evaluateExactTree(root, task);
    expect(result.exactFiles).toBe(false);
    expect(result.mismatches).toContain("src/a.txt: alternate data streams are not allowed");
  });
});
