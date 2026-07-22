import { describe, expect, test } from "bun:test";
import pilotV7 from "../benchmarks/results/2026-07-21-native-alias-pilot-v7.json";

describe("native alias pilot v7 result", () => {
  test("publishes a privacy-safe completed technical-gate summary", () => {
    expect(pilotV7).toMatchObject({
      schemaVersion: 1,
      pilot: "native-alias-pilot-v7",
      status: "completed",
      candidateCommit: "6a2a03629b826940675a96a908a0cd2b2ca94059",
      approvalCommit: "03f4a081460ed3de47d17a80f735d46ee16f37d8",
      schedule: {
        scheduledSessions: 48,
        completedSessions: 48,
        passedSessions: 48,
        failedSessions: 0,
        observedRequests: 181,
        reportedCostUsd: 0,
        accountingComplete: true,
      },
      adapters: {
        "better-hashline": {
          sessions: 24,
          passed: 24,
          retries: 0,
        },
        "better-hashline-native-aliases": {
          sessions: 24,
          passed: 24,
          retries: 0,
        },
      },
      claims: {
        technicalPilotPassed: true,
        modelSuperiority: false,
        releaseAuthorized: true,
        releaseDecision: "approved-experimental",
        rawEvidencePublished: false,
      },
    });
    const serialized = JSON.stringify(pilotV7);
    expect(serialized).not.toMatch(
      /[a-z]:(?:[\\/]|Users[\\/])|(?:^|["\\/])Users[\\/]|[\\/]home[\\/]|\\\\[^\\/]+[\\/]/iu,
    );
    expect(serialized).not.toMatch(
      /"(?:access|refresh|key|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/iu,
    );
  });
});
