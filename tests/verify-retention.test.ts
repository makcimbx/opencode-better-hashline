import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainSanitizedVerifierArtifacts } from "../src/verifier-retention.js";

describe("verifier retention", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("retains only explicitly validated sanitized artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-hashline-retention-"));
    roots.push(root);
    await mkdir(join(root, "data", "sessions"), { recursive: true });
    await writeFile(
      join(root, "data", "sessions", "raw.json"),
      "PRIVATE_CANARY canonicalPath betterHashline @@ -1 +1 @@",
    );

    const sanitized = '{"info":{"id":"redacted"},"messages":[]}';
    await retainSanitizedVerifierArtifacts(
      root,
      new Map([["native-edit.session.sanitized.json", sanitized]]),
      true,
    );

    expect(await readdir(root)).toEqual(["native-edit.session.sanitized.json"]);
    expect(await readFile(join(root, "native-edit.session.sanitized.json"), "utf8")).toBe(
      sanitized,
    );
  });
});
