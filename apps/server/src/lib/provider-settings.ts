/**
 * Builds an LLMProvider from the currently saved settings - the same selection logic
 * index.ts uses for the main chat agent, extracted so other callers (agent-capabilities.ts,
 * used by trust:"node" plugins) can get "the currently configured provider" without importing
 * index.ts itself (which has server-startup side effects and isn't meant to be a library).
 */
import { createProvider, type ProviderName } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("ProviderSettings");

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

function parseProviderName(value: string | undefined): ProviderName {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "openrouter" ||
    normalized === "ollama" ||
    normalized === "lmstudio" ||
    normalized === "claude" ||
    normalized === "nous"
  ) {
    return normalized;
  }
  return "lmstudio";
}

export async function loadProviderFromSettings(db: DatabaseService) {
  const allSettings = await db.getAllSettings();
  const settingMap = new Map(allSettings.map((entry) => [entry.key, entry.value]));
  const providerName = parseProviderName(
    readSettingValue(settingMap, "DEFAULT_PROVIDER", "DEFAULT_PROVIDER", "lmstudio")
  );

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
      model: readSettingValue(settingMap, "LM_STUDIO_MODEL", "LM_STUDIO_MODEL", "local-model"),
      apiKey: normalizedKey,
    });
    return { provider, providerName };
  }

  if (providerName === "openrouter") {
    const provider = createProvider({
      name: "openrouter",
      baseUrl: readSettingValue(settingMap, "OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
      model: readSettingValue(settingMap, "OPENROUTER_MODEL", "OPENROUTER_MODEL", "anthropic/claude-3-5-sonnet"),
      apiKey: normalizeApiKey(readSettingValue(settingMap, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY")),
    });
    return { provider, providerName };
  }

  if (providerName === "openai") {
    const provider = createProvider({
      name: "openai",
      baseUrl: readSettingValue(settingMap, "OPENAI_BASE_URL", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
      model: readSettingValue(settingMap, "OPENAI_MODEL", "OPENAI_MODEL", "gpt-4o"),
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
      model: readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
    });
    const provider = createProvider({
      name: "claude",
      baseUrl: readSettingValue(settingMap, "CLAUDE_BASE_URL", "CLAUDE_BASE_URL", "https://api.anthropic.com/v1"),
      model: readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
      apiKey: normalizedKey,
    });
    return { provider, providerName };
  }

  if (providerName === "nous") {
    const provider = createProvider({
      name: "nous",
      baseUrl: readSettingValue(settingMap, "NOUS_BASE_URL", "NOUS_BASE_URL"),
      model: readSettingValue(settingMap, "NOUS_MODEL", "NOUS_MODEL"),
      apiKey: normalizeApiKey(readSettingValue(settingMap, "NOUS_API_KEY", "NOUS_API_KEY")),
    });
    return { provider, providerName };
  }

  const provider = createProvider({
    name: "ollama",
    baseUrl: readSettingValue(settingMap, "OLLAMA_BASE_URL", "OLLAMA_BASE_URL", "http://localhost:11434"),
    model: readSettingValue(settingMap, "OLLAMA_MODEL", "OLLAMA_MODEL", "llama3"),
  });
  return { provider, providerName };
}
