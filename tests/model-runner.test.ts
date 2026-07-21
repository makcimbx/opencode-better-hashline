import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAliasPilotV4 } from "../benchmarks/model/adapters.js";

function runRunner(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "./benchmarks/model/stage.ts", ...args], {
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
    expect(result.stdout.toString()).toContain("= 72 sessions");
    expect(result.stdout.toString()).toContain("864 total");
    expect(result.stdout.toString()).toContain("not approved for paid execution");
    expect(result.stdout.toString()).toContain(nativeAliasPilotV4.scheduleManifestSha256);
  });

  test("bounds the explicit native alias development probe model contract", () => {
    const result = runRunner([
      "--native-alias-probe",
      "--model=openai/gpt-5.6-luna",
      "--variant=medium",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("= 1 sessions");
    expect(result.stdout.toString()).toContain("12 total");

    const batch = runRunner([
      "--native-alias-probe",
      "--model=openai/gpt-5.6-sol",
      "--variant=medium",
      "--repeats=2",
    ]);
    expect(batch.exitCode).toBe(0);
    expect(batch.stdout.toString()).toContain("= 2 sessions");
    expect(batch.stdout.toString()).toContain("24 total");

    const openRouter = runRunner([
      "--native-alias-probe",
      "--model=openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
      "--variant=",
    ]);
    expect(openRouter.exitCode).toBe(0);

    const unknown = runRunner([
      "--native-alias-probe",
      "--model=openai/not-frozen",
      "--variant=medium",
    ]);
    expect(unknown.exitCode).not.toBe(0);

    const nested = runRunner([
      "--native-alias-probe",
      "--model=openai/gpt-5.6-luna",
      "--variant=medium",
      "--output=benchmarks/results/model/nested/probe",
    ]);
    expect(nested.exitCode).not.toBe(0);
    expect(nested.stderr.toString()).toContain("direct child");
  }, 40_000);

  test("rejects model overrides and incomplete paid approvals before execution", () => {
    const override = runRunner(["--native-alias-pilot", "--model=openai/other"]);
    expect(override.exitCode).not.toBe(0);
    expect(override.stderr.toString()).toContain("frozen model and variant manifest");

    const unapproved = runRunner([
      "--native-alias-pilot",
      "--execute",
      "--approved-sessions=72",
      "--approved-max-requests=864",
      "--approved-max-cost-usd=4",
      "--approved-source-commit=0000000000000000000000000000000000000000",
      "--approved-runner-sha256=0000000000000000000000000000000000000000000000000000000000000000",
    ]);
    expect(unapproved.exitCode).not.toBe(0);
    expect(unapproved.stderr.toString()).toContain("hard-disabled by its committed null");

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
  }, 30_000);

  test("keeps paid v4 execution hard-disabled even with dirty override", () => {
    const output = join(tmpdir(), `better-hashline-hard-disable-${randomUUID()}`);
    const result = runRunner([
      "--native-alias-pilot",
      "--execute",
      "--allow-dirty",
      `--output=${output}`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("hard-disabled by its committed null");
    expect(existsSync(output)).toBe(false);
  });
});
