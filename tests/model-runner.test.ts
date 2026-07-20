import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAliasPilotV1 } from "../benchmarks/model/adapters.js";

function runRunner(args: string[], environment: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, "./benchmarks/model/run.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
}

function pilotIdentityArgs() {
  const dryRun = runRunner(["--native-alias-pilot"]);
  const runnerSha256 = dryRun.stdout.toString().match(/Runner SHA-256 ([0-9a-f]{64})/u)?.[1];
  const sourceCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  if (!runnerSha256 || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Pilot identity could not be derived for the gate test.");
  }
  return [`--approved-source-commit=${sourceCommit}`, `--approved-runner-sha256=${runnerSha256}`];
}

describe("model benchmark paid gates", () => {
  test("freezes the complete native alias pilot in dry-run mode", () => {
    const result = runRunner(["--native-alias-pilot"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("= 96 sessions");
    expect(result.stdout.toString()).toContain("1152 total");
    expect(result.stdout.toString()).toContain("exact 96/1152/USD 4 approvals");
    expect(result.stdout.toString()).toContain(nativeAliasPilotV1.scheduleManifestSha256);
  });

  test("rejects model overrides and incomplete paid approvals before execution", () => {
    const override = runRunner(["--native-alias-pilot", "--model=openai/other"]);
    expect(override.exitCode).not.toBe(0);
    expect(override.stderr.toString()).toContain("frozen model and variant manifest");

    const unapproved = runRunner(["--native-alias-pilot", "--execute"]);
    expect(unapproved.exitCode).not.toBe(0);
    expect(unapproved.stderr.toString()).toContain("approved-max-cost-usd");

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

  test("requires the approved auth file after exact schedule approval", () => {
    const result = runRunner(
      [
        "--native-alias-pilot",
        "--execute",
        "--approved-sessions=96",
        "--approved-max-requests=1152",
        "--approved-max-cost-usd=4",
        ...pilotIdentityArgs(),
      ],
      { BENCHMARK_ACK_COSTS: "yes", BENCHMARK_AUTH_FILE: "", BENCHMARK_PASS_ENV: "" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("exactly one auth source");
  });

  test("never permits dirty-source override for the frozen pilot", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-hashline-pilot-gate-"));
    const authFile = join(root, "auth.json");
    try {
      await writeFile(
        authFile,
        JSON.stringify({
          openai: { type: "oauth", access: "fixture", expires: Date.now() + 60_000 },
          openrouter: { type: "api", key: "fixture" },
        }),
      );
      const result = runRunner(
        [
          "--native-alias-pilot",
          "--execute",
          "--allow-dirty",
          `--auth-file=${authFile}`,
          "--approved-sessions=96",
          "--approved-max-requests=1152",
          "--approved-max-cost-usd=4",
          ...pilotIdentityArgs(),
        ],
        { BENCHMARK_ACK_COSTS: "yes", BENCHMARK_AUTH_FILE: "", BENCHMARK_PASS_ENV: "" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("never permits --allow-dirty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
