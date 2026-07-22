import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  excludesSensitiveJsonPaths,
  resolveSensitivePathAliases,
  verifyNativeAliasOracleFixture,
} from "../benchmarks/model/oracle-fixture.js";

describe("native alias worktree topology", () => {
  test("separates fixture paths from renderer worktree authority", async () => {
    expect(
      await verifyNativeAliasOracleFixture({
        packageVersion: "0.2.1",
        schemaSha256: "a".repeat(64),
        hostVersion: "1.18.4",
      }),
    ).toEqual({
      schemaVersion: 2,
      hostVersion: "1.18.4",
      legacyDecision: "invalid",
      correctedDecision: "valid",
      correctedReason: "valid",
      outsideFixtureDecision: "invalid",
      forgedLocatorDecision: "invalid",
    });
  });

  test("rejects decoded private paths across Windows escaping, separators, URLs, and case", () => {
    const privatePath = String.raw`C:\Users\Alice\AppData\Local\Temp\benchmark root`;
    const escapedWindows = JSON.stringify({ path: privatePath });
    expect(escapedWindows).not.toContain(privatePath);
    for (const value of [
      escapedWindows,
      JSON.stringify({ path: "C:/Users/Alice/AppData/Local/Temp/benchmark root/output.json" }),
      JSON.stringify({ path: String.raw`c:\users\alice\appdata\local\temp\BENCHMARK ROOT` }),
      JSON.stringify({ [privatePath]: true }),
      JSON.stringify({ nested: JSON.stringify({ path: privatePath }) }),
      JSON.stringify({ path: "file:///C:/Users/Alice/AppData/Local/Temp/benchmark%20root/a.json" }),
      JSON.stringify({ path: encodeURIComponent(`${privatePath}\\a.json`) }),
      JSON.stringify({ path: encodeURIComponent(encodeURIComponent(privatePath)) }),
    ]) {
      expect(excludesSensitiveJsonPaths(value, [privatePath])).toBe(false);
    }
    for (const value of [
      JSON.stringify({ path: `${privatePath}-public` }),
      JSON.stringify({ path: String.raw`D:\Users\Alice\AppData\Local\Temp\benchmark root` }),
      JSON.stringify({ path: "file:///C:/Users/Alice/AppData/Local/Temp/benchmark%2Groot" }),
      JSON.stringify({ path: "<fixture>/safe.txt" }),
    ]) {
      expect(excludesSensitiveJsonPaths(value, [privatePath])).toBe(true);
    }
    expect(excludesSensitiveJsonPaths("not JSON", [privatePath])).toBe(false);
  });

  test("rejects native file URLs and percent-encoded paths without matching sibling names", () => {
    const privatePath = join(tmpdir(), "better hashline private");
    const childPath = join(privatePath, "session.json");
    const fileUrl = pathToFileURL(childPath).href;
    for (const path of [
      fileUrl,
      fileUrl.replace(/^file:\/\//u, "FILE://localhost"),
      encodeURIComponent(childPath),
      encodeURIComponent(encodeURIComponent(childPath)),
    ]) {
      expect(excludesSensitiveJsonPaths(JSON.stringify({ path }), [privatePath])).toBe(false);
    }
    expect(
      excludesSensitiveJsonPaths(
        JSON.stringify({ path: pathToFileURL(`${privatePath}-lookalike`).href }),
        [privatePath],
      ),
    ).toBe(true);
    expect(
      excludesSensitiveJsonPaths(JSON.stringify({ note: "100% complete; %ZZ is literal" }), [
        privatePath,
      ]),
    ).toBe(true);
  });

  test("resolves and scans lexical and realpath aliases without exposing failed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-hashline-privacy-alias-"));
    try {
      const missing = join(root, "private-missing");
      let diagnostic = "";
      try {
        await resolveSensitivePathAliases([missing]);
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error);
      }
      expect(diagnostic).toBe(
        "Sensitive path aliases could not be resolved within privacy limits.",
      );
      expect(diagnostic).not.toContain(missing);

      const physical = join(root, "physical-root");
      const lexical = join(root, "lexical-root");
      await mkdir(physical);
      try {
        await symlink(physical, lexical, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (
          process.platform === "win32" &&
          ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
        ) {
          return;
        }
        throw error;
      }

      const canonical = await realpath(lexical);
      const aliases = await resolveSensitivePathAliases([lexical]);
      expect(aliases).toContain(lexical);
      expect(aliases).toContain(canonical);
      for (const path of [
        join(lexical, "session.json"),
        join(canonical, "session.json"),
        pathToFileURL(join(canonical, "session.json")).href,
        encodeURIComponent(join(lexical, "session.json")),
      ]) {
        expect(excludesSensitiveJsonPaths(JSON.stringify({ path }), aliases)).toBe(false);
      }
      expect(
        excludesSensitiveJsonPaths(JSON.stringify({ path: `${canonical}-lookalike` }), aliases),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when privacy traversal or decoding bounds are exceeded", () => {
    const privatePath = "/private/benchmark-root";
    expect(excludesSensitiveJsonPaths("{}", [])).toBe(false);
    expect(
      excludesSensitiveJsonPaths(
        "{}",
        Array.from({ length: 17 }, (_, index) => `/private/${index}`),
      ),
    ).toBe(false);

    let overEncoded = privatePath;
    for (let pass = 0; pass < 6; pass += 1) overEncoded = encodeURIComponent(overEncoded);
    expect(excludesSensitiveJsonPaths(JSON.stringify({ path: overEncoded }), [privatePath])).toBe(
      false,
    );
  });
});
