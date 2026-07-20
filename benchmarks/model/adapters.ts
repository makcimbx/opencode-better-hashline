export type AdapterId = "native" | "better-hashline" | "better-hashline-native-aliases";

export const modelAdapterSets = {
  "native-vs-unique-v1": ["native", "better-hashline"],
  "native-aliases-v1": ["better-hashline", "better-hashline-native-aliases"],
} as const satisfies Record<string, readonly AdapterId[]>;

export type AdapterSetId = keyof typeof modelAdapterSets;

export const nativeAliasPilotV2 = {
  id: "native-alias-pilot-v2",
  paidExecutionApproved: false,
  taskSet: "baseline-v1",
  adapterSet: "native-aliases-v1",
  repeats: 1,
  maxAgentSteps: 12,
  sessionLimit: 96,
  requestLimit: 1_152,
  totalCostLimitUsd: 4,
  perModelCostLimitUsd: 1,
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
} as const;

export function adapterSetManifest(adapterSet: AdapterSetId) {
  return modelAdapterSets[adapterSet].map((adapter) => ({
    adapter,
    config: adapterPluginConfig(adapter, "<packed-artifact>"),
  }));
}

export function verificationSurfaceForAdapterSet(adapterSet: AdapterSetId) {
  return adapterSet === "native-aliases-v1" ? "all" : "hashline";
}

export function adapterPluginConfig(
  adapter: AdapterId,
  packageUrl: string,
): Record<string, unknown> {
  if (adapter === "native") return {};
  if (adapter === "better-hashline") return { plugin: [packageUrl] };
  return {
    plugin: [[packageUrl, { enforce: true, toolSurface: "native-aliases" }]],
  };
}
