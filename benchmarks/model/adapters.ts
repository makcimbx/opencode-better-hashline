export type AdapterId = "native" | "better-hashline" | "better-hashline-native-aliases";

export const modelAdapterSets = {
  "native-vs-unique-v1": ["native", "better-hashline"],
  "native-aliases-v1": ["better-hashline", "better-hashline-native-aliases"],
  "native-alias-probe-v1": ["better-hashline-native-aliases"],
} as const satisfies Record<string, readonly AdapterId[]>;

export type AdapterSetId = keyof typeof modelAdapterSets;

export const nativeAliasPilotV6 = {
  id: "native-alias-pilot-v6",
  approvalAnchorPath: "benchmarks/model/native-alias-pilot-v6.approval.json",
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
  sessionLimit: 48,
  requestLimit: 576,
  totalReportedCostUsd: 4,
  perModelReportedCostUsd: 1,
  taskManifestSha256: "5465f2c98800241ec031375ee11d72f30b8649c00c8196359ba1b6dd39cef3ca",
  adapterManifestSha256: "cdd7ed43f920aeb7d883445095cdf2930372fc76ab9e52ec3ac122784eb8ccb8",
  scheduleManifestSha256: "3b694becb988e6fcd1dace046ad45e298cdc4f4600d512ab54e3bb8a3cfdb70d",
  models: [
    { model: "openai/gpt-5.6-luna", variant: "medium", credential: "oauth" },
    { model: "openai/gpt-5.6-sol", variant: "medium", credential: "oauth" },
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
