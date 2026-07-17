import { Router, type IRouter } from "express";
import { createApiResponse } from "@ducki/shared";
import { agentRegistry } from "../lib/agent-registry.js";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/live", (req, res) => {
  const discordStatus = (req.app.locals["discordGatewayStatus"] as {
    enabled: boolean;
    configured: boolean;
    active: boolean;
    connectedAt?: string;
    lastError?: string;
    updatedAt: string;
  } | undefined) ?? {
    enabled: false,
    configured: false,
    active: false,
    updatedAt: new Date().toISOString(),
  };

  res.json(createApiResponse({
    ...agentRegistry.snapshot(),
    gateway: {
      discord: discordStatus,
    },
  }));
});
