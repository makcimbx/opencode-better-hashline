import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");

describe("deterministic benchmark suite", () => {
  test("runs all evidence gates without instrumenting benchmark sources", () => {
    const result = Bun.spawnSync([process.execPath, join(repository, "benchmarks/run.ts")], {
      cwd: repository,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(stdout).toContain("better-hashline-default");
    expect(stdout).toContain("Omitted incremental rebase uses the shared runtime policy resolver.");
    expect(stdout).toContain("Coverage-header wire-size change");
    expect(stdout).toContain("replace_file readback call wire size");
  });
});
