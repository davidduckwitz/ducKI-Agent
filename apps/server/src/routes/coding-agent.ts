import { Router, type IRouter } from "express";
import type { CodingAgent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import type { AgentEventEmitter } from "@ducki/agent";
import { EventEmitter } from "node:events";

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
 * settings page the single source of truth. The tier is chosen by plan step count (mirrors the old
 * frontend heuristic of 20/50/100), falling back to the flat CODING_AGENT_MAX_ITERATIONS, then to any
 * client-supplied value, then to the documented default.
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
  return clientOverride && clientOverride > 0 ? clientOverride : 50;
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
    const timeoutMs = parseIntSetting(await db.getSetting("CODING_AGENT_TIMEOUT_MS"), 0);

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
          });
        }
      },
    };

    const codingAgent = createCodingAgent({
      sandboxRoot: body.sandboxRoot,
      maxIterations: maxIterationsPerAttempt,
      eventEmitter: phaseEventEmitter,
    });

    const result = await codingAgent.run(goal, {
      verifyCommand: body.verifyCommand,
      maxAttempts,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });

    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});
