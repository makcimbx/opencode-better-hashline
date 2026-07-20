import { describe, expect, test } from "bun:test";
import { nativeAliasPilotV2 } from "../benchmarks/model/adapters.js";

function runRunner(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "./benchmarks/model/run.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("model benchmark paid gates", () => {
  test("freezes the complete proposed native alias pilot schedule in dry-run mode", () => {
    const result = runRunner(["--native-alias-pilot"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("= 96 sessions");
    expect(result.stdout.toString()).toContain("1152 total");
    expect(result.stdout.toString()).toContain("not approved for paid execution");
    expect(result.stdout.toString()).toContain(nativeAliasPilotV2.scheduleManifestSha256);
  });

  test("rejects model overrides and incomplete paid approvals before execution", () => {
    const override = runRunner(["--native-alias-pilot", "--model=openai/other"]);
    expect(override.exitCode).not.toBe(0);
    expect(override.stderr.toString()).toContain("frozen model and variant manifest");

    const unapproved = runRunner([
      "--native-alias-pilot",
      "--execute",
      "--approved-sessions=96",
      "--approved-max-requests=1152",
      "--approved-max-cost-usd=4",
      "--approved-source-commit=0000000000000000000000000000000000000000",
      "--approved-runner-sha256=0000000000000000000000000000000000000000000000000000000000000000",
    ]);
    expect(unapproved.exitCode).not.toBe(0);
    expect(unapproved.stderr.toString()).toContain("not approved for paid execution");

    const unsafeOutput = runRunner(["--native-alias-pilot", "--output=docs/pilot-evidence"]);
    expect(unsafeOutput.exitCode).not.toBe(0);
    expect(unsafeOutput.stderr.toString()).toContain("benchmarks/results/model");

    const nestedPreflightOutput = runRunner([
      "--native-alias-pilot",
      "--preflight",
      "--output=benchmarks/results/local/nested/pilot-evidence",
    ]);
    expect(nestedPreflightOutput.exitCode).not.toBe(0);
    expect(nestedPreflightOutput.stderr.toString()).toContain("direct child");
  });

  test("keeps paid v2 execution hard-disabled even with dirty override", () => {
    const result = runRunner(["--native-alias-pilot", "--execute", "--allow-dirty"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not approved for paid execution");
  });
});
