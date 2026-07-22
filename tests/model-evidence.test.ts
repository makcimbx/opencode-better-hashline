import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalAccounting,
  journalFailure,
  modelEvidenceSourceStatus,
  reservePilotOutput,
  terminalDecision,
  writeJsonAtomic,
} from "../benchmarks/model/evidence.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("model evidence durability", () => {
  test("never labels development probes as publishable", () => {
    expect(modelEvidenceSourceStatus(false, false)).toEqual({
      sourceDirty: false,
      publishable: true,
    });
    expect(modelEvidenceSourceStatus(true, false)).toEqual({
      sourceDirty: true,
      publishable: false,
    });
    expect(modelEvidenceSourceStatus(false, true)).toEqual({
      sourceDirty: false,
      publishable: false,
    });
  });

  test("confines pilot output without claiming an in-repository reservation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "better-hashline-evidence-"));
    temporaryRoots.push(repository);
    const root = join(repository, "benchmarks", "results", "model");
    await reservePilotOutput(join(root, "first"), root, repository);
    await reservePilotOutput(join(root, "second"), root, repository);
    await expect(access(join(root, ".native-alias-pilot-v7.reservation.json"))).rejects.toThrow();
  });

  test("rejects unsafe roots and occupied output paths", async () => {
    const repository = await mkdtemp(join(tmpdir(), "better-hashline-evidence-"));
    temporaryRoots.push(repository);
    const root = join(repository, "benchmarks", "results", "model");
    await expect(reservePilotOutput(join(root, "nested", "run"), root, repository)).rejects.toThrow(
      "direct child",
    );
    const outsideRoot = join(repository, "..", `outside-${Date.now()}`);
    await expect(
      reservePilotOutput(join(outsideRoot, "run"), outsideRoot, repository),
    ).rejects.toThrow("inside the repository");

    const blockedRepository = await mkdtemp(join(tmpdir(), "better-hashline-evidence-blocked-"));
    temporaryRoots.push(blockedRepository);
    await writeFile(join(blockedRepository, "benchmarks"), "not a directory");
    const blockedRoot = join(blockedRepository, "benchmarks", "results", "model");
    await expect(
      reservePilotOutput(join(blockedRoot, "run"), blockedRoot, blockedRepository),
    ).rejects.toThrow("plain directory");

    await mkdir(root, { recursive: true });
    const occupied = join(root, "occupied");
    await mkdir(occupied);
    await expect(reservePilotOutput(occupied, root, repository)).rejects.toThrow("already exists");
  });

  test("writes JSON atomically and fails closed for an unavailable parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "better-hashline-journal-"));
    temporaryRoots.push(root);
    const journal = join(root, "journal.json");
    await writeJsonAtomic(journal, { status: "failed" });
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual({ status: "failed" });

    await expect(writeJsonAtomic(join(root, "missing", "journal.json"), {})).rejects.toThrow();
  });

  test("bounds active accounting and hashes private failures", () => {
    expect(journalAccounting([{ modelRequests: 4, accountedCost: 0.25 }], null, 12)).toEqual({
      accountedRequests: 4,
      accountedCostUsd: 0.25,
      accountingComplete: true,
      accountedRequestsUpperBound: 4,
      accountedCostUpperBoundUsd: 0.25,
    });
    expect(journalAccounting([{ modelRequests: 4, accountedCost: 0.25 }], {}, 12)).toEqual({
      accountedRequests: 4,
      accountedCostUsd: 0.25,
      accountingComplete: false,
      accountedRequestsUpperBound: 16,
      accountedCostUpperBoundUsd: null,
    });

    const failure = journalFailure(new Error("private C:\\Users\\name\\auth.json"));
    expect(failure).toEqual({
      name: "Error",
      detailSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(terminalDecision("failed")).toEqual({ releaseDecision: "no-go", safeToResume: false });
    expect(terminalDecision("completed")).toBeNull();
  });
});
