import { Router } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";
import { CredentialManager, type Credential, type CredentialRotationConfig } from "@ducki/providers";

const CREDENTIALS_KEY = "credentials:agent";

let credentialManager: CredentialManager;
let database: DatabaseService;
let initialized = false;

/**
 * Initialize credentials from database
 */
async function initializeCredentials() {
  try {
    const stored = await database.getSetting(CREDENTIALS_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      credentialManager.importCredentials(data);
    }
    initialized = true;
  } catch (error) {
    console.error("Failed to initialize credentials from database", error);
    initialized = true;
  }
}

export const credentialRouter: ReturnType<typeof Router> = Router();

export function setupCredentialRoutes(db: DatabaseService): void {
  database = db;
  credentialManager = new CredentialManager();

  // Initialize on startup
  void initializeCredentials();

  // Register all handlers
  registerCredentialHandlers();
}

function registerCredentialHandlers(): void {
  /**
   * GET /
   * List all registered credentials (without exposing full API keys)
   */
  credentialRouter.get("/", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const provider = req.query.provider as string | undefined;

      let credentials: Credential[];
      if (provider) {
        credentials = credentialManager.getAllCredentials(provider);
      } else {
        // Get all credentials from all providers
        const exported = credentialManager.exportCredentials();
        credentials = Object.values(exported).flat();
      }

      // Mask API keys for security
      const masked = credentials.map((c) => ({
        id: c.id,
        provider: c.provider,
        displayName: c.displayName,
        isActive: c.isActive,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        successCount: c.successCount,
        failureCount: c.failureCount,
        maskedKey: c.key.slice(0, 4) + "***" + c.key.slice(-4),
      }));

      res.json(createApiResponse(masked));
    } catch (error) {
      res.status(500).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to list credentials",
        })
      );
    }
  });

  /**
   * POST /
   * Register a new credential
   * Body: { provider, credentialId, apiKey, displayName }
   */
  credentialRouter.post("/", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const { provider, credentialId, apiKey, displayName } = req.body;

      if (!provider || !credentialId || !apiKey || !displayName) {
        return res.status(400).json(
          createApiResponse({
            error: "Missing required fields: provider, credentialId, apiKey, displayName",
          })
        );
      }

      // Validate provider name
      const validProviders = ["anthropic", "gemini", "bedrock", "openai", "openrouter", "lmstudio", "ollama"];
      if (!validProviders.includes(provider)) {
        return res.status(400).json(
          createApiResponse({
            error: `Invalid provider. Must be one of: ${validProviders.join(", ")}`,
          })
        );
      }

      // Register credential
      credentialManager.registerCredential({
        id: credentialId,
        provider,
        key: apiKey,
        displayName,
        createdAt: Date.now(),
        isRotated: false,
      });

      // Persist to database
      const exported = credentialManager.exportCredentials();
      await database.setSetting(CREDENTIALS_KEY, JSON.stringify(exported));

      res.status(201).json(
        createApiResponse({
          data: {
            provider,
            credentialId,
            displayName,
            message: "Credential registered successfully",
          },
        })
      );
    } catch (error) {
      res.status(400).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to register credential",
        })
      );
    }
  });

  /**
   * PATCH /:credentialId
   * Update credential details (displayName only, not the key)
   */
  credentialRouter.patch("/:credentialId", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const { credentialId } = req.params;
      const { displayName } = req.body;

      if (!displayName) {
        return res.status(400).json(createApiResponse({ error: "displayName is required" }));
      }

      // Find and update credential
      const exported = credentialManager.exportCredentials();
      let found = false;

      for (const provider in exported) {
        const creds = exported[provider];
        if (creds) {
          const cred = creds.find((c) => c.id === credentialId);
          if (cred) {
            cred.displayName = displayName;
            found = true;
            break;
          }
        }
      }

      if (!found) {
        return res.status(404).json(createApiResponse({ error: "Credential not found" }));
      }

      // Re-import and persist
      credentialManager.importCredentials(exported);
      await database.setSetting(CREDENTIALS_KEY, JSON.stringify(exported));

      res.json(createApiResponse({ data: { credentialId, displayName } }));
    } catch (error) {
      res.status(400).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to update credential",
        })
      );
    }
  });

  /**
   * DELETE /:credentialId
   * Remove a credential
   */
  credentialRouter.delete("/:credentialId", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const { credentialId } = req.params;

      const exported = credentialManager.exportCredentials();
      let found = false;

      for (const provider in exported) {
        const creds = exported[provider];
        if (creds) {
          const index = creds.findIndex((c) => c.id === credentialId);
          if (index !== -1) {
            creds.splice(index, 1);
            found = true;
            break;
          }
        }
      }

      if (!found) {
        return res.status(404).json(createApiResponse({ error: "Credential not found" }));
      }

      // Re-import and persist
      credentialManager.importCredentials(exported);
      await database.setSetting(CREDENTIALS_KEY, JSON.stringify(exported));

      res.json(createApiResponse({ data: { removed: credentialId } }));
    } catch (error) {
      res.status(400).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to delete credential",
        })
      );
    }
  });

  /**
   * GET /rotation-status/:provider
   * Get credential rotation status for a provider
   */
  credentialRouter.get("/rotation-status/:provider", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const { provider } = req.params;
      const status = credentialManager.getRotationStatus(provider);

      res.json(createApiResponse({ data: status }));
    } catch (error) {
      res.status(500).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to get rotation status",
        })
      );
    }
  });

  /**
   * GET /rotation-config
   * Get current rotation configuration
   */
  credentialRouter.get("/rotation-config", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const stored = await database.getSetting("credentials:rotation-config");
      const config: Partial<CredentialRotationConfig> = stored
        ? JSON.parse(stored)
        : {
            enabled: true,
            maxFailuresBeforeRotation: 5,
            minTimeBetweenRotations: 60000,
            maxCredentialsPerProvider: 3,
            rotateOnUnauthorized: true,
            rotateOnBillingError: false,
            retryAfterRotation: true,
          };

      res.json(createApiResponse({ data: config }));
    } catch (error) {
      res.status(500).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to get rotation config",
        })
      );
    }
  });

  /**
   * PATCH /rotation-config
   * Update rotation configuration
   */
  credentialRouter.patch("/rotation-config", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const config = req.body as Partial<CredentialRotationConfig>;

      credentialManager.updateRotationConfig(config);

      // Persist to database
      await database.setSetting("credentials:rotation-config", JSON.stringify(config));

      res.json(createApiResponse({ data: config }));
    } catch (error) {
      res.status(400).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to update rotation config",
        })
      );
    }
  });

  /**
   * POST /rotate/:provider
   * Manually trigger credential rotation for a provider
   */
  credentialRouter.post("/rotate/:provider", async (req, res) => {
    try {
      if (!initialized) {
        return res.status(503).json(createApiResponse({ error: "Service initializing..." }));
      }

      const { provider } = req.params;

      const rotated = await credentialManager.rotateCredential(provider);

      if (rotated) {
        res.json(
          createApiResponse({
            data: {
              provider,
              rotated: true,
              message: "Credential rotated successfully",
            },
          })
        );
      } else {
        res.status(409).json(
          createApiResponse({
            error: `Failed to rotate credential for ${provider}. Check rotation status.`,
          })
        );
      }
    } catch (error) {
      res.status(400).json(
        createApiResponse({
          error: error instanceof Error ? error.message : "Failed to rotate credential",
        })
      );
    }
  });
}
