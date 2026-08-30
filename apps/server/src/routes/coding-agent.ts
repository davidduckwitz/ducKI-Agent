import { Router, type IRouter } from "express";
import type { CodingAgent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import type { AgentEventEmitter } from "@ducki/agent";
import { isAbortError, type LLMProvider } from "@ducki/providers";
import { EventEmitter } from "node:events";
import { agentRegistry } from "../lib/agent-registry.js";
import { registerCodingRun, unregisterCodingRun } from "../lib/coding-run-registry.js";
import { notifyCodingRunFinished } from "../lib/coding-notify.js";
import { loadProviderFromSettings } from "../lib/provider-settings.js";
import { resolveCodingSandboxRoot } from "./coding.js";

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
      | ((options?: { sandboxRoot?: string; maxIterations?: number; eventEmitter?: AgentEventEmitter; provider?: LLMProvider; exploreTimeoutMs?: number }) => CodingAgent)
      | undefined;
    const io = req.app.locals["io"];
    const db = req.app.locals["db"] as DatabaseService;
    const logger = req.app.locals["logger"] as { warn: (msg: string, meta?: unknown) => void } | undefined;

    if (!createCodingAgent) {
      res.status(500).json(createApiError("Coding agent factory is not configured"));
      return;
    }

    const body = (req.body ?? {}) as {
      goal?: string;
      verifyCommand?: string;
      sandboxRoot?: string;
      /** Project slug from the frontend coding workspace — resolved to sandboxRoot when
       *  sandboxRoot is not explicitly set (e.g. follow-up chat messages). */
      project?: string;
      maxAttempts?: number;
      maxIterations?: number;
      stepCount?: number;
      conversationId?: number;
      /** From the coding chat's LLM selector - unset means "use the system default provider". */
      provider?: string;
      model?: string;
      /** "Plan Mode" from the coding chat composer: create/refresh the plan and report it, never
       *  enter the EXPLORE/EDIT/VERIFY loop - see CodingRunOptions.planOnly. */
      planOnly?: boolean;
    };
    const goal = String(body.goal ?? "").trim();
    if (!goal) {
      res.status(400).json(createApiError("goal is required"));
      return;
    }

    // Same settings-backed resolution the /provider-models list and the main chat agent use
    // (loadProviderFromSettings) - NOT a bare createProvider(), which has no baseUrl/apiKey and
    // would silently fall back to http://localhost:1234 regardless of what LM Studio/Ollama/etc.
    // is actually configured to run on, sending the request to the wrong (or no) server.
    // Unresolvable falls back to the system default rather than failing the run.
    let providerOverride: LLMProvider | undefined;
    if (body.provider && body.model) {
      try {
        providerOverride = (await loadProviderFromSettings(db, { providerName: body.provider, model: body.model })).provider;
      } catch (error) {
        logger?.warn("Could not create coding-agent provider override, falling back to the system default", {
          provider: body.provider,
          model: body.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Iteration/attempt/timeout budgets come from the persisted /settings > Agenten values so the
    // settings page is authoritative. stepCount (sent by the frontend) picks the tier; a client
    // maxIterations is only a last-resort fallback for older clients.
    const maxIterationsPerAttempt = await resolveCodingIterations(db, body.stepCount, body.maxIterations);
    const maxAttempts = parseIntSetting(await db.getSetting("CODING_AGENT_MAX_ATTEMPTS"), body.maxAttempts ?? 3);
    // Default 30 minutes (1800000ms) - generous on purpose. Previously 5 minutes, which a slow
    // local model could burn through inside a SINGLE attempt (each iteration is a full LLM
    // round-trip plus tool calls), killing the whole run before CodingAgent's own guardrail-
    // triggered retry (a corrected attempt 2) ever got to run. maxAttempts/maxIterations already
    // bound how much work happens; this is meant as an outer safety net against a truly hung
    // run, not a tight per-minute budget - see agent-model-profiles.ts for the same reasoning
    // applied to the profile-specific values.
    const timeoutMs = parseIntSetting(await db.getSetting("CODING_AGENT_TIMEOUT_MS"), 1_800_000);
    // Same reasoning as timeoutMs above, applied to the explore sub-agent's own per-call budget:
    // this used to be hardcoded to 3 minutes (DUCKI_EXPLORE_TIMEOUT_MS env var or 180000), never
    // actually wired to a DB setting at all, so a slow local model routinely hit "Exploration
    // timed out after 180000ms" mid-run regardless of the CODING_AGENT_TIMEOUT_MS/profile tuning
    // above. Default raised to 10 minutes.
    const exploreTimeoutMs = parseIntSetting(await db.getSetting("CODING_AGENT_EXPLORE_TIMEOUT_MS"), 600_000);

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

    // Create an event emitter that broadcasts phase events over WebSocket.
    // Uses a mutable ref so the conversationId – set asynchronously in
    // onConversationStarted – is always the live value when emitEvent fires.
    let emitConversationId: number | undefined = reuseConversationId;

    const phaseEventEmitter: AgentEventEmitter = {
      emitChunk(chunk: string) {
        // Broadcast streaming chunks to all connected clients
        if (io) {
          io.emit("coding_agent_chunk", { chunk });
        }
      },
      emitEvent(event: any) {
        // Bridge into the same chat:event channel the frontend store already
        // listens to, so todo_items / phase / iteration events arrive live
        // instead of only after a page reload (the coding_agent_event channel
        // was never handled by the store). When the conversationId is not yet
        // known (first todos.reset() in CodingAgent.run happens before the
        // conversation is opened), the event is silently dropped – it will
        // still land in the DB via persistEvent and appear on reload.
        const cid = emitConversationId;
        if (io && cid !== undefined) {
          io.to(`conversation:${cid}`).emit("chat:event", {
            type: event.type,
            message: event.message,
            data: event.data,
            timestamp: event.timestamp,
            conversationId: cid,
          });
        }
      },
    };

    const requestedSandboxRoot = body.sandboxRoot ?? body.project;
    const codingAgent = createCodingAgent({
      ...(providerOverride ? { provider: providerOverride } : {}),
      // When only the project slug is provided (follow-up chat), use it as sandboxRoot;
      // the factory resolves it against CODING_ROOT. An explicit sandboxRoot from a plan
      // execution or initial run still wins.
      sandboxRoot: requestedSandboxRoot ? resolveCodingSandboxRoot(requestedSandboxRoot) : undefined,
      maxIterations: maxIterationsPerAttempt,
      eventEmitter: phaseEventEmitter,
      exploreTimeoutMs,
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
        ...(body.planOnly === true ? { planOnly: true } : {}),
        // Same chat:chunk channel/room the regular chat agent streams into - the frontend
        // store already accumulates these into `streamingContent` and shows them in the
        // "currently writing" bubble, with no coding-specific UI changes needed for this.
        onChunk: (chunk) => {
          const cid = emitConversationId;
          if (io && cid !== undefined) {
            io.to(`conversation:${cid}`).emit("chat:chunk", { content: chunk, conversationId: cid });
          }
        },
        onConversationStarted: (conversationId) => {
          emitConversationId = conversationId;
          runConversationId = conversationId;
          registerCodingRun(conversationId, codingAgent);
          agentRegistryRunId = agentRegistry.register({
            source: "chat_http",
            conversationId,
            label: "CodingAgent (HTTP)",
          });
          // Emit chat:start so the frontend store's isLoading flips to true.
          if (io) {
            io.to(`conversation:${conversationId}`).emit("coding_agent_started", { conversationId });
            io.to(`conversation:${conversationId}`).emit("chat:start", {
              timestamp: new Date().toISOString(),
              conversationId,
            });
          }
        },
      });

      // Emit chat:complete so the frontend store's isLoading flips back to false.
      if (io && emitConversationId !== undefined) {
        io.to(`conversation:${emitConversationId}`).emit("chat:complete", {
          response: result.summary,
          conversationId: emitConversationId,
        });
      }

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
