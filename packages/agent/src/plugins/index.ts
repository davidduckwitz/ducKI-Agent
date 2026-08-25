import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginsRoot, readDisabledState } from "./plugin-registry.js";

export {
  loadPlugins,
  listPluginSkillDirs,
  readDisabledState,
  pluginsRoot,
  type PluginLoadResult,
  type LoadedPluginInfo,
  type PluginToolContext,
  type LoadedPluginLLMProvider,
  type PluginLLMProviderConfig,
} from "./plugin-registry.js";
export {
  createAgentCapabilities,
  type AgentCapabilities,
  type AgentImageInput,
  type AgentVideoAnalysisResult,
  type PluginBrowserCapabilities,
  type PluginBrowserFrame,
  type PluginBrowserSessionInfo,
} from "./agent-capabilities.js";
export {
  parsePluginManifest,
  parseOAuthConfig,
  PluginManifestSchema,
  OAuthConfigSchema,
  type PluginManifest,
  type PluginToolMapping,
  type PluginSettingSpec,
  type PluginLLMProviderSpec,
  type PluginWidgetSpec,
  type OAuthConfig,
} from "./plugin-manifest.js";
export { validatePluginDir } from "./validate-cli.js";
export type {
  ConnectorTarget,
  OutboundAttachment,
  OutboundMessage,
  InboundAttachment,
  InboundMessage,
  ConnectorStatus,
  ConnectorCapabilities,
  ConnectorWebhookRequest,
  ConnectorWebhookResponse,
  ConnectorContext,
  ConnectorAdapter,
  ConnectorModuleExports,
} from "./connector-types.js";

export function setPluginEnabled(name: string, enabled: boolean, root = pluginsRoot()): void {
  const disabled = readDisabledState(root);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const file = join(root, ".state.json");
  const existing = existsSync(file) ? safeParse(readFileSync(file, "utf8")) : {};
  const next = { ...existing, disabled: [...disabled].sort() };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
