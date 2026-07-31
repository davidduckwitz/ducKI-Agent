import { Router, Request, Response } from "express";
import { DatabaseService } from "@ducki/database";
import { CryptoService } from "../services/crypto-service.js";

export function createCryptoPaymentRouter(db: DatabaseService): Router {
  const router = Router();
  const cryptoService = new CryptoService(db);

  // Create new address
  router.post("/addresses", async (req: Request, res: Response) => {
    try {
      const { currency, label, derivationPath } = req.body;

      if (!currency || !["BTC", "ETH", "XRP"].includes(currency)) {
        return res.status(400).json({ error: "Invalid currency" });
      }

      const result = await cryptoService.createAddress(currency, label, derivationPath);
      res.json({ data: result });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get all addresses
  router.get("/addresses", async (req: Request, res: Response) => {
    try {
      const { currency } = req.query;
      const addresses = await cryptoService.getAddresses((currency as "BTC" | "ETH" | "XRP" | undefined) || undefined);
      res.json({ data: addresses });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get single address
  router.get("/addresses/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: "ID is required" });
      }
      const address = await cryptoService.getAddressById(parseInt(id));
      if (!address) {
        return res.status(404).json({ error: "Address not found" });
      }
      res.json({ data: address });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Update address label
  router.patch("/addresses/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { label } = req.body;

      if (!id || !label) {
        return res.status(400).json({ error: "ID and label are required" });
      }

      await cryptoService.updateAddressLabel(parseInt(id), label);
      res.json({ data: { success: true } });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Delete address
  router.delete("/addresses/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: "ID is required" });
      }
      await cryptoService.deleteAddress(parseInt(id));
      res.json({ data: { success: true } });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Import private key
  router.post("/addresses/import", async (req: Request, res: Response) => {
    try {
      const { currency, privateKey, label } = req.body;

      if (!currency || !privateKey) {
        return res.status(400).json({ error: "Currency and privateKey are required" });
      }

      const result = await cryptoService.importPrivateKey(currency, privateKey, label || "Imported");
      res.json({ data: result });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get portfolio summary
  router.get("/portfolio/summary", async (req: Request, res: Response) => {
    try {
      const summary = await cryptoService.getPortfolioSummary();
      res.json({ data: summary });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Set API credentials
  router.post("/api-credentials", async (req: Request, res: Response) => {
    try {
      const { provider, apiKey, apiSecret } = req.body;

      if (!provider || !apiKey) {
        return res.status(400).json({ error: "Provider and apiKey are required" });
      }

      await cryptoService.setApiCredentials(provider, apiKey, apiSecret);
      res.json({ data: { success: true } });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get crypto settings
  router.get("/settings", async (req: Request, res: Response) => {
    try {
      const settings = {
        currency: "USD",
        theme: "dark",
        refreshIntervalSeconds: 300,
        autoSyncEnabled: true,
        notificationsEnabled: false,
        exportFormat: "json",
      };
      res.json({ data: settings });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Update crypto settings
  router.patch("/settings", async (req: Request, res: Response) => {
    try {
      const { currency, theme, refreshIntervalSeconds, autoSyncEnabled, notificationsEnabled, exportFormat } = req.body;

      const settings = {
        currency: currency || "USD",
        theme: theme || "dark",
        refreshIntervalSeconds: refreshIntervalSeconds || 300,
        autoSyncEnabled: autoSyncEnabled !== false,
        notificationsEnabled: notificationsEnabled || false,
        exportFormat: exportFormat || "json",
      };

      // In a real implementation, these would be saved to the database
      res.json({ data: { success: true, settings } });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Test API connection with provider
  router.post("/api-test", async (req: Request, res: Response) => {
    try {
      const { provider, apiKey, apiSecret } = req.body;

      if (!provider || !apiKey) {
        return res.status(400).json({ error: "Provider and apiKey are required" });
      }

      const testResult = await cryptoService.testApiConnection(provider, apiKey, apiSecret);
      res.json({ data: testResult });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

export default createCryptoPaymentRouter;
