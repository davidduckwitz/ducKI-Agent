import { Router, type IRouter } from "express";
import type { CodingAgent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import type { AgentEventEmitter } from "@ducki/agent";
import { isAbortError } from "@ducki/providers";
import { EventEmitter } from "node:events";
import { agentRegistry } from "../lib/agent-registry.js";
import { registerCodingRun, unregisterCodingRun } from "../lib/coding-run-registry.js";
import { notifyCodingRunFinished } from "../lib/coding-notify.js";

export const codingAgentRouter: IRouter = Router();

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/** Parses a numeric setting string; empty/blank/NaN falls back to the default so unset settings never break. */
function parseIntSetting(value: string | undefined | null, defaultValue: number): number {
  if (value == null || value.trim() === "") return defaultValue;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Resolves the per-attempt iteration budget from the persisted /settings > Agenten values, making the
 * settings page the single source of truth. The tier is chosen by plan step count and falls back to the
 * same defaults the settings UI displays (20/50/100, see CodingAgentSettings.tsx) when nothing was saved
 * yet - the tiered defaults must never collapse onto the flat CODING_AGENT_MAX_ITERATIONS value, so that
 * one stays "unset" (0) unless the user explicitly configured it.
 */
async function resolveCodingIterations(
  db: DatabaseService,
  stepCount: number | undefined,
  clientOverride: number | undefined
): Promise<number> {
  const flat = parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ITERATIONS"), 0);
  if (typeof stepCount === "number" && Number.isFinite(stepCount)) {
    if (stepCount <= 3) return parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ITERATIONS_SIMPLE"), flat || 20);
    if (stepCount <= 7) return parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ITERATIONS_MEDIUM"), flat || 50);
    return parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ITERATIONS_COMPLEX"), flat || 100);
  }
  if (flat > 0) return flat;
  return clientOverride && clientOverride > 0 ? clientOverride : 100;
}

codingAgentRouter.use(async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const raw = await db.getSetting("CODING_ENABLED");
    const enabled = parseBoolean(raw ?? "false", false);
    if (!enabled) {
      res.status(403).json(createApiError("Coding area is disabled"));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

codingAgentRouter.post("/run", async (req, res, next) => {
  try {
    const createCodingAgent = req.app.locals["createCodingAgent"] as
      | ((options?: { sandboxRoot?: string; maxIterations?: number; eventEmitter?: AgentEventEmitter }) => CodingAgent)
      | undefined;
    const io = req.app.locals["io"];
    const db = req.app.locals["db"] as DatabaseService;

    if (!createCodingAgent) {
      res.status(500).json(createApiError("Coding agent factory is not configured"));
      return;
    }

    const body = (req.body ?? {}) as {
      goal?: string;
      verifyCommand?: string;
      sandboxRoot?: string;
      maxAttempts?: number;
      maxIterations?: number;
      stepCount?: number;
      conversationId?: number;
    };
    const goal = String(body.goal ?? "").trim();
    if (!goal) {
      res.status(400).json(createApiError("goal is required"));
      return;
    }

    // Iteration/attempt/timeout budgets come from the persisted /settings > Agenten values so the
    // settings page is authoritative. stepCount (sent by the frontend) picks the tier; a client
    // maxIterations is only a last-resort fallback for older clients.
    const maxIterationsPerAttempt = await resolveCodingIterations(db, body.stepCount, body.maxIterations);
    const maxAttempts = parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ATTEMPTS"), body.maxAttempts ?? 3);
    // Default 5 minutes (300000ms) - the same value the settings UI displays as the standard.
    // Previously the fallback was 0 (= no wall-clock limit at all), so a run that never
    // converged could loop for hours unless the user had explicitly saved the setting.
    const timeoutMs = parseIntSetting(await db.getSetting("CODING_AGENT_TIMEOUT_MS"), 300000);

    // A run started from an existing chat continues IN that chat instead of opening a second
    // session for it. Validated here rather than trusted: a bogus id would otherwise surface
    // as an opaque "conversation not found" from deep inside the agent.
    const requestedConversationId =
      typeof body.conversationId === "number" && Number.isFinite(body.conversationId) && body.conversationId > 0
        ? body.conversationId
        : undefined;
    let reuseConversationId: number | undefined;
    if (requestedConversationId !== undefined) {
      const existing = await db.getConversation(requestedConversationId).catch(() => undefined);
      if (!existing) {
        res.status(404).json(createApiError(`Conversation ${requestedConversationId} not found`));
        return;
      }
      reuseConversationId = requestedConversationId;
    }

    // Create an event emitter that broadcasts phase events over WebSocket
    const phaseEventEmitter: AgentEventEmitter = {
      emitChunk(chunk: string) {
        // Broadcast streaming chunks to all connected clients
        if (io) {
          io.emit("coding_agent_chunk", { chunk });
        }
      },
      emitEvent(event: any) {
        // Broadcast phase events to all connected clients
        if (io) {
          io.emit("coding_agent_event", {
            type: event.type,
            message: event.message,
            data: event.data,
            timestamp: event.timestamp,
            ...(reuseConversationId !== undefined ? { conversationId: reuseConversationId } : {}),
          });
        }
      },
    };

    const codingAgent = createCodingAgent({
      sandboxRoot: body.sandboxRoot,
      maxIterations: maxIterationsPerAttempt,
      eventEmitter: phaseEventEmitter,
    });

    // Same registration this route lacked entirely before: without it, this run was invisible
    // to both the agentRegistry snapshot (so a client that reconnected/navigated away and back
    // lost the "still running" signal that re-arms the Stop button) and the chat:stop handler
    // (so clicking Stop found nothing to stop even if the button had stayed visible).
    let runConversationId: number | undefined;
    let agentRegistryRunId: string | undefined;
    try {
      const result = await codingAgent.run(goal, {
        verifyCommand: body.verifyCommand,
        maxAttempts,
        ...(reuseConversationId !== undefined ? { conversationId: reuseConversationId } : {}),
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
        onConversationStarted: (conversationId) => {
          runConversationId = conversationId;
          registerCodingRun(conversationId, codingAgent);
          agentRegistryRunId = agentRegistry.register({
            source: "chat_http",
            conversationId,
            label: "CodingAgent (HTTP)",
          });
          if (io) io.emit("coding_agent_started", { conversationId });
        },
      });
      res.json(createApiResponse(result));
      notifyCodingRunFinished(db, req.app.locals["logger"] || console, body.sandboxRoot || goal.slice(0, 60), result);
    } catch (error) {
      if (isAbortError(error)) {
        res.json(createApiResponse({ success: false, verified: false, stopped: true, summary: "Vom Nutzer gestoppt", attempts: 0 }));
        return;
      }
      throw error;
    } finally {
      if (runConversationId !== undefined) unregisterCodingRun(runConversationId);
      if (agentRegistryRunId !== undefined) agentRegistry.unregister(agentRegistryRunId);
    }
  } catch (error) {
    next(error);
  }
});
