import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { exactRelativePath, isInsideCanonicalPath } from "../src/path-identity.js";

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
});
