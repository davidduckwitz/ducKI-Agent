import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { createProvider } from "@ducki/providers";
import { ProviderSettingsService } from "../lib/provider-settings-service.js";

interface Model {
  id: string;
  name: string;
}

interface ProviderModelsResponse {
  success: boolean;
  provider: string;
  models?: Model[];
  error?: string;
  timestamp: string;
}

const HARDCODED_MODELS: Record<string, Model[]> = {
  lmstudio: [],
  ollama: [],
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
    { id: "gpt-4", name: "GPT-4" },
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
  ],
  openrouter: [
    { id: "anthropic/claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
    { id: "openai/gpt-4-turbo", name: "GPT-4 Turbo" },
    { id: "meta-llama/llama-3-70b-instruct", name: "Llama 3 70B" },
  ],
  claude: [
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-opus-20250219", name: "Claude 3 Opus" },
    { id: "claude-3-haiku-20250307", name: "Claude 3 Haiku" },
  ],
  nous: [
    { id: "nous-hermes-2-mixtral-8x7b-dpo", name: "Nous Hermes 2 Mixtral" },
  ],
};

export function createProviderModelsRouter(db: DatabaseService): IRouter {
  const router = Router();
  const logger = getRootLogger().child("ProviderModelsAPI");
  const settingsService = new ProviderSettingsService(db);

  /**
   * GET /:provider
   * Fetch available models for a specific provider
   * For LM Studio: Fetches from local API
   * For others: Returns hardcoded lists
   */
  router.get("/:provider", async (req, res) => {
    const { provider } = req.params;

    try {
      const response: ProviderModelsResponse = {
        success: false,
        provider,
        timestamp: new Date().toISOString(),
      };

      // Get provider config from settings
      const settings = await settingsService.getSettingsFlat();

      const providerConfig = {
        name: provider as any,
        baseUrl: settings[`${provider.toUpperCase()}_BASE_URL`] as string | undefined,
        apiKey: settings[`${provider.toUpperCase()}_API_KEY`] as string | undefined,
        model: settings[`${provider.toUpperCase()}_MODEL`] as string | undefined,
      };

      // For hardcoded providers, return immediately
      if (HARDCODED_MODELS[provider]) {
        response.models = HARDCODED_MODELS[provider];
        response.success = true;
        return res.json(response);
      }

      // For local providers (LM Studio, Ollama), try to fetch models
      if (provider === "lmstudio" || provider === "ollama") {
        try {
          const providerInstance = createProvider(providerConfig);

          // Check if provider is available
          const isAvailable = await providerInstance.isAvailable();
          if (!isAvailable) {
            response.error = `${provider} provider is not available`;
            response.success = false;
            return res.status(503).json(response);
          }

          // Fetch models from provider
          if (provider === "lmstudio" || provider === "ollama") {
            const client = (providerInstance as any).client;
            if (client && client.models && typeof client.models.list === 'function') {
              const modelList = await client.models.list();
              response.models = (modelList.data || []).map((m: any) => ({
                id: m.id,
                name: m.id,
              }));
              response.success = true;
              return res.json(response);
            }
          }
        } catch (error) {
          logger.error(`Failed to fetch models from ${provider}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          response.error = `Failed to connect to ${provider}`;
          response.success = false;
          return res.status(503).json(response);
        }
      }

      response.error = `Unknown provider: ${provider}`;
      return res.status(400).json(response);
    } catch (error) {
      logger.error("Provider models API error", {
        error: error instanceof Error ? error.message : String(error),
        provider: req.params.provider,
      });
      res.status(500).json({
        success: false,
        provider: req.params.provider,
        error: "Internal server error",
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /
   * Get list of all available providers
   */
  router.get("/", async (_req, res) => {
    try {
      const providers = [
        { id: "lmstudio", name: "LM Studio (local)" },
        { id: "openai", name: "OpenAI" },
        { id: "openrouter", name: "OpenRouter" },
        { id: "ollama", name: "Ollama (local)" },
        { id: "claude", name: "Anthropic Claude" },
        { id: "nous", name: "Nous Research" },
      ];

      res.json({
        success: true,
        providers,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to get providers list", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: "Failed to get providers list",
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}
