import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { createApiResponse, createApiError } from "@ducki/shared";
import { getPluginLLMProviders, listActiveProviderModels, loadProviderFromSettings } from "../lib/provider-settings.js";

interface Model {
  id: string;
  name: string;
  contextLength?: number;
}

export function createProviderModelsRouter(db: DatabaseService): IRouter {
  const router = Router();
  const logger = getRootLogger().child("ProviderModelsAPI");

  router.get("/active", async (_req, res) => {
    try {
      res.json(createApiResponse(await listActiveProviderModels(db)));
    } catch (error) {
      logger.error("Failed to load active provider models", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json(createApiError(error instanceof Error ? error.message : "Model catalog unavailable"));
    }
  });

  /**
   * GET /:provider
   * Fetch available models for a specific provider
   * Every built-in and plugin provider uses the same provider-level listModels contract.
   */
  router.get("/:provider", async (req, res) => {
    const { provider } = req.params;

    try {
      const { provider: instance } = await loadProviderFromSettings(db, { providerName: provider });
      if (!instance.listModels) return res.status(501).json(createApiError(`${provider} does not support model discovery`));
      const models: Model[] = await instance.listModels();
      return res.json(createApiResponse({ models }));
    } catch (error) {
      logger.error("Provider models API error", {
        error: error instanceof Error ? error.message : String(error),
        provider: req.params.provider,
      });
      res.status(500).json(createApiError("Internal server error"));
    }
  });

  /**
   * GET /
   * Get list of all available providers
   */
  router.get("/", async (_req, res) => {
    try {
      const providers = [
        { id: "lmstudio", name: "LM Studio (local)", modelSetting: "LM_STUDIO_MODEL", baseUrlSetting: "LM_STUDIO_BASE_URL", apiKeySetting: "LM_STUDIO_API_KEY" },
        { id: "openai", name: "OpenAI", modelSetting: "OPENAI_MODEL", baseUrlSetting: "OPENAI_BASE_URL", apiKeySetting: "OPENAI_API_KEY" },
        { id: "openrouter", name: "OpenRouter", modelSetting: "OPENROUTER_MODEL", baseUrlSetting: "OPENROUTER_BASE_URL", apiKeySetting: "OPENROUTER_API_KEY" },
        { id: "ollama", name: "Ollama (local)", modelSetting: "OLLAMA_MODEL", baseUrlSetting: "OLLAMA_BASE_URL" },
        { id: "claude", name: "Anthropic Claude", modelSetting: "CLAUDE_MODEL", baseUrlSetting: "CLAUDE_BASE_URL", apiKeySetting: "CLAUDE_API_KEY" },
        ...getPluginLLMProviders().map(({ create: _create, module: _module, pluginName, ...provider }) => ({ ...provider, pluginName })),
      ];

      res.json(createApiResponse(providers));
    } catch (error) {
      logger.error("Failed to get providers list", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(createApiError("Failed to get providers list"));
    }
  });

  return router;
}
