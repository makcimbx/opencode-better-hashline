import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");

describe("deterministic benchmark suite", () => {
  test("gates the omitted runtime default beside the explicit controls", () => {
    const result = Bun.spawnSync([process.execPath, join(repository, "benchmarks/run.ts")], {
      cwd: repository,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("better-hashline-default");
    expect(result.stdout.toString()).toContain(
      "Omitted incremental rebase uses the shared runtime policy resolver.",
    );
  });
});
