import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRunnerBundle, readApprovedRunner } from "../benchmarks/model/stage-runner.js";

const repository = resolve(import.meta.dir, "..");

describe("staged model runner", () => {
  test("builds one self-contained executable artifact", async () => {
    const runner = await buildRunnerBundle(repository);
    const repeated = await buildRunnerBundle(repository);
    expect(runner.bytes.byteLength).toBeGreaterThan(0);
    expect(runner.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated.sha256).toBe(runner.sha256);
    expect(repeated.bytes).toEqual(runner.bytes);
  });

  test("rejects direct execution outside the staged boundary", () => {
    const result = Bun.spawnSync([process.execPath, join(repository, "benchmarks/model/run.ts")], {
      cwd: repository,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "must be launched through the staged runner boundary",
    );
  });

  test("loads the exact supplied approved bytes rather than rebuilding them", async () => {
    const runner = await buildRunnerBundle(repository);
    const root = await mkdtemp(join(tmpdir(), "better-hashline-stage-test-"));
    const approved = join(root, "approved-runner.mjs");
    await writeFile(approved, runner.bytes, { flag: "wx", mode: 0o400 });
    try {
      const loaded = await readApprovedRunner(approved, runner.sha256);
      expect(loaded.sha256).toBe(runner.sha256);
      expect(loaded.bytes).toEqual(runner.bytes);
      await chmod(approved, 0o600);
      await writeFile(approved, "substituted");
      await expect(readApprovedRunner(approved, runner.sha256)).rejects.toThrow(
        "do not match the external approval bundle",
      );
      await expect(readApprovedRunner(approved, "invalid")).rejects.toThrow("SHA-256 is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
