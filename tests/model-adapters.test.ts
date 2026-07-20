import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  adapterPluginConfig,
  adapterSetManifest,
  modelAdapterSets,
  nativeAliasPilotV1,
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

  test("freezes the approved 96-session native alias pilot", () => {
    expect(nativeAliasPilotV1).toEqual({
      id: "native-alias-pilot-v1",
      taskSet: "baseline-v1",
      adapterSet: "native-aliases-v1",
      repeats: 1,
      maxAgentSteps: 12,
      approvedSessions: 96,
      approvedMaxRequests: 1152,
      approvedMaxCostUsd: 4,
      approvedMaxCostPerModelUsd: 1,
      taskManifestSha256: "8a5ed7c8169bacf135c68037ea1717c980dd47c7141f03d723ba6ef578d9cb1a",
      adapterManifestSha256: "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8",
      scheduleManifestSha256: "488392f98a0a130642f1a171c8df315ca1a54014ec750ad898c62dbc61b0a75c",
      models: [
        { model: "openai/gpt-5.6-luna", variant: "medium", credential: "oauth" },
        { model: "openai/gpt-5.6-sol", variant: "medium", credential: "oauth" },
        {
          model: "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
          credential: "api",
        },
        {
          model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
          credential: "api",
        },
      ],
    });
    expect(sha256(modelTaskSets["baseline-v1"])).toBe(nativeAliasPilotV1.taskManifestSha256);
    expect(sha256(adapterSetManifest("native-aliases-v1"))).toBe(
      nativeAliasPilotV1.adapterManifestSha256,
    );
  });
});
