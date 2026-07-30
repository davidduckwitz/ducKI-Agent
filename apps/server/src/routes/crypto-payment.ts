import { Router, Request, Response } from "express";
import { DatabaseService } from "@ducki/database";
import { CryptoService } from "../services/crypto-service";

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

  return router;
}

export default createCryptoPaymentRouter;
