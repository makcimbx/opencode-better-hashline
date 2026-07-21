import { describe, expect, test } from "bun:test";
import incident from "../benchmarks/results/2026-07-20-native-alias-pilot-v1-incident.json";
import incidentV3 from "../benchmarks/results/2026-07-21-native-alias-pilot-v3-incident.json";
import incidentV4 from "../benchmarks/results/2026-07-21-native-alias-pilot-v4-incident.json";
import incidentV5 from "../benchmarks/results/2026-07-21-native-alias-pilot-v5-incident.json";
import incidentV6 from "../benchmarks/results/2026-07-21-native-alias-pilot-v6-incident.json";

describe("native alias pilot v1 incident", () => {
  test("publishes a sanitized immutable no-go record", () => {
    expect(incident).toMatchObject({
      schemaVersion: 1,
      pilot: "native-alias-pilot-v1",
      status: "failed",
      classification: "benchmark-oracle false negative",
      releaseDecision: "no-go",
      startedFromCommit: "57376db02bdaa31667df4891ab582f4e089a74da",
      schedule: {
        completedSessions: 1,
        unexecutedSessions: 95,
        accountedRequests: 4,
        accountedCostUsd: 0,
      },
      provenance: {
        journalSha256: "4193d4af41dfc16a34acb8e9bfc84f0a86580d28fa680d24abd1ff83adeefd80",
        artifactSha256: "7d64c817df74516f88faaa7ae1ec57cd16f53fc221ce493454fde404a161cd83",
        authSnapshotSha256: null,
      },
      claims: {
        modelComparison: false,
        releaseEvidence: false,
        safeToResume: false,
      },
    });

    const serialized = JSON.stringify(incident);
    const privatePath =
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu;
    expect("C:Users/makci/file").toMatch(privatePath);
    expect("Users/makci/AppData/Local/Temp/x").toMatch(privatePath);
    expect("c:/users/makci/file").toMatch(privatePath);
    expect("\\\\server\\share\\file").toMatch(privatePath);
    expect(serialized).not.toMatch(privatePath);
    expect(serialized).not.toMatch(
      /"(?:access|refresh|key|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/iu,
    );
    expect(serialized).not.toContain("sanitizedSessionExportStderrSha256");
  });
});

describe("native alias pilot v3 incident", () => {
  test("publishes a sanitized immutable consumed no-go record", () => {
    expect(incidentV3).toMatchObject({
      schemaVersion: 1,
      pilotId: "native-alias-pilot-v3",
      status: "failed",
      completedSessions: 1,
      modelRequestsObserved: 5,
      reportedCostUsd: 0,
      accountingComplete: false,
      accountedRequestsUpperBound: 17,
      accountedCostUpperBoundUsd: null,
      fileMutationObserved: false,
      reservationConsumed: true,
      retryForbidden: true,
      safeToResume: false,
      rootCauseCode: "native-alias-current-call-correlation-mismatch",
    });
    expect(JSON.stringify(incidentV3)).not.toMatch(
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu,
    );
  });
});

describe("native alias pilot v4 incident", () => {
  test("publishes a sanitized immutable consumed benchmark no-go record", () => {
    expect(incidentV4).toMatchObject({
      schemaVersion: 1,
      pilotId: "native-alias-pilot-v4",
      accounting: {
        observedRequests: 8,
        reportedCostUsd: 0,
        accountingComplete: false,
        accountedRequestsUpperBound: 20,
        accountedCostUpperBoundUsd: null,
      },
      reservation: {
        consumed: true,
        retryForbidden: true,
        safeToResume: false,
      },
      rootCause: {
        code: "baseline-trace-missing-path-authority",
        runtimeDefect: false,
        unsafeMutation: false,
      },
      schedule: {
        completedSessions: 2,
        plannedSessions: 72,
      },
      sessionResults: {
        firstNativeAliasSessionPassed: true,
        secondExactFilesPassed: true,
      },
      terminal: {
        status: "failed",
        releaseDecision: "no-go",
        safeToResume: false,
      },
    });
    expect(incidentV4.sessionResults.secondBaselineAdapterIntegrityPassed).toBe(false);
    expect(JSON.stringify(incidentV4)).not.toMatch(
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu,
    );
    expect(JSON.stringify(incidentV4)).not.toMatch(
      /"(?:access|refresh|key|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/iu,
    );
  });
});

describe("native alias pilot v5 incident", () => {
  test("publishes a sanitized immutable consumed fixture no-go record", () => {
    expect(incidentV5).toMatchObject({
      schemaVersion: 1,
      pilotId: "native-alias-pilot-v5",
      accounting: {
        observedRequests: 70,
        reportedCostUsd: 0,
        accountingComplete: false,
        accountedRequestsUpperBound: 82,
        accountedCostUpperBoundUsd: null,
      },
      reservation: {
        consumed: true,
        retryForbidden: true,
        safeToResume: false,
      },
      rootCause: {
        code: "create-file-fixture-missing-parent-directory",
        benchmarkDefect: true,
        runtimeDefect: false,
        unsafeMutation: false,
      },
      schedule: {
        completedSessions: 17,
        passedSessions: 16,
        plannedSessions: 48,
      },
      sessionResults: {
        firstSixteenSessionsPassed: true,
        failedProcessPassed: true,
        failedTransportPassed: true,
        failedExactFilesPassed: false,
        failedHashlineWriteErrorCode: "PATH_NOT_FOUND",
      },
      terminal: {
        status: "failed",
        releaseDecision: "no-go",
        safeToResume: false,
      },
    });
    const serialized = JSON.stringify(incidentV5);
    expect(serialized).not.toMatch(
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu,
    );
    expect(serialized).not.toMatch(
      /"(?:access|refresh|key|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/iu,
    );
  });
});

describe("native alias pilot v6 incident", () => {
  test("publishes a sanitized immutable consumed multi-file ledger no-go record", () => {
    expect(incidentV6).toMatchObject({
      schemaVersion: 1,
      pilotId: "native-alias-pilot-v6",
      accounting: {
        observedRequests: 97,
        reportedCostUsd: 0,
        accountingComplete: false,
        accountedRequestsUpperBound: 109,
        accountedCostUpperBoundUsd: null,
      },
      reservation: {
        consumed: true,
        retryForbidden: true,
        safeToResume: false,
      },
      rootCause: {
        code: "multifile-ledger-cleared-unrelated-snapshots",
        benchmarkDefect: true,
        runtimeDefect: false,
        unsafeMutation: false,
      },
      schedule: {
        completedSessions: 23,
        passedSessions: 22,
        plannedSessions: 48,
      },
      sessionResults: {
        firstTwentyTwoSessionsPassed: true,
        failedProcessPassed: true,
        failedTransportPassed: true,
        failedExactFilesPassed: true,
        failedAdapterIntegrityPassed: false,
      },
      terminal: {
        status: "failed",
        releaseDecision: "no-go",
        safeToResume: false,
      },
    });
    const serialized = JSON.stringify(incidentV6);
    expect(serialized).not.toMatch(
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu,
    );
    expect(serialized).not.toMatch(
      /"(?:access|refresh|key|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/iu,
    );
  });
});
