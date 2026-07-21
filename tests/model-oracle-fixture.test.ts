import { describe, expect, test } from "bun:test";
import { verifyNativeAliasOracleFixture } from "../benchmarks/model/oracle-fixture.js";

describe("native alias pilot v1 topology", () => {
  test("reproduces the normalized topology decision without replaying the private trace", async () => {
    expect(
      await verifyNativeAliasOracleFixture({
        packageVersion: "0.2.1",
        schemaSha256: "a".repeat(64),
        hostVersion: "1.18.3",
      }),
    ).toEqual({
      schemaVersion: 1,
      declaredSourceTraceSha256: "c4805f9c0644a9eb4b7050e892ba07c9800fb278ebebb27f3dd93a4e7dfbf49f",
      legacyDecision: "invalid",
      correctedDecision: "valid",
      correctedReason: "valid",
      outsideFixtureDecision: "invalid",
      forgedLocatorDecision: "invalid",
    });
  });
});
