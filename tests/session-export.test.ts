import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestSessionExport } from "../src/session-export.js";

describe("session export attestation", () => {
  let root: string;
  let directory: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "better-hashline-export-")));
    directory = join(root, "nested", "fixture");
    await mkdir(directory, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function exported(path = "nested/fixture", messages: unknown[] = []) {
    return JSON.stringify({ info: { id: "session", directory, path }, messages });
  }

  test("attests one normalized worktree and session-bound history", async () => {
    const messages = [
      {
        info: { id: "message", sessionID: "session", role: "assistant" },
        parts: [{ id: "part", sessionID: "session", messageID: "message", type: "text" }],
      },
    ];
    const result = await attestSessionExport(
      exported("nested/fixture", messages),
      directory,
      "session",
      root,
    );
    expect(result.worktree).toBe(root);
    expect(result.directory).toBe(directory);
    expect(result.messages).toEqual(messages);

    const vcsRoot = await attestSessionExport(
      JSON.stringify({ info: { id: "session", directory, path: "" }, messages: [] }),
      directory,
      "session",
      directory,
    );
    expect(vcsRoot.worktree).toBe(directory);
  });

  test("accepts platform-valid POSIX colon segments", async () => {
    if (process.platform === "win32") return;
    const colonDirectory = join(root, "scope:name", "fixture");
    await mkdir(colonDirectory, { recursive: true });
    const result = await attestSessionExport(
      JSON.stringify({
        info: { id: "session", directory: colonDirectory, path: "scope:name/fixture" },
        messages: [],
      }),
      colonDirectory,
      "session",
      root,
    );
    expect(result.worktree).toBe(root);
  });

  test("rejects malformed, rooted, drive-qualified, and ambiguous locators", async () => {
    for (const locator of [
      "/nested/fixture",
      "nested/fixture/",
      "nested//fixture",
      "nested/./fixture",
      "nested/../fixture",
      "nested\\fixture",
      "C:/nested/fixture",
    ]) {
      await expect(
        attestSessionExport(exported(locator), directory, "session", root),
      ).rejects.toThrow();
    }
  });

  test("rejects session, directory, message, and part identity mismatches", async () => {
    await expect(attestSessionExport(exported(), directory, "other", root)).rejects.toThrow(
      "Session export ID",
    );
    await expect(
      attestSessionExport(
        JSON.stringify({ info: { id: "session", directory: root, path: "" }, messages: [] }),
        directory,
        "session",
        root,
      ),
    ).rejects.toThrow("directory");
    await expect(
      attestSessionExport(
        exported("nested/fixture", [{ info: { id: "message", sessionID: "other" }, parts: [] }]),
        directory,
        "session",
        root,
      ),
    ).rejects.toThrow("another session");
    await expect(
      attestSessionExport(
        exported("nested/fixture", [
          {
            info: { id: "message", sessionID: "session" },
            parts: [{ id: "part", sessionID: "other" }],
          },
        ]),
        directory,
        "session",
        root,
      ),
    ).rejects.toThrow("another session");
    await expect(
      attestSessionExport(
        exported("nested/fixture", [
          {
            info: { id: "message", sessionID: "session" },
            parts: [{ id: "part", sessionID: "session", messageID: "other" }],
          },
        ]),
        directory,
        "session",
        root,
      ),
    ).rejects.toThrow("another session");
  });

  test("does not use linguistic collation for physical directory identity", async () => {
    const ascii = join(root, "A", "fixture");
    const fullwidth = join(root, "Ａ", "fixture");
    await mkdir(ascii, { recursive: true });
    await mkdir(fullwidth, { recursive: true });
    await expect(
      attestSessionExport(
        JSON.stringify({
          info: { id: "session", directory: fullwidth, path: "Ａ/fixture" },
          messages: [],
        }),
        ascii,
        "session",
        root,
      ),
    ).rejects.toThrow("directory");
  });

  test("rejects a self-consistent locator for a different ancestor", async () => {
    const parent = join(root, "nested");
    await expect(
      attestSessionExport(exported("fixture"), directory, "session", root),
    ).rejects.toThrow("worktree");
    expect(await realpath(parent)).toBe(parent);
  });
});
