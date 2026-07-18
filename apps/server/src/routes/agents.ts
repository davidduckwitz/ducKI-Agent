import { Router, type IRouter } from "express";
import { createApiResponse } from "@ducki/shared";
import { agentRegistry } from "../lib/agent-registry.js";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/live", (req, res) => {
  const snapshot = agentRegistry.snapshot();
  const snapshotAt = new Date().toISOString();
  const sourceMap = {
    chat_http: snapshot.agents.filter((entry) => entry.source === "chat_http").length,
    chat_ws: snapshot.agents.filter((entry) => entry.source === "chat_ws").length,
    task_run: snapshot.agents.filter((entry) => entry.source === "task_run").length,
    workflow_run: snapshot.agents.filter((entry) => entry.source === "workflow_run").length,
    gateway_inbound: snapshot.agents.filter((entry) => entry.source === "gateway_inbound").length,
  };
  const summary = {
    chats: snapshot.agents.filter((entry) => entry.source === "chat_http" || entry.source === "chat_ws").length,
    tasks: snapshot.agents.filter((entry) => entry.source === "task_run").length,
    workflows: snapshot.agents.filter((entry) => entry.source === "workflow_run").length,
    gateway: snapshot.agents.filter((entry) => entry.source === "gateway_inbound").length,
  };

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
    ...snapshot,
    snapshotAt,
    sourceMap,
    summary,
    gateway: {
      discord: discordStatus,
    },
  }));
});
