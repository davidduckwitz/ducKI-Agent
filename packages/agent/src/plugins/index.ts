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
} from "./plugin-registry.js";
export {
  parsePluginManifest,
  parseOAuthConfig,
  PluginManifestSchema,
  OAuthConfigSchema,
  type PluginManifest,
  type PluginToolMapping,
  type PluginSettingSpec,
  type OAuthConfig,
} from "./plugin-manifest.js";
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

/**
 * Persist a user enable/disable override to plugins/.state.json. File-first: the manifest
 * stays the default, this file only records what the user turned off, so the main database
 * is never touched.
 */
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
