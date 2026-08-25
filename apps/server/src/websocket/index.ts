import { randomUUID } from "crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import type { Agent, AgentRunEvent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { isAbortError } from "@ducki/providers";
import { agentRegistry } from "../lib/agent-registry.js";
import { stopCodingRun } from "../lib/coding-run-registry.js";
import {
  createCheckpoint,
  createScopedFilesystemTool,
  discardNoopCheckpoint,
  pluginsRoot,
} from "@ducki/agent";
import { shouldRetryAgentRun } from "../lib/agent-retry.js";
import { deriveConversationTitle } from "../lib/conversation-title.js";
import { getScreenshotStorageManager } from "../lib/screenshot-storage.js";
import { browserTool, shellTool, CODING_WORKSPACE_ROOT } from "@ducki/tools";
import { wrapTools } from "../lib/tool-wrapper.js";

/**
 * Coding-area chats prepend a "[CODING_CONTEXT]\nproject=<slug>\n…" block to every
 * prompt. Extract the project slug so we can scope the agent's filesystem tool to
 * that project's sandbox — otherwise the general filesystem tool (rooted at the
 * shared workspace) writes relative paths to the wrong place. Returns undefined for
 * normal chats (no marker), which run completely unchanged.
 */
function extractCodingProjectSlug(message: string): string | undefined {
  if (typeof message !== "string" || !message.includes("[CODING_CONTEXT]")) return undefined;
  const match = message.match(/^\s*project=([^\r\n]+)/m);
  const slug = match?.[1]?.trim();
  if (!slug || slug.toLowerCase() === "none") return undefined;
  // Single path segment only — never let the slug escape the coding root.
  return /^[A-Za-z0-9_.-]+$/.test(slug) ? slug : undefined;
}

/** The client prepends the [CODING_CONTEXT] block; the user's own text follows the first
 *  blank line. Derive a readable checkpoint label from it (the raw prompt would start with
 *  the machine-facing scaffolding). */
function codingChatRunLabel(prompt: string): string {
  const body = prompt.replace(/^\[CODING_CONTEXT\][\s\S]*?\n\n/, "").trim().replace(/\s+/g, " ");
  return (body || prompt).slice(0, 60);
}

/** Actions the browser control panel (UI-initiated, not agent-initiated) may invoke directly. */
const ALLOWED_UI_BROWSER_ACTIONS = new Set([
  "list_sessions",
  "screenshot",
  "goto",
  "get_content",
  "click",
  "close",
  "stream_start",
  "stream_stop",
  "launch",
  "mouse_click",
  "mouse_drag",
  "scroll_by",
  "keyboard_type",
  "keyboard_press",
  "history_back",
  "history_forward",
  "reload",
]);


const logger = getRootLogger().child("WebSocket");

/** Bumped when the client/server event contract changes in an incompatible way. */
export const SERVER_PROTOCOL_VERSION = 1;

/**
 * Sockets that completed the handshake. A raw Socket.IO connection is not enough to
 * count as a client - a port scanner or a stale build opens one too - and telemetry
 * used to be broadcast unconditionally, including when nobody was listening.
 */
const readyClients = new Set<string>();

/**
 * In-memory map of sessionChatId → conversationId to prevent race conditions
 * when client sends multiple messages rapidly on a new chat.
 * Maps frontend-generated session IDs to actual conversation IDs.
 */
const sessionChatIdMap = new Map<string, number>();

/**
 * Prevent duplicate processing of the same first message when the client emits twice
 * (e.g. rapid key/button race or transient reconnect behavior).
 */
const processedChatMessageKeys = new Map<string, number>();
const CHAT_MESSAGE_DEDUP_TTL_MS = 2 * 60 * 1000;

/**
 * The bitcoin-puzzle feature moved to a plugin (apps/server/plugins/bitcoin-puzzle) with its
 * own polling frontend page - there is no push hook from plugin moduleTools into the core
 * socket.io stream, so the sidebar count regresses to a static 0 rather than a live number.
 * Kept as a function (not removed) so the two call sites below don't need reshaping.
 */
