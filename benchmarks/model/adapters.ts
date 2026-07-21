export type AdapterId = "native" | "better-hashline" | "better-hashline-native-aliases";

export const modelAdapterSets = {
  "native-vs-unique-v1": ["native", "better-hashline"],
  "native-aliases-v1": ["better-hashline", "better-hashline-native-aliases"],
  "native-alias-probe-v1": ["better-hashline-native-aliases"],
} as const satisfies Record<string, readonly AdapterId[]>;

export type AdapterSetId = keyof typeof modelAdapterSets;

export const nativeAliasPilotV4 = {
  id: "native-alias-pilot-v4",
  approvalAnchorPath: "benchmarks/model/native-alias-pilot-v4.approval.json",
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
  sessionTimeoutMs: 5 * 60_000,
  requestedOutputTokenLimit: 2_048,
  requiredBunVersion: "1.3.14",
  requiredNpmVersion: "11.18.0",
  requiredOpenCodeVersion: "1.18.3",
  traceByteLimit: 8 * 1024 * 1024,
  sessionLimit: 72,
  requestLimit: 864,
  totalCostLimitUsd: 4,
  perModelCostLimitUsd: 1,
  taskManifestSha256: "8a5ed7c8169bacf135c68037ea1717c980dd47c7141f03d723ba6ef578d9cb1a",
  adapterManifestSha256: "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8",
  scheduleManifestSha256: "52d9b778c89f2b05619c013d718a4d7522a2aef5971ecf412b798946e3847bd0",
  models: [
    { model: "openai/gpt-5.6-luna", variant: "medium", credential: "oauth" },
    { model: "openai/gpt-5.6-sol", variant: "medium", credential: "oauth" },
    {
      model: "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
      credential: "api",
      endpoint: { providerOrder: ["nvidia"], allowFallbacks: false },
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

export function pilotProviderConfig(model: string): Record<string, unknown> {
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  const modelID = model.slice(separator + 1);
  if (provider === "openai") return {};
  if (provider !== "openrouter" || !modelID) {
    throw new Error(`Unsupported native-alias pilot provider model: ${model}`);
  }
  return {
    provider: {
      openrouter: {
        models: {
          [modelID]: {
            options: {
              provider: { order: ["nvidia"], allow_fallbacks: false },
            },
          },
        },
      },
    },
  };
}
