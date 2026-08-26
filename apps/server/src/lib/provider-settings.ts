/**
 * Builds an LLMProvider from the currently saved settings - the same selection logic
 * index.ts uses for the main chat agent, extracted so other callers (agent-capabilities.ts,
 * used by trust:"node" plugins) can get "the currently configured provider" without importing
 * index.ts itself (which has server-startup side effects and isn't meant to be a library).
 */
import { createProvider, type ProviderName } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import type { LoadedPluginLLMProvider } from "@ducki/agent";

const logger = getRootLogger().child("ProviderSettings");
let pluginProviders: LoadedPluginLLMProvider[] = [];

export function setPluginLLMProviders(providers: LoadedPluginLLMProvider[]): void {
  const ids = new Set<string>(["openai", "openrouter", "ollama", "lmstudio", "claude"]);
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Duplicate plugin LLM provider id: ${provider.id}`);
    ids.add(provider.id);
  }
  pluginProviders = [...providers];
}

export function getPluginLLMProviders(): LoadedPluginLLMProvider[] {
  return [...pluginProviders];
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^Bearer\s+/i, "").trim();
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase();
  if (["lm-studio", "not-needed", "none", "null", "undefined"].includes(lowered)) {
    return undefined;
  }
  return normalized;
}

function readSettingValue(
  settings: Map<string, string>,
  key: string,
  envKey?: string,
  fallback?: string
): string | undefined {
  const fromSettings = settings.get(key)?.trim();
  if (fromSettings) return fromSettings;
  if (envKey) {
    const fromEnv = process.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  if (fallback && fallback.trim()) return fallback;
  return undefined;
}

function parseProviderName(value: string | undefined): ProviderName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "openrouter" ||
    normalized === "ollama" ||
    normalized === "lmstudio" ||
    normalized === "claude"
  ) {
    return normalized;
  }
  return undefined;
}

export interface ProviderOverride {
  /** Per-request model override. It is never persisted to settings. */
  model?: string;
  /** Resolve a provider without changing DEFAULT_PROVIDER (used by the settings catalog). */
  providerName?: string;
}

export async function loadProviderFromSettings(db: DatabaseService, override: ProviderOverride = {}) {
  const allSettings = await db.getAllSettings();
  const settingMap = new Map(allSettings.map((entry) => [entry.key, entry.value]));
  const selectedName = override.providerName?.trim().toLowerCase()
    || readSettingValue(settingMap, "DEFAULT_PROVIDER", "DEFAULT_PROVIDER", "lmstudio")?.toLowerCase()
    || "lmstudio";
  const pluginProvider = pluginProviders.find((entry) => entry.id === selectedName);
  if (pluginProvider) {
    const model = override.model?.trim() || readSettingValue(settingMap, pluginProvider.modelSetting, undefined, pluginProvider.defaultModel);
    if (!model) throw new Error(`No model configured for plugin provider '${selectedName}'`);
    const provider = await pluginProvider.create({
      model,
      baseUrl: pluginProvider.baseUrlSetting
        ? readSettingValue(settingMap, pluginProvider.baseUrlSetting, undefined, pluginProvider.defaultBaseUrl)
        : pluginProvider.defaultBaseUrl,
      apiKey: pluginProvider.apiKeySetting
        ? normalizeApiKey(readSettingValue(settingMap, pluginProvider.apiKeySetting))
        : undefined,
    });
    return { provider, providerName: selectedName };
  }
  const providerName = parseProviderName(selectedName);
  if (!providerName) throw new Error(`Unknown LLM provider: ${selectedName}`);

  if (providerName === "lmstudio") {
    const rawApiKey = readSettingValue(settingMap, "LM_STUDIO_API_KEY", "LM_STUDIO_API_KEY");
    const normalizedKey = normalizeApiKey(rawApiKey);
    logger.debug("loadProviderFromSettings: LM Studio config", {
      hasRawApiKey: !!rawApiKey,
      rawKeyLength: rawApiKey?.length ?? 0,
      hasNormalizedKey: !!normalizedKey,
      normalizedKeyLength: normalizedKey?.length ?? 0,
    });
    const provider = createProvider({
      name: "lmstudio",
      baseUrl: readSettingValue(settingMap, "LM_STUDIO_BASE_URL", "LM_STUDIO_BASE_URL", "http://localhost:1234/v1"),
      model: override.model?.trim() || readSettingValue(settingMap, "LM_STUDIO_MODEL", "LM_STUDIO_MODEL", "local-model"),
      apiKey: normalizedKey,
    });
    return { provider, providerName };
  }

  if (providerName === "openrouter") {
    const provider = createProvider({
      name: "openrouter",
      baseUrl: readSettingValue(settingMap, "OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
      model: override.model?.trim() || readSettingValue(settingMap, "OPENROUTER_MODEL", "OPENROUTER_MODEL", "anthropic/claude-3-5-sonnet"),
      apiKey: normalizeApiKey(readSettingValue(settingMap, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY")),
    });
    return { provider, providerName };
  }

  if (providerName === "openai") {
    const provider = createProvider({
      name: "openai",
      baseUrl: readSettingValue(settingMap, "OPENAI_BASE_URL", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
      model: override.model?.trim() || readSettingValue(settingMap, "OPENAI_MODEL", "OPENAI_MODEL", "gpt-4o"),
      apiKey: normalizeApiKey(readSettingValue(settingMap, "OPENAI_API_KEY", "OPENAI_API_KEY")),
    });
    return { provider, providerName };
  }

  if (providerName === "claude") {
    const rawKey = readSettingValue(settingMap, "CLAUDE_API_KEY", "CLAUDE_API_KEY");
    const normalizedKey = normalizeApiKey(rawKey);
    logger.debug("loadProviderFromSettings: Claude config", {
      hasRawApiKey: !!rawKey,
      rawKeyLength: rawKey?.length ?? 0,
      hasNormalizedKey: !!normalizedKey,
      normalizedKeyLength: normalizedKey?.length ?? 0,
      normalizedKeyStart: normalizedKey?.substring(0, 20) ?? "none",
      baseUrl: "https://api.anthropic.com/v1",
      model: override.model?.trim() || readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
    });
    const provider = createProvider({
      name: "claude",
      baseUrl: readSettingValue(settingMap, "CLAUDE_BASE_URL", "CLAUDE_BASE_URL", "https://api.anthropic.com/v1"),
      model: override.model?.trim() || readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
      apiKey: normalizedKey,
    });
    return { provider, providerName };
  }

  const provider = createProvider({
    name: "ollama",
    baseUrl: readSettingValue(settingMap, "OLLAMA_BASE_URL", "OLLAMA_BASE_URL", "http://localhost:11434"),
    model: override.model?.trim() || readSettingValue(settingMap, "OLLAMA_MODEL", "OLLAMA_MODEL", "llama3"),
  });
  return { provider, providerName };
}

export interface AvailableProviderModel {
  id: string;
  name: string;
  contextLength?: number;
}

/**
 * Reads the active provider's model catalog from the provider itself. This runs on the
 * agent machine, so localhost LM Studio/Ollama APIs remain reachable even when the caller
 * is the cloud Voice UI.
 */
export async function listActiveProviderModels(db: DatabaseService): Promise<{
  providerName: string;
  activeModel: string;
  models: AvailableProviderModel[];
}> {
  const { provider, providerName } = await loadProviderFromSettings(db);
  const activeModel = provider.model;
  if (!provider.listModels) {
    return { providerName, activeModel, models: [{ id: activeModel, name: activeModel }] };
  }

  const listed = await provider.listModels();
  const byId = new Map(listed.map((entry) => [
    entry.id.trim(),
    { id: entry.id.trim(), name: entry.name?.trim() || entry.id.trim(), ...(entry.contextLength ? { contextLength: entry.contextLength } : {}) },
  ]));
  if (activeModel && !byId.has(activeModel)) byId.set(activeModel, { id: activeModel, name: activeModel });

  return {
    providerName,
    activeModel,
    models: [...byId.values()].filter((entry) => entry.id),
  };
}
