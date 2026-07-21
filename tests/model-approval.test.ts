import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrokerInvocation,
  type BrokerInvoker,
  consumeExternalReservation,
  type GitRunner,
  PILOT_V5_ADAPTER_MANIFEST_SHA256,
  PILOT_V5_APPROVAL_ANCHOR_PATH,
  PILOT_V5_ID,
  PILOT_V5_LIMITS,
  PILOT_V5_OUTPUT_RELATIVE_PATH,
  PILOT_V5_PACKAGE_VERSION,
  PILOT_V5_PREFLIGHT_SCHEMA_VERSION,
  PILOT_V5_RESERVATION_ID,
  PILOT_V5_RESERVATION_KEY,
  PILOT_V5_RESERVATION_NAMESPACE,
  PILOT_V5_RESERVATION_PROTOCOL,
  PILOT_V5_SCHEDULE_MANIFEST_SHA256,
  PILOT_V5_TASK_MANIFEST_SHA256,
  type PilotV5ApprovalAnchor,
  type PilotV5ExternalApprovalBundle,
  parsePilotV5ApprovalAnchor,
  parsePilotV5ExternalApprovalBundle,
  validatePilotV5ApprovalCommit,
} from "../benchmarks/model/approval.js";
import type { BoundedProcessResult } from "../benchmarks/model/process.js";
import { canonicalJson } from "../src/presentation.js";

const CANDIDATE = "a".repeat(40);
const APPROVAL_COMMIT = "c".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function nullAnchor(): PilotV5ApprovalAnchor {
  return { schemaVersion: 1, pilotId: PILOT_V5_ID, approval: null };
}

function activeAnchor(
  candidateCommit: string,
  externalBundleBytes: Uint8Array,
): PilotV5ApprovalAnchor {
  return {
    schemaVersion: 1,
    pilotId: PILOT_V5_ID,
    approval: {
      candidateCommit,
      externalBundleSha256: digest(externalBundleBytes),
    },
  };
}

function anchorBytes(anchor: PilotV5ApprovalAnchor): Buffer {
  if (anchor.approval === null) {
    return Buffer.from(
      `{ "approval": null, "pilotId": "${PILOT_V5_ID}", "schemaVersion": 1 }\n`,
      "utf8",
    );
  }
  return Buffer.from(`{
  "approval": {
    "candidateCommit": "${anchor.approval.candidateCommit}",
    "externalBundleSha256": "${anchor.approval.externalBundleSha256}"
  },
  "pilotId": "${PILOT_V5_ID}",
  "schemaVersion": 1
}\n`);
}

function externalBundle(brokerExecutableSha256: string): PilotV5ExternalApprovalBundle {
  return {
    schemaVersion: 1,
    pilotId: PILOT_V5_ID,
    candidateCommit: CANDIDATE,
    packageVersion: PILOT_V5_PACKAGE_VERSION,
    preflightSchemaVersion: PILOT_V5_PREFLIGHT_SCHEMA_VERSION,
    hashes: {
      preflightReceiptSha256: "1".repeat(64),
      runnerExecutableSha256: "2".repeat(64),
      rootLockfileSha256: "3".repeat(64),
      tarballSha256: "4".repeat(64),
      packageTreeSha256: "5".repeat(64),
      toolchainSha256: "6".repeat(64),
      scheduleManifestSha256: PILOT_V5_SCHEDULE_MANIFEST_SHA256,
      taskManifestSha256: PILOT_V5_TASK_MANIFEST_SHA256,
      adapterManifestSha256: PILOT_V5_ADAPTER_MANIFEST_SHA256,
      authFileSha256: "7".repeat(64),
      authIdentitySha256: "d".repeat(64),
      endpointAttestationSha256: "8".repeat(64),
      budgetAttestationSha256: "9".repeat(64),
      userApprovalSha256: "b".repeat(64),
      brokerExecutableSha256,
    },
    outputRelativePath: PILOT_V5_OUTPUT_RELATIVE_PATH,
    limits: { ...PILOT_V5_LIMITS },
    reservation: {
      protocol: PILOT_V5_RESERVATION_PROTOCOL,
      namespace: PILOT_V5_RESERVATION_NAMESPACE,
      key: PILOT_V5_RESERVATION_KEY,
      authority: "durable-reservation-authority-v1",
    },
  };
}