function runningPuzzleCount(): number {
  return 0;
}

/** Snapshot every freshly handshaken client receives, so it does not have to poll for it. */
function buildHelloSnapshot(gatewayStatus: unknown, runningConversationIds: number[] = []) {
  return {
    agents: { ...agentRegistry.snapshot(), bitcoinPuzzles: runningPuzzleCount() },
    gateway: gatewayStatus,
    // Conversations with an in-flight run right now. Lets a client that reconnects mid-run
    // (or reloads) restore its loading state instead of looking idle until the next event.
    runningConversationIds,
  };
}

export function setupWebSocket(
  io: SocketIOServer,
  createAgent: () => Promise<Agent>,
  db: DatabaseService,
  getGatewayStatus: () => unknown = () => undefined
): void {
  const activeAgentsBySocket = new Map<string, Set<Agent>>();
  // Prevent concurrent execution on the same conversation
  const runningConversations = new Map<number, Promise<void>>();
  // Serializes first-time conversation creation per frontend sessionChatId.
  const pendingSessionConversation = new Map<string, Promise<number>>();

  const cleanupProcessedChatMessageKeys = (): void => {
    const now = Date.now();
    for (const [key, ts] of processedChatMessageKeys) {
      if (now - ts > CHAT_MESSAGE_DEDUP_TTL_MS) {
        processedChatMessageKeys.delete(key);
      }
    }
  };

  const emitMetrics = (): void => {
    if (readyClients.size === 0) return;
    io.emit("agent:metrics", {
      ...agentRegistry.snapshot(),
      bitcoinPuzzles: runningPuzzleCount(),
      gateway: getGatewayStatus(),
    });
  };

  agentRegistry.subscribe(() => {
    // No listeners, no broadcast.
    emitMetrics();
  });

  /**
   * Gateway status and puzzle counts change outside the agent registry, so a pure
   * event-driven push would let them go stale. A slow tick covers them - but only while
   * somebody is actually listening: it starts on the first handshake and is torn down
   * when the last client leaves, so an idle server does no periodic work at all.
   * At 10s this is 6 messages/min against the 40 requests/min the client used to poll.
   */
  let metricsTicker: ReturnType<typeof setInterval> | null = null;

  const startMetricsTicker = (): void => {
    if (metricsTicker) return;
    metricsTicker = setInterval(emitMetrics, 10_000);
    logger.debug("Telemetry ticker started");
  };

  const stopMetricsTicker = (): void => {
    if (!metricsTicker) return;
    clearInterval(metricsTicker);
    metricsTicker = null;
    logger.debug("Telemetry ticker stopped");
  };

  const registerActiveAgent = (socketId: string, agent: Agent): void => {
    const bucket = activeAgentsBySocket.get(socketId) ?? new Set<Agent>();
    bucket.add(agent);
    activeAgentsBySocket.set(socketId, bucket);
  };

  const unregisterActiveAgent = (socketId: string, agent: Agent): void => {
    const bucket = activeAgentsBySocket.get(socketId);
    if (!bucket) return;
    bucket.delete(agent);
    if (bucket.size === 0) activeAgentsBySocket.delete(socketId);
  };

  const stopSocketAgents = (socketId: string): number => {
    const bucket = activeAgentsBySocket.get(socketId);
    if (!bucket || bucket.size === 0) return 0;
    for (const active of bucket) {
      active.stop();
    }
    return bucket.size;
  };

  io.on("connection", (socket) => {
    logger.debug("Socket opened", { id: socket.id });

    /**
     * Chat events are streamed to a per-conversation room instead of the single socket
     * that sent the message. A reconnect (transport upgrade, network hiccup, sleep,
     * remote/Tailscale) produces a *new* server-side socket; emitting to the old socket
     * reference would drop every remaining event of an in-flight run, which is why the UI
     * previously needed a manual reload to reveal the persisted answer. Room membership is
     * re-established by the client via `chat:join` on (re)connect, so the run keeps
     * reaching whatever socket currently represents this client (and any other tab viewing
     * the same conversation). Falls back to the originating socket when no conversation id
     * is known yet (e.g. an early failure before resolution).
     */
    const conversationRoom = (id: number): string => `conversation:${id}`;
    const emitToConversation = (
      id: number | undefined,
      event: string,
      payload: unknown
    ): void => {
      if (typeof id === "number") {
        io.to(conversationRoom(id)).emit(event, payload);
      } else {
        socket.emit(event, payload);
      }
    };

    // Re-join the conversation room after a reconnect (or when switching the active chat),
    // so live streaming survives the socket being replaced mid-run.
    socket.on("chat:join", (data?: { conversationId?: number }) => {
      if (typeof data?.conversationId === "number") {
        socket.join(conversationRoom(data.conversationId));
        logger.debug("Socket joined conversation room", {
          id: socket.id,
          conversationId: data.conversationId,
        });
      }
    });
    socket.on("chat:leave", (data?: { conversationId?: number }) => {
      if (typeof data?.conversationId === "number") {
        socket.leave(conversationRoom(data.conversationId));
      }
    });

    /**
     * Handshake. The client is only considered usable once it has announced itself and
     * received `server:hello`; until then it must not start issuing requests. The reply
     * carries the first snapshot, which replaces the burst of polls the client used to
     * fire on startup.
     */
    socket.on("client:hello", (data?: { clientId?: string; appVersion?: string }) => {
      readyClients.add(socket.id);
      startMetricsTicker();
      logger.info("Client ready", {
        id: socket.id,
        clientId: data?.clientId,
        appVersion: data?.appVersion,
        readyClients: readyClients.size,
      });
      socket.emit("server:hello", {
        protocolVersion: SERVER_PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        snapshot: buildHelloSnapshot(getGatewayStatus(), Array.from(runningConversations.keys())),
      });
    });

    // Chat with streaming
    socket.on("chat:message", async (data: {
      message: string;
      conversationId?: number;
      sessionChatId?: string;
      attachments?: Array<{ name: string; path?: string; url?: string; mimeType?: string }>;
      agentMode?: "full" | "plan";
      visionOnly?: boolean;
      localMessageId?: string;
    }) => {
      let registryRunId: string | undefined;
      const runAgents: Agent[] = [];
      // Tracked separately from the resolved id below so the catch block can still report
      // a conversationId even if the failure happened before resolution completed.
      let conversationId: number | undefined = data.conversationId;
      let resolveRun: (() => void) | undefined;
      try {
        // Idempotency guard: ignore duplicate emits of the same local message id.
        if (data.localMessageId) {
          cleanupProcessedChatMessageKeys();
          const scope = data.sessionChatId
            ? `session:${data.sessionChatId}`
            : data.conversationId
              ? `conversation:${data.conversationId}`
              : `socket:${socket.id}`;
          const dedupKey = `${scope}:${data.localMessageId}`;
          if (processedChatMessageKeys.has(dedupKey)) {
            logger.warn("Ignoring duplicate chat:message emit", {
              dedupKey,
              conversationId: data.conversationId,
              sessionChatId: data.sessionChatId,
            });
            return;
          }
          processedChatMessageKeys.set(dedupKey, Date.now());
        }

        // Determine the conversation directly via the database instead of spinning up a
        // throwaway Agent instance just to call startConversation()/loadConversation() -
        // that instance was previously discarded and never used to actually run the
        // message, which also meant the "Stop" button targeted the wrong agent.
        let resolvedConversationId: number;
        if (data.conversationId) {
          resolvedConversationId = data.conversationId;
        } else {
          // NEW: Check if we have a sessionChatId from the frontend
          // This prevents race conditions where multiple messages create multiple conversations
          let existingConvId = data.sessionChatId ? sessionChatIdMap.get(data.sessionChatId) : undefined;

          if (existingConvId) {
            // Already created a conversation for this session in this server instance
            resolvedConversationId = existingConvId;
          } else {
            if (data.sessionChatId) {
              // Serialize createConversation for this logical new-chat session.
              const pending = pendingSessionConversation.get(data.sessionChatId);
              if (pending) {
                resolvedConversationId = await pending;
              } else {
                const creationPromise = (async () => {
                  const conv = await db.createConversation({
                    name: deriveConversationTitle(data.message),
                  });
                  sessionChatIdMap.set(data.sessionChatId!, conv.id);
                  return conv.id;
                })();
                pendingSessionConversation.set(data.sessionChatId, creationPromise);
                try {
                  resolvedConversationId = await creationPromise;
                } finally {
                  pendingSessionConversation.delete(data.sessionChatId);
                }
              }
            } else {
              // Fallback path without session id.
              const conv = await db.createConversation({
                name: deriveConversationTitle(data.message),
              });
              resolvedConversationId = conv.id;
            }
          }
          socket.emit("chat:conversation", { conversationId: resolvedConversationId });
        }
        conversationId = resolvedConversationId;

        // Join the room now so every streamed event below reaches this client even if the
        // underlying socket is replaced by a reconnect mid-run.
        socket.join(conversationRoom(resolvedConversationId));

        // Wait for any running conversation to complete (prevent concurrent execution)
        const existingRun = runningConversations.get(resolvedConversationId);
        if (existingRun) {
          logger.info("Conversation already running, waiting for completion", { conversationId: resolvedConversationId });
          await existingRun;
        }

        // Create a promise to track this execution
        const runPromise = new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
        runningConversations.set(resolvedConversationId, runPromise);

        registryRunId = agentRegistry.register({
          source: "chat_ws",
          socketId: socket.id,
          conversationId: resolvedConversationId,
          label: "WebSocket Chat",
        });

        emitToConversation(resolvedConversationId, "chat:start", { timestamp: new Date().toISOString(), conversationId: resolvedConversationId });

        let attemptProducedOutput = false;

        // PLAN_MODE_ENABLED gates the "plan" agentMode (structured planning without tool
        // execution) - default on, but an admin can turn it off to force every request
        // through the normal full run instead.
        let requestedAgentMode = data.agentMode;
        if (requestedAgentMode === "plan") {
          const planModeSetting = await db.getSetting("PLAN_MODE_ENABLED");
          const planModeEnabled = planModeSetting === undefined || planModeSetting === null
            ? true
            : planModeSetting.toLowerCase() !== "false";
          if (!planModeEnabled) {
            requestedAgentMode = "full";
          }
        }

        const runOptions = {
          stream: true,
          attachments: data.attachments,
          agentMode: requestedAgentMode,
          visionOnly: data.visionOnly,
          localMessageId: data.localMessageId,
          onChunk: (chunk: string) => {
            attemptProducedOutput = true;
            emitToConversation(resolvedConversationId, "chat:chunk", { content: chunk, conversationId: resolvedConversationId });
          },
          onEvent: async (event: AgentRunEvent) => {
              attemptProducedOutput = true;
              const eventToEmit = { ...event };

              // Timeline events go out FIRST, before any awaiting work below. Screenshot
              // storage used to run before this emit, which held the browser_preview event
              // back for the duration of a disk write while every later event (tool_result,
              // reasoning) took the synchronous path and overtook it - the screenshot then
              // appeared in the transcript after steps that happened after it. The client
              // renders the inline base64 when no stored URL is present, so emitting early
              // costs nothing; the stored URL still reaches the tool-event stream below.
              emitToConversation(resolvedConversationId, "chat:event", { ...eventToEmit, conversationId: resolvedConversationId });

              // Auto-handle large screenshots: store to disk if > 150KB
              if (event.type === "browser_preview" && event.data) {
                // Try multiple possible keys for screenshot data
                const screenshotBase64 =
                  (event.data.screenshot as string | undefined) ||
                  (event.data.image as string | undefined) ||
                  (event.data.imageData as string | undefined) ||
                  (event.data.buffer as string | undefined);

                logger.debug("browser_preview event received", {
                  hasScreenshot: !!screenshotBase64,
                  screenshotSize: screenshotBase64 ? `${screenshotBase64.length}B` : "none",
                  eventDataKeys: Object.keys(event.data),
                  url: event.data.url,
                });

                if (screenshotBase64 && screenshotBase64.length > 100) { // Sanity check
                  try {
                    const manager = getScreenshotStorageManager();
                    const screenshotFormat = (event.data.format as string | undefined) ?? "jpeg";
                    const mimeType = `image/${screenshotFormat}`;
                    const result = await manager.handleScreenshot(screenshotBase64, mimeType);

                    if (result.isStored) {
                      // Add storage URL (keep original screenshot data for chat display)
                      (eventToEmit.data ??= {}).screenshotUrl = result.url;
                      (eventToEmit.data ??= {}).screenshotStorageUrl = result.url;
                      (eventToEmit.data ??= {}).screenshotSize = result.size;

                      logger.info("Screenshot auto-stored", {
                        size: `${Math.round(result.size / 1024)}KB`,
                        url: result.url,
                      });
                    }
                  } catch (error) {
                    logger.error("Screenshot storage failed", { error });
                  }
                }
              }

              // Emit browser_preview as tool events for ToolEventsDisplay
              if (event.type === "browser_preview") {
                logger.debug("Emitting browser_preview as tool events", {
                  conversationId: resolvedConversationId,
                  hasScreenshot: !!(eventToEmit.data as any)?.screenshotStorageUrl,
                });

                // Emit tool-start first (if not already started)
                emitToConversation(resolvedConversationId, "chat:tool-event", {
                  type: "tool-start",
                  toolName: "Browser",
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                });

                // Then emit tool-complete with screenshot data
                emitToConversation(resolvedConversationId, "chat:tool-event", {
                  type: "tool-complete",
                  toolName: "Browser",
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                  data: {
                    url: (eventToEmit.data as any)?.url,
                    screenshotUrl: (eventToEmit.data as any)?.screenshotStorageUrl || (eventToEmit.data as any)?.screenshotUrl,
                    screenshotSize: (eventToEmit.data as any)?.screenshotSize,
                  },
                });

                logger.debug("Browser tool events emitted");
              }

              // Emit tool call events separately for UI tracking
              if (event.type === "tool_call") {
                emitToConversation(resolvedConversationId, "tool:call_started", {
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                  data: event.data,
                });
              }

              // Emit tool result events to update tool call status in UI
              if (event.type === "tool_result") {
                logger.debug("Emitting tool:call_completed", {
                  toolName: (event.data as any)?.toolName,
                  callId: (event.data as any)?.callId,
                  success: (event.data as any)?.success,
                });
                emitToConversation(resolvedConversationId, "tool:call_completed", {
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                  data: {
                    toolName: (event.data as any)?.toolName,
                    callId: (event.data as any)?.callId,
                    success: (event.data as any)?.success,
                    error: (event.data as any)?.error,
                    summary: (event.data as any)?.summary,
                    disposition: (event.data as any)?.disposition,
                  },
                });
              }

              // Emit iteration metrics for real-time token tracking
              if (event.type === "iteration" && event.data) {
                const iterationData = event.data as Record<string, unknown>;
                const llmTokens = iterationData.llmTokens as { input?: number; output?: number; total?: number } | undefined;

                if (llmTokens) {
                  emitToConversation(resolvedConversationId, "agent:iteration-metrics", {
                    timestamp: event.timestamp,
                    conversationId: resolvedConversationId,
                    iterationNumber: iterationData.iterationNumber,
                    inputTokens: llmTokens.input,
                    outputTokens: llmTokens.output,
                    totalTokens: llmTokens.total,
                  });
                }
              }
          },
        };

        const runAttempt = async (prompt: string) => {
          const runAgent = await createAgent();

          // Coding-area chat: scope the filesystem tool to the project sandbox so
          // relative paths land in shared-workspace/coding/<project>/ instead of the
          // shared-workspace root. registerTool overrides the general "filesystem"
          // tool by name; wrapTools keeps the same event/staging behaviour as the
          // other tools. Normal chats skip this entirely.
          const codingSlug = extractCodingProjectSlug(prompt);
          let sandboxRoot: string | undefined;
          if (codingSlug) {
            // A [CODING_CONTEXT] project slug normally names a Coding Area project under
            // CODING_WORKSPACE_ROOT, but the same marker is reused (see plugin-context tagging
            // in routes/plugins.ts create-run) to continue an agent-authored plugin's own
            // conversation - those live under plugins/<slug>/ instead. Try the coding-workspace
            // path first (unchanged behavior for real projects), fall back to the plugins root
            // only if that doesn't exist.
            const codingProjectRoot = resolve(CODING_WORKSPACE_ROOT, codingSlug);
            const pluginRoot = resolve(pluginsRoot(), codingSlug);
            sandboxRoot = existsSync(codingProjectRoot) ? codingProjectRoot
              : existsSync(pluginRoot) ? pluginRoot
              : codingProjectRoot;
            const [scopedFs] = wrapTools([createScopedFilesystemTool(sandboxRoot)]);
            if (scopedFs) {
              runAgent.executor.registerTool(scopedFs);
              logger.info("Scoped coding filesystem tool for chat run", { codingSlug, sandboxRoot });
            }
          }

          // The Changes tab ("Änderungen") is backed by per-run checkpoints: a shadow-git
          // snapshot taken BEFORE the run, so the diff against it shows exactly what this
          // turn changed. The plan-execution path (CodingAgent) already does this per
          // attempt; the coding-area chat runs through the REGULAR agent, which never
          // snapshotted - so the tab stayed empty for the primary way users drive the
          // coding agent. Snapshot before every coding chat run. A turn that changed nothing
          // (question, explanation) has its empty checkpoint discarded again afterwards, so
          // the Changes tab only ever lists runs that actually touched files.
          const checkpoint = sandboxRoot
            ? await createCheckpoint(sandboxRoot, `Before chat run: ${codingChatRunLabel(prompt)}`)
            : undefined;

          try {
            registerActiveAgent(socket.id, runAgent);
            runAgents.push(runAgent);
            await runAgent.loadConversation(resolvedConversationId);
            return await runAgent.run(prompt, runOptions);
          } finally {
            // No-op cleanup runs on every exit path (success, failure, user Stop). The
            // "Checkpoint erstellt" decision event is emitted only when the snapshot
            // survives - a discarded one never existed from the user's point of view.
            if (checkpoint) {
              const discarded = await discardNoopCheckpoint(sandboxRoot!, checkpoint.sha);
              if (!discarded) {
                emitToConversation(resolvedConversationId, "chat:event", {
                  type: "decision",
                  message: "Checkpoint vor diesem Lauf erstellt.",
                  data: {
                    checkpoint_sha: checkpoint.sha,
                    checkpoint_label: checkpoint.label,
                  },
                  timestamp: new Date().toISOString(),
                  conversationId: resolvedConversationId,
                });
              } else {
                logger.info("Discarded no-op chat-run checkpoint", {
                  project: codingSlug,
                  sha: checkpoint.sha.slice(0, 8),
                });
              }
            }
          }
        };

        const checkpointRows = await db.getMessagesPage({
          conversationId: resolvedConversationId,
          limit: 1,
        });
        const checkpointMessageId = checkpointRows[0]?.id ?? 0;

        let result;
        try {
          attemptProducedOutput = false;
          result = await runAttempt(data.message);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!shouldRetryAgentRun(errorMessage)) {
            throw error;
          }

          if (attemptProducedOutput) {
            // The user already received streamed output/events from attempt 1.
            // Retrying here would duplicate visible timeline entries and tool calls.
            logger.warn("Skipping websocket retry because first attempt already emitted output", {
              conversationId: resolvedConversationId,
              error: errorMessage,
            });
            throw error;
          }

          const latestRows = await db.getMessagesPage({
            conversationId: resolvedConversationId,
            limit: 1,
          });
          const latestMessageId = latestRows[0]?.id ?? checkpointMessageId;

          if (latestMessageId > checkpointMessageId) {
            await db.deleteMessagesAfter(resolvedConversationId, checkpointMessageId);
            logger.warn("Rolled back partial first attempt before retry", {
              conversationId: resolvedConversationId,
              checkpointMessageId,
              latestMessageId,
            });
          }

          const retryPrompt = [
            "The previous websocket chat run failed with a runtime error.",
            `Error: ${errorMessage}`,
            "Restart from scratch with a fresh solution path.",
            data.message,
          ].join("\n");

          attemptProducedOutput = false;
          result = await runAttempt(retryPrompt);
        }

        emitToConversation(resolvedConversationId, "chat:complete", {
          ...result,
          conversationId: resolvedConversationId,
          // Stable per-turn id so the client can deterministically collapse duplicate completes.
          messageId: data.localMessageId || randomUUID(),
          // The client used to stamp its own receive time here. Every other entry in the
          // transcript is stamped by the server, and the client sorts them all together, so a
          // client clock running behind the server's sorted the final answer above the tool
          // calls it came from - very visible over a remote/VPN connection between machines.
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // An intentional Stop already got its own "chat:stopped" notice from the chat:stop
        // handler - surfacing this rejection too would show a confusing second, contradictory
        // "error" message for what the user asked for on purpose.
        if (!isAbortError(error)) {
          emitToConversation(conversationId, "chat:error", {
            error: error instanceof Error ? error.message : String(error),
            conversationId,
            timestamp: new Date().toISOString(),
          });
        }
      } finally {
        if (registryRunId) {
          agentRegistry.unregister(registryRunId);
        }
        for (const runAgent of runAgents) {
          unregisterActiveAgent(socket.id, runAgent);
        }
        // Clear the conversation lock
        if (conversationId && runningConversations.has(conversationId)) {
          runningConversations.delete(conversationId);
          resolveRun!();
        }
      }
    });

    socket.on("chat:stop", (data?: { conversationId?: number }) => {
      stopSocketAgents(socket.id);
      // A CodingAgent run started from an HTTP route (plugin creation, /api/coding-agent/run)
      // has no socket of its own to be found by stopSocketAgents above - it's tracked by
      // conversationId instead (see coding-run-registry.ts), which the client already sends here.
      if (typeof data?.conversationId === "number") stopCodingRun(data.conversationId);
      emitToConversation(data?.conversationId, "chat:stopped", { timestamp: new Date().toISOString(), conversationId: data?.conversationId });
    });

    // Live browser preview: a client joins a session's room to receive its CDP screencast
    // frames (relayed from packages/tools' browserFrameEvents in index.ts). Starting/stopping
    // the actual screencast is a normal tool call (action=stream_start/stream_stop) - this is
    // purely the delivery side, so any number of viewers can watch the same session at once.
    socket.on("browser:stream:join", (data?: { sessionId?: string }) => {
      const sessionId = String(data?.sessionId ?? "").trim();
      if (!sessionId) return;
      socket.join(`browser-stream:${sessionId}`);
    });
    socket.on("browser:stream:leave", (data?: { sessionId?: string }) => {
      const sessionId = String(data?.sessionId ?? "").trim();
      if (!sessionId) return;
      socket.leave(`browser-stream:${sessionId}`);
    });

    // Task updates
    socket.on("tasks:subscribe", () => {
      socket.join("tasks");
      logger.debug("Client subscribed to tasks", { id: socket.id });
    });

    // Agent status
    socket.on("agent:status", () => {
      const running = activeAgentsBySocket.get(socket.id)?.size ?? 0;
      socket.emit("agent:status", { status: running > 0 ? "running" : "idle", runningAgents: running });
      socket.emit("agent:metrics", agentRegistry.snapshot());
    });

    // Browser preview events
    socket.on("browser:preview", (data: { tabId?: string; serverId?: string; url?: string; screenshot?: string; htmlContent?: string; conversationId?: number }) => {
      if (data.conversationId) {
        socket.emit("browser:preview", {
          ...data,
          isStreaming: true,
        });
      }
    });

    socket.on("browser:stop", async (data: { tabId?: string; serverId?: string }, callback?: (result: unknown) => void) => {
      const sessionId = data.tabId || data.serverId;
      if (!sessionId) {
        callback?.({ success: false, error: "No session id provided" });
        return;
      }
      logger.info("Browser stop requested", { sessionId });
      const result = await browserTool.execute({ action: "close", sessionId });
      callback?.(result);
    });

    // Live control panel for the shared browser session(s) - lets the UI list, screenshot,
    // navigate, and close sessions directly, reusing the same worker/session pool the
    // agent's browser tool calls use.
    socket.on("browser:list", async (_data: unknown, callback?: (result: unknown) => void) => {
      const result = await browserTool.execute({ action: "list_sessions" });
      callback?.(result);
    });

    socket.on(
      "browser:control",
      async (data: Record<string, unknown>, callback?: (result: unknown) => void) => {
        const action = String(data?.["action"] ?? "").trim();
        if (!ALLOWED_UI_BROWSER_ACTIONS.has(action)) {
          callback?.({ success: false, error: `Action '${action}' is not allowed from the UI control panel` });
          return;
        }
        const result = await browserTool.execute({ ...data, action, actor: "user" });
        callback?.(result);
      }
    );

    // Uses the same singleton shell tool as the agent, so background processes and output
    // remain mutually visible instead of living in an isolated UI-only terminal.
    socket.on(
      "shell:control",
      async (data: Record<string, unknown>, callback?: (result: unknown) => void) => {
        const result = await shellTool.execute({ ...data, cwd: data["cwd"] || process.cwd() });
        callback?.(result);
      }
    );


    socket.on("disconnect", () => {
      stopSocketAgents(socket.id);
      activeAgentsBySocket.delete(socket.id);
      const wasReady = readyClients.delete(socket.id);
      if (wasReady) {
        logger.info("Client disconnected", { id: socket.id, readyClients: readyClients.size });
        if (readyClients.size === 0) {
          stopMetricsTicker();
          logger.info("No clients left - telemetry broadcasts paused until the next handshake");
        }
      } else {
        logger.debug("Socket closed without handshake", { id: socket.id });
      }
    });
  });
}

/** Number of clients that completed the handshake - used to gate broadcast work. */
export function readyClientCount(): number {
  return readyClients.size;
}

/** Tells connected clients to stop immediately instead of waiting for a socket timeout. */
export function broadcastServerShutdown(io: SocketIOServer): void {
  if (readyClients.size === 0) return;
  io.emit("server:bye", { reason: "shutdown", timestamp: new Date().toISOString() });
}

export function broadcastTaskUpdate(io: SocketIOServer, task: unknown): void {
  io.to("tasks").emit("task:updated", task);
}

/** Broadcast a settings change so clients can invalidate instead of polling for it. */
export function broadcastSettingsChanged(io: SocketIOServer, keys?: string[]): void {
  if (readyClients.size === 0) return;
  io.emit("settings:changed", { keys, timestamp: new Date().toISOString() });
}
