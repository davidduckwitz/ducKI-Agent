import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import { agentRegistry } from "../lib/agent-registry.js";

export const agentsRouter: IRouter = Router();

// The bitcoin-puzzle feature moved to a plugin (apps/server/plugins/bitcoin-puzzle) with its
// own polling frontend - GET /api/plugins/bitcoin-puzzle/invoke {action:"list"} replaces the
// puzzle info this route used to fold in from the now-decommissioned core singleton.
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
    bitcoinPuzzles: 0,
  };

  // Generic connector registry status (Discord and any other installed connector plugin).
  // The "discord" key is kept for backward compat with the existing frontend type/UI.
  interface ConnectorStatusLike {
    configured: boolean;
    active: boolean;
    connectedAt?: string;
    lastError?: string;
    updatedAt: string;
  }
  const connectorRegistryRef = req.app.locals["connectorRegistryRef"] as { current?: { getStatuses(): Record<string, ConnectorStatusLike> } } | undefined;
  const connectorStatuses = connectorRegistryRef?.current?.getStatuses() ?? {};
  const defaultStatus: ConnectorStatusLike = { configured: false, active: false, updatedAt: new Date().toISOString() };
  const discordStatus = connectorStatuses["discord"] ?? defaultStatus;

  res.json(createApiResponse({
    ...snapshot,
    snapshotAt,
    sourceMap,
    summary,
    gateway: {
      discord: discordStatus,
    },
    connectorStatuses,
    bitcoinPuzzles: { running: 0, total: 0, puzzles: [] },
  }));
});

agentsRouter.post("/live/:id/stop", (req, res) => {
  if (!agentRegistry.stop(req.params["id"] ?? "")) {
    res.status(404).json(createApiError("Active agent run not found or not stoppable"));
    return;
  }
  res.json(createApiResponse({ stopped: true, id: req.params["id"] }));
});