interface FakeGitOptions {
  currentAnchor: PilotV5ApprovalAnchor;
  parentAnchor?: PilotV5ApprovalAnchor;
  head?: string;
  status?: string;
  lineage?: readonly string[];
  changedPaths?: readonly string[];
  indexFlags?: string;
}

function fakeGit(options: FakeGitOptions): GitRunner {
  return ({ args }) => {
    if (args[0] === "rev-parse") return `${options.head ?? APPROVAL_COMMIT}\n`;
    if (args[0] === "status") return options.status ?? "";
    if (args[0] === "ls-files") return options.indexFlags ?? "H tracked.ts\n";
    if (args[0] === "rev-list") {
      return `${(options.lineage ?? [APPROVAL_COMMIT, CANDIDATE]).join(" ")}\n`;
    }
    if (args[0] === "diff") {
      return `${(options.changedPaths ?? [`M\t${PILOT_V5_APPROVAL_ANCHOR_PATH}`]).join("\n")}\n`;
    }
    if (args[0] === "show") {
      if (args[1] === `${APPROVAL_COMMIT}:${PILOT_V5_APPROVAL_ANCHOR_PATH}`) {
        return anchorBytes(options.currentAnchor);
      }
      if (args[1] === `${CANDIDATE}:${PILOT_V5_APPROVAL_ANCHOR_PATH}`) {
        return anchorBytes(options.parentAnchor ?? nullAnchor());
      }
    }
    throw new Error(`Unexpected fake git invocation: ${args.join(" ")}`);
  };
}

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "better-hashline-approval-repository-"));
  const externalParent = await mkdtemp(join(tmpdir(), "better-hashline-approval-external-"));
  const externalRoot = join(externalParent, "actual");
  const externalAlias = join(externalParent, "alias");
  await mkdir(externalRoot);
  await symlink(externalRoot, externalAlias, "junction");
  temporaryRoots.push(repository, externalParent);
  const brokerPath = join(externalAlias, "reservation-broker.bin");
  const brokerBytes = Buffer.from("hash-approved standalone broker", "utf8");
  await writeFile(brokerPath, brokerBytes);
  const bundle = externalBundle(digest(brokerBytes));
  const bundleBytes = canonicalBytes(bundle);
  return {
    repository,
    brokerPath,
    bundle,
    bundleBytes,
    runGit: fakeGit({ currentAnchor: activeAnchor(CANDIDATE, bundleBytes) }),
  };
}

function processResult(stdout: string, overrides: Partial<BoundedProcessResult> = {}) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: 0,
    stdoutOverflow: false,
    stderrOverflow: false,
    ...overrides,
  } satisfies BoundedProcessResult;
}

function successfulBroker(invocations: BrokerInvocation[]): BrokerInvoker {
  return async (invocation) => {
    invocations.push(invocation);
    const request = JSON.parse(invocation.command[1]) as Record<string, unknown>;
    expect(canonicalJson(request)).toBe(invocation.command[1]);
    const response = canonicalBytes({
      schemaVersion: 1,
      status: "reserved",
      protocol: PILOT_V5_RESERVATION_PROTOCOL,
      namespace: PILOT_V5_RESERVATION_NAMESPACE,
      key: PILOT_V5_RESERVATION_KEY,
      reservationId: PILOT_V5_RESERVATION_ID,
      authority: request.authority,
      requestSha256: digest(invocation.command[1]),
      signature: "opaque-authority-signature",
    }).toString("utf8");
    return processResult(response);
  };
}

