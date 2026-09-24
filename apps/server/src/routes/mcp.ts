import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { normalizeMcpServers, type MCPRegistry, type MCPServerConfig } from "@ducki/mcp";
import { createApiError, createApiResponse } from "@ducki/shared";

export const mcpRouter: IRouter = Router();

const MCP_SERVERS_SETTING = "MCP_SERVERS";

async function loadConfiguredServers(db: DatabaseService): Promise<MCPServerConfig[]> {
  const raw = await db.getSetting(MCP_SERVERS_SETTING);
  if (!raw) return [];
  try {
    return normalizeMcpServers(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function saveConfiguredServers(db: DatabaseService, servers: MCPServerConfig[]): Promise<void> {
  await db.setSetting(MCP_SERVERS_SETTING, JSON.stringify(servers));
}

mcpRouter.get("/servers", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
    const configured = await loadConfiguredServers(db);
    const runtime = registry.getServerStatus();
    res.json(createApiResponse({ configured, runtime }));
  } catch (error) {
    next(error);
  }
});

mcpRouter.put("/servers", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
    let servers: MCPServerConfig[];
    try { servers = normalizeMcpServers(req.body?.servers ?? req.body); }
    catch (error) { res.status(400).json(createApiError(String(error))); return; }
    await saveConfiguredServers(db, servers);
    await registry.syncServers(servers);
    res.json(createApiResponse({ saved: true, servers: registry.getServerStatus() }));
  } catch (error) {
    next(error);
  }
});

mcpRouter.post("/servers/reload", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
    const servers = await loadConfiguredServers(db);
    await registry.syncServers(servers);
    res.json(createApiResponse({ reloaded: true, servers: registry.getServerStatus() }));
  } catch (error) {
    next(error);
  }
});

mcpRouter.get("/tools", (req, res) => {
  const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
  res.json(createApiResponse(registry.listTools()));
});

mcpRouter.post("/tools/call", async (req, res, next) => {
  try {
    const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const toolName = String(body["toolName"] ?? "").trim();
    if (!toolName) {
      res.status(400).json(createApiError("toolName is required"));
      return;
    }
    const input = (body["input"] && typeof body["input"] === "object")
      ? (body["input"] as Record<string, unknown>)
      : {};
    const serverId = body["serverId"] ? String(body["serverId"]) : undefined;
    const result = await registry.callTool(toolName, input, serverId);
    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});

mcpRouter.post("/tools/stream", async (req, res, next) => {
  try {
    const registry = req.app.locals["mcpRegistry"] as MCPRegistry;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const toolName = String(body["toolName"] ?? "").trim();
    if (!toolName) {
      res.status(400).json(createApiError("toolName is required"));
      return;
    }

    const input = (body["input"] && typeof body["input"] === "object")
      ? (body["input"] as Record<string, unknown>)
      : {};
    const serverId = body["serverId"] ? String(body["serverId"]) : undefined;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for await (const chunk of registry.streamTool(toolName, input, serverId)) {
      res.write(`data: ${chunk}\n\n`);
    }
    res.write("event: end\ndata: done\n\n");
    res.end();
  } catch (error) {
    next(error);
  }
});
