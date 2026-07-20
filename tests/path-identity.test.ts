import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exactRelativePath,
  isInsideCanonicalPath,
  physicalRelativePath,
} from "../src/path-identity.js";

describe("canonical path identity", () => {
  test("round-trips exact canonical path segments", () => {
    const root = resolve("fixture", "Case");
    const child = resolve(root, "file.txt");
    const sibling = resolve("fixture", "case", "file.txt");

    expect(exactRelativePath(root, child)).toBe("file.txt");
    expect(isInsideCanonicalPath(root, child)).toBe(true);
    expect(isInsideCanonicalPath(root, sibling)).toBe(false);
    if (process.platform === "win32") expect(exactRelativePath(root, sibling)).toBeUndefined();
  });

  test("derives relative segments across a canonicalized ancestor", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "better-hashline-path-identity-"));
    try {
      const actual = join(temporary, "actual");
      const root = join(actual, "root");
      const child = join(root, "file.txt");
      const alias = join(temporary, "alias");
      await mkdir(root, { recursive: true });
      await writeFile(child, "content");
      await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");

      expect(physicalRelativePath(join(alias, "root"), await realpath(child))).toBe("file.txt");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