describe("pilot v5 external approval", () => {
  test("freezes the exact v5 identity, evidence hashes, and execution limits", () => {
    expect(PILOT_V5_ID).toBe("native-alias-pilot-v5");
    expect(PILOT_V5_APPROVAL_ANCHOR_PATH).toBe(
      "benchmarks/model/native-alias-pilot-v5.approval.json",
    );
    expect(PILOT_V5_OUTPUT_RELATIVE_PATH).toBe("benchmarks/results/model/native-alias-pilot-v5");
    expect(PILOT_V5_PACKAGE_VERSION).toBe("0.2.1");
    expect(PILOT_V5_PREFLIGHT_SCHEMA_VERSION).toBe(6);
    expect(PILOT_V5_TASK_MANIFEST_SHA256).toBe(
      "8a5ed7c8169bacf135c68037ea1717c980dd47c7141f03d723ba6ef578d9cb1a",
    );
    expect(PILOT_V5_ADAPTER_MANIFEST_SHA256).toBe(
      "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8",
    );
    expect(PILOT_V5_SCHEDULE_MANIFEST_SHA256).toBe(
      "3b694becb988e6fcd1dace046ad45e298cdc4f4600d512ab54e3bb8a3cfdb70d",
    );
    expect(PILOT_V5_LIMITS).toEqual({
      repeats: 1,
      maxAgentSteps: 12,
      sessionTimeoutMs: 300_000,
      requestedOutputTokenLimit: 2_048,
      traceByteLimit: 8_388_608,
      sessionLimit: 48,
      requestLimit: 576,
      totalCostStopThresholdUsd: 4,
      perModelCostStopThresholdUsd: 1,
    });
    expect(PILOT_V5_RESERVATION_NAMESPACE).toBe("io.github.makcimbx.opencode-better-hashline");
    expect(PILOT_V5_RESERVATION_KEY).toBe("native-alias-pilot-v5");
    expect(PILOT_V5_RESERVATION_ID).toBe(
      "io.github.makcimbx.opencode-better-hashline/native-alias-pilot-v5",
    );
  });

  test("ships the exact canonical null approval anchor", async () => {
    const anchor = parsePilotV5ApprovalAnchor(await readFile(PILOT_V5_APPROVAL_ANCHOR_PATH));
    expect(anchor.approval).toBeNull();
  });

  test("keeps the committed null anchor hard-disabled before broker access", async () => {
    const repository = await mkdtemp(join(tmpdir(), "better-hashline-approval-null-"));
    temporaryRoots.push(repository);
    let brokerInvocations = 0;
    await expect(
      consumeExternalReservation(
        {
          repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: Buffer.from("not a bundle"),
          brokerPath: join(repository, "missing-broker"),
          repositoryAndWorktreeRoots: [],
        },
        {
          runGit: fakeGit({ currentAnchor: nullAnchor() }),
          invokeBroker: async () => {
            brokerInvocations += 1;
            return processResult("");
          },
        },
      ),
    ).rejects.toThrow("hard-disabled");
    expect(brokerInvocations).toBe(0);
  });

  test("requires clean single-parent C and an A-to-C anchor-only activation", async () => {
    const currentAnchor = activeAnchor(CANDIDATE, Buffer.from("bundle"));
    for (const runGit of [
      fakeGit({ currentAnchor, status: " M benchmarks/model/run.ts\n" }),
      fakeGit({ currentAnchor, lineage: [APPROVAL_COMMIT, CANDIDATE, OTHER_COMMIT] }),
      fakeGit({ currentAnchor, indexFlags: "S hidden.ts\n" }),
      fakeGit({
        currentAnchor,
        changedPaths: [`M\t${PILOT_V5_APPROVAL_ANCHOR_PATH}`, "M\tbenchmarks/model/run.ts"],
      }),
      fakeGit({
        currentAnchor: activeAnchor(OTHER_COMMIT, Buffer.from("bundle")),
      }),
      fakeGit({ currentAnchor, parentAnchor: currentAnchor }),
    ]) {
      await expect(
        validatePilotV5ApprovalCommit(
          { repository: process.cwd(), approvalCommit: APPROVAL_COMMIT },
          { runGit },
        ),
      ).rejects.toThrow();
    }
  });

  test("rejects noncanonical bundles, bad anchor hashes, frozen limits, and broker hashes", async () => {
    const first = await fixture();
    expect(() =>
      parsePilotV5ExternalApprovalBundle(
        Buffer.from(`${JSON.stringify({ ...first.bundle, unexpected: true })}\n`, "utf8"),
      ),
    ).toThrow();

    let brokerInvocations = 0;
    const neverBroker: BrokerInvoker = async () => {
      brokerInvocations += 1;
      return processResult("");
    };
    await expect(
      consumeExternalReservation(
        {
          repository: first.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: first.bundleBytes,
          brokerPath: first.brokerPath,
          repositoryAndWorktreeRoots: [],
        },
        {
          runGit: fakeGit({
            currentAnchor: {
              schemaVersion: 1,
              pilotId: PILOT_V5_ID,
              approval: {
                candidateCommit: CANDIDATE,
                externalBundleSha256: "f".repeat(64),
              },
            },
          }),
          invokeBroker: neverBroker,
        },
      ),
    ).rejects.toThrow("bundle hash");

    const second = await fixture();
    const badLimits = {
      ...second.bundle,
      limits: { ...second.bundle.limits, sessionLimit: 71 },
    };
    const badLimitBytes = canonicalBytes(badLimits);
    await expect(
      consumeExternalReservation(
        {
          repository: second.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: badLimitBytes,
          brokerPath: second.brokerPath,
          repositoryAndWorktreeRoots: [],
        },
        {
          runGit: fakeGit({ currentAnchor: activeAnchor(CANDIDATE, badLimitBytes) }),
          invokeBroker: neverBroker,
        },
      ),
    ).rejects.toThrow("frozen exact-key schema");

    const third = await fixture();
    await writeFile(third.brokerPath, "substituted broker");
    await expect(
      consumeExternalReservation(
        {
          repository: third.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: third.bundleBytes,
          brokerPath: third.brokerPath,
          repositoryAndWorktreeRoots: [],
        },
        { runGit: third.runGit, invokeBroker: neverBroker },
      ),
    ).rejects.toThrow("broker hash");

    const insideRepositoryBroker = join(first.repository, "reservation-broker.bin");
    await writeFile(insideRepositoryBroker, "hash-approved standalone broker");
    await expect(
      consumeExternalReservation(
        {
          repository: first.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: first.bundleBytes,
          brokerPath: insideRepositoryBroker,
          repositoryAndWorktreeRoots: [],
        },
        { runGit: first.runGit, invokeBroker: neverBroker },
      ),
    ).rejects.toThrow("outside every repository");

    const independentRepository = await mkdtemp(
      join(tmpdir(), "better-hashline-approval-independent-repository-"),
    );
    temporaryRoots.push(independentRepository);
    await mkdir(join(independentRepository, ".git"));
    const independentRepositoryBroker = join(independentRepository, "reservation-broker.bin");
    await writeFile(independentRepositoryBroker, "hash-approved standalone broker");
    await expect(
      consumeExternalReservation(
        {
          repository: first.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: first.bundleBytes,
          brokerPath: independentRepositoryBroker,
          repositoryAndWorktreeRoots: [],
        },
        { runGit: first.runGit, invokeBroker: neverBroker },
      ),
    ).rejects.toThrow("outside every repository");
    expect(brokerInvocations).toBe(0);
  });

  test("rejects a malformed broker response without retrying", async () => {
    const testFixture = await fixture();
    let brokerInvocations = 0;
    await expect(
      consumeExternalReservation(
        {
          repository: testFixture.repository,
          approvalCommit: APPROVAL_COMMIT,
          externalBundleBytes: testFixture.bundleBytes,
          brokerPath: testFixture.brokerPath,
          repositoryAndWorktreeRoots: [],
        },
        {
          runGit: testFixture.runGit,
          invokeBroker: async () => {
            brokerInvocations += 1;
            return processResult(canonicalBytes({ status: "reserved" }).toString("utf8"));
          },
        },
      ),
    ).rejects.toThrow("invalid signed response");
    expect(brokerInvocations).toBe(1);
  });

  test("accepts one exact reservation and propagates the second refusal without retry or release", async () => {
    const testFixture = await fixture();
    const invocations: BrokerInvocation[] = [];
    const success = successfulBroker(invocations);
    const invokeBroker: BrokerInvoker = async (invocation) => {
      if (invocations.length === 0) return success(invocation);
      invocations.push(invocation);
      return processResult("", {
        exitCode: 73,
        stderr: "already reserved",
        stderrBytes: Buffer.byteLength("already reserved"),
      });
    };
    const input = {
      repository: testFixture.repository,
      approvalCommit: APPROVAL_COMMIT,
      externalBundleBytes: testFixture.bundleBytes,
      brokerPath: testFixture.brokerPath,
      repositoryAndWorktreeRoots: [],
    } as const;

    const receipt = await consumeExternalReservation(input, {
      runGit: testFixture.runGit,
      invokeBroker,
    });
    expect(receipt.reservationId).toBe(PILOT_V5_RESERVATION_ID);
    await expect(
      consumeExternalReservation(input, { runGit: testFixture.runGit, invokeBroker }),
    ).rejects.toThrow("no retry or release");
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.command[1]).toBe(invocations[1]?.command[1]);
    expect(
      invocations.every((invocation) => JSON.parse(invocation.command[1]).operation === "consume"),
    ).toBe(true);
  });
});
