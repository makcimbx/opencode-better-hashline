import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  adapterPluginConfig,
  adapterSetManifest,
  modelAdapterSets,
  nativeAliasPilotV5,
  pilotProviderConfig,
  verificationSurfaceForAdapterSet,
} from "../benchmarks/model/adapters.js";
import { modelTaskSets } from "../benchmarks/model/tasks.js";

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("model benchmark adapters", () => {
  test("keeps the released native-versus-unique set as the default-compatible pair", () => {
    expect(modelAdapterSets["native-vs-unique-v1"]).toEqual(["native", "better-hashline"]);
    expect(verificationSurfaceForAdapterSet("native-vs-unique-v1")).toBe("hashline");
    expect(adapterPluginConfig("native", "file:///package")).toEqual({});
    expect(adapterPluginConfig("better-hashline", "file:///package")).toEqual({
      plugin: ["file:///package"],
    });
  });

  test("defines an explicit unique-versus-native-alias pilot pair", () => {
    expect(modelAdapterSets["native-aliases-v1"]).toEqual([
      "better-hashline",
      "better-hashline-native-aliases",
    ]);
    expect(verificationSurfaceForAdapterSet("native-aliases-v1")).toBe("all");
    expect(adapterPluginConfig("better-hashline-native-aliases", "file:///package")).toEqual({
      plugin: [["file:///package", { enforce: true, toolSurface: "native-aliases" }]],
    });
  });

  test("freezes the unapproved 48-session native alias pilot-v5 proposal", () => {
    expect(nativeAliasPilotV5).toEqual({
      id: "native-alias-pilot-v5",
      approvalAnchorPath: "benchmarks/model/native-alias-pilot-v5.approval.json",
      approvalRequirements: {
        externalBudgetReceipt: true,
        providerEndpointAttestation: true,
        exactPreflightReceipt: true,
        durablePilotReservation: true,
      },
      taskSet: "baseline-v1",
      adapterSet: "native-aliases-v1",
      repeats: 1,
      maxAgentSteps: 12,
      sessionTimeoutMs: 300000,
      requestedOutputTokenLimit: 2048,
      requiredBunVersion: "1.3.14",
      requiredNpmVersion: "11.18.0",
      requiredOpenCodeVersion: "1.18.3",
      traceByteLimit: 8388608,
      sessionLimit: 48,
      requestLimit: 576,
      totalCostLimitUsd: 4,
      perModelCostLimitUsd: 1,
      taskManifestSha256: "8a5ed7c8169bacf135c68037ea1717c980dd47c7141f03d723ba6ef578d9cb1a",
      adapterManifestSha256: "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8",
      scheduleManifestSha256: "3b694becb988e6fcd1dace046ad45e298cdc4f4600d512ab54e3bb8a3cfdb70d",
      models: [
        { model: "openai/gpt-5.6-luna", variant: "medium", credential: "oauth" },
        { model: "openai/gpt-5.6-sol", variant: "medium", credential: "oauth" },
      ],
    });
    expect(sha256(modelTaskSets["baseline-v1"])).toBe(nativeAliasPilotV5.taskManifestSha256);
    expect(sha256(adapterSetManifest("native-aliases-v1"))).toBe(
      nativeAliasPilotV5.adapterManifestSha256,
    );
  });

  test("disables OpenRouter fallback for the proposed pilot", () => {
    expect(pilotProviderConfig("openai/gpt-5.6-sol")).toEqual({});
    expect(pilotProviderConfig("openrouter/nvidia/model:free")).toEqual({
      provider: {
        openrouter: {
          models: {
            "nvidia/model:free": {
              options: { provider: { order: ["nvidia"], allow_fallbacks: false } },
            },
          },
        },
      },
    });
    expect(() => pilotProviderConfig("other/model")).toThrow();
  });
});
