import { Router, type IRouter } from "express";
import { createApiResponse } from "@ducki/shared";
import { agentRegistry } from "../lib/agent-registry.js";
import { BitcoinPuzzleService } from "@ducki/agent";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/live", (req, res) => {
  const snapshot = agentRegistry.snapshot();
  const snapshotAt = new Date().toISOString();

  // Bitcoin Puzzle Info
  const bitcoinPuzzleService = BitcoinPuzzleService.getInstance();
  const runningPuzzlesCount = bitcoinPuzzleService.getRunningPuzzlesCount();
  const allPuzzles = bitcoinPuzzleService.getAllPuzzlesInfo();

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
    bitcoinPuzzles: runningPuzzlesCount,
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
    bitcoinPuzzles: {
      running: runningPuzzlesCount,
      total: allPuzzles.length,
      puzzles: allPuzzles,
    },
  }));
});
