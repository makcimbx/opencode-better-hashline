import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureBoundedProcess } from "../../src/process-capture.js";
import {
  loadCommittedPilotV7ApprovalAnchor,
  PILOT_V7_APPROVAL_ANCHOR_PATH,
  type PilotV7ApprovalAnchor,
  parsePilotV7ApprovalAnchor,
  validatePilotV7ApprovalCommit,
  validatePilotV7ExternalApprovalBundle,
} from "./approval.js";
import { buildRunnerBundle, readApprovedRunner, type StagedRunner } from "./stage-runner.js";

async function command(command: string[], cwd: string): Promise<string> {
  const result = await captureBoundedProcess({
    command,
    cwd,
    env: { ...process.env },
    timeoutMs: 10 * 60_000,
    stdoutLimit: 16 * 1024 * 1024,
    stderrLimit: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function sourceIdentity(repository: string) {
  const [commit, status, flags] = await Promise.all([
    command(["git", "rev-parse", "HEAD"], repository),
    command(["git", "status", "--porcelain", "--untracked-files=all"], repository),
    command(["git", "ls-files", "-v"], repository),
  ]);
  const hiddenIndexFlags = flags
    .split(/\r?\n/u)
    .filter(Boolean)
    .some((line) => /^[a-zS]/u.test(line));
  return {
    commit: commit.trim(),
    dirty: status.trim().length > 0 || hiddenIndexFlags,
  };
}

async function launch(): Promise<number> {
  const args = process.argv.slice(2);
  const repository = await realpath(resolve(import.meta.dir, "../.."));
  const identity = await sourceIdentity(repository);
  const nativePilot = args.includes("--native-alias-pilot");
  const paid = args.includes("--execute");
  const approvedRunner = option(args, "approved-runner-executable");
  const approvedRunnerSha256 = option(args, "approved-runner-sha256");
  const temporary = await mkdtemp(join(tmpdir(), "better-hashline-runner-"));
  let detached: string | undefined;
  try {
    let runner: StagedRunner;
    if (nativePilot && paid) {
      let anchor: PilotV7ApprovalAnchor;
      try {
        anchor = await loadCommittedPilotV7ApprovalAnchor({
          repository,
          commit: identity.commit,
        });
      } catch (error) {
        if (!identity.dirty) throw error;
        const workingAnchor = parsePilotV7ApprovalAnchor(
          await readFile(join(repository, PILOT_V7_APPROVAL_ANCHOR_PATH)),
        );
        if (workingAnchor.approval !== null) throw error;
        throw new Error("Pilot v7 remains hard-disabled by its committed null approval anchor.");
      }
      if (anchor.approval === null) {
        throw new Error("Pilot v7 remains hard-disabled by its committed null approval anchor.");
      }
      const approvalCommit = await validatePilotV7ApprovalCommit({
        repository,
        approvalCommit: identity.commit,
      });
      const externalApprovalPath = option(args, "external-approval-bundle");
      if (!externalApprovalPath) {
        throw new Error("Paid native-alias execution requires --external-approval-bundle.");
      }
      const externalApprovalBytes = new Uint8Array(await readFile(externalApprovalPath));
      const approval = validatePilotV7ExternalApprovalBundle(externalApprovalBytes, approvalCommit);
      if (!approvedRunner) {
        throw new Error(
          "Paid native-alias execution requires an exact approved runner executable.",
        );
      }
      runner = await readApprovedRunner(
        approvedRunner,
        approval.bundle.hashes.runnerExecutableSha256,
      );
      if (approvedRunnerSha256 && approvedRunnerSha256 !== runner.sha256) {
        throw new Error("--approved-runner-sha256 disagrees with the external approval bundle.");
      }
      const privateApprovalPath = join(temporary, "external-approval.json");
      await writeFile(privateApprovalPath, externalApprovalBytes, { flag: "wx", mode: 0o400 });
      args.push(
        `--staged-approval-commit=${approval.approvalCommit}`,
        `--staged-candidate-commit=${approval.candidateCommit}`,
        `--staged-external-approval=${privateApprovalPath}`,
        `--staged-external-approval-sha256=${approval.externalBundleSha256}`,
      );
    } else if (nativePilot && args.includes("--preflight") && !identity.dirty) {
      detached = join(temporary, "source");
      await command(["git", "worktree", "add", "--detach", detached, identity.commit], repository);
      await command(
        [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
        detached,
      );
      runner = await buildRunnerBundle(detached);
    } else {
      runner = await buildRunnerBundle(repository);
    }

    const executable = join(temporary, "model-runner.mjs");
    await writeFile(executable, runner.bytes, { flag: "wx", mode: 0o500 });
    const child = Bun.spawn(
      [
        process.execPath,
        executable,
        ...args,
        `--staged-repository=${repository}`,
        `--staged-runner-sha256=${runner.sha256}`,
        `--staged-source-commit=${identity.commit}`,
        `--staged-source-dirty=${String(identity.dirty)}`,
      ],
      {
        cwd: repository,
        env: { ...process.env },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return await child.exited;
  } finally {
    if (detached) {
      await command(["git", "worktree", "remove", "--force", detached], repository).catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await launch());
