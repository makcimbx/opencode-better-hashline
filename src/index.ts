import type { PluginModule } from "@opencode-ai/plugin";
import { betterHashlinePlugin } from "./plugin.js";

const betterHashline = {
  id: "opencode-better-hashline",
  server: betterHashlinePlugin,
} satisfies PluginModule;

export type { BetterHashlineOptions } from "./options.js";
export { betterHashlinePlugin } from "./plugin.js";
export default betterHashline;
