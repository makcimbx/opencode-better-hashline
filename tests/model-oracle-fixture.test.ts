import { describe, expect, test } from "bun:test";
import { verifyNativeAliasOracleFixture } from "../benchmarks/model/oracle-fixture.js";

describe("native alias worktree topology", () => {
  test("separates fixture paths from renderer worktree authority", async () => {
    expect(
      await verifyNativeAliasOracleFixture({
        packageVersion: "0.2.1",
        schemaSha256: "a".repeat(64),
        hostVersion: "1.18.3",
      }),
    ).toEqual({
      schemaVersion: 1,
      legacyDecision: "invalid",
      correctedDecision: "valid",
      correctedReason: "valid",
      outsideFixtureDecision: "invalid",
      forgedLocatorDecision: "invalid",
    });
  });
});
