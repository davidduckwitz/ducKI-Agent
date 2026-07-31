import type { Server as SocketIOServer } from "socket.io";
import type { Agent, AgentRunEvent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { agentRegistry } from "../lib/agent-registry.js";
import { BitcoinPuzzleService } from "@ducki/agent";
import { runAgentWithRepairRetry } from "../lib/agent-retry.js";
import { deriveConversationTitle } from "../lib/conversation-title.js";
import { getScreenshotStorageManager } from "../lib/screenshot-storage.js";

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
 * The sidebar needs the running-puzzle count alongside the agent metrics; it used to get
 * it from /agents/live, which is the poll this push replaces.
 */
function runningPuzzleCount(): number {
  try {
    return BitcoinPuzzleService.getInstance().getRunningPuzzlesCount();
  } catch {
    return 0;
  }
}

/** Snapshot every freshly handshaken client receives, so it does not have to poll for it. */
function buildHelloSnapshot(gatewayStatus: unknown) {
  return {
    agents: { ...agentRegistry.snapshot(), bitcoinPuzzles: runningPuzzleCount() },
    gateway: gatewayStatus,
  };
}

export function setupWebSocket(
  io: SocketIOServer,
  createAgent: () => Agent,
  db: DatabaseService,
  getGatewayStatus: () => unknown = () => undefined
): void {
  const activeAgentsBySocket = new Map<string, Set<Agent>>();

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
        snapshot: buildHelloSnapshot(getGatewayStatus()),
      });
    });

    // Chat with streaming
    socket.on("chat:message", async (data: {
      message: string;
      conversationId?: number;
      attachments?: Array<{ name: string; path?: string; url?: string; mimeType?: string }>;
      agentMode?: "full" | "plan";
    }) => {
      let registryRunId: string | undefined;
      const runAgents: Agent[] = [];
      // Tracked separately from the resolved id below so the catch block can still report
      // a conversationId even if the failure happened before resolution completed.
      let conversationId: number | undefined = data.conversationId;
      try {
        // Determine the conversation directly via the database instead of spinning up a
        // throwaway Agent instance just to call startConversation()/loadConversation() -
        // that instance was previously discarded and never used to actually run the
        // message, which also meant the "Stop" button targeted the wrong agent.
        let resolvedConversationId: number;
        if (data.conversationId) {
          resolvedConversationId = data.conversationId;
        } else {
          const conv = await db.createConversation({
            name: deriveConversationTitle(data.message),
          });
          resolvedConversationId = conv.id;
          socket.emit("chat:conversation", { conversationId: resolvedConversationId });
        }
        conversationId = resolvedConversationId;

        registryRunId = agentRegistry.register({
          source: "chat_ws",
          socketId: socket.id,
          conversationId: resolvedConversationId,
          label: "WebSocket Chat",
        });

        socket.emit("chat:start", { timestamp: new Date().toISOString(), conversationId: resolvedConversationId });

        const result = await runAgentWithRepairRetry(
          createAgent,
          data.message,
          (errorMessage) => [
            "The previous websocket chat run failed with a runtime error.",
            `Error: ${errorMessage}`,
            "Restart from scratch with a fresh solution path.",
            data.message,
          ].join("\n"),
          async (runAgent) => {
            registerActiveAgent(socket.id, runAgent);
            runAgents.push(runAgent);
            await runAgent.loadConversation(resolvedConversationId);
          },
          {
            stream: true,
            attachments: data.attachments,
            agentMode: data.agentMode,
            onChunk: (chunk) => {
              socket.emit("chat:chunk", { content: chunk, conversationId: resolvedConversationId });
            },
            onEvent: async (event: AgentRunEvent) => {
              const eventToEmit = { ...event };

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
                    const result = await manager.handleScreenshot(screenshotBase64, "image/png");

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

              socket.emit("chat:event", { ...eventToEmit, conversationId: resolvedConversationId });

              // Emit browser_preview as tool events for ToolEventsDisplay
              if (event.type === "browser_preview") {
                logger.debug("Emitting browser_preview as tool events", {
                  conversationId: resolvedConversationId,
                  hasScreenshot: !!(eventToEmit.data as any)?.screenshotStorageUrl,
                });

                // Emit tool-start first (if not already started)
                socket.emit("chat:tool-event", {
                  type: "tool-start",
                  toolName: "Browser",
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                });

                // Then emit tool-complete with screenshot data
                socket.emit("chat:tool-event", {
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
                socket.emit("tool:call_started", {
                  timestamp: event.timestamp,
                  conversationId: resolvedConversationId,
                  data: event.data,
                });
              }

              // Emit iteration metrics for real-time token tracking
              if (event.type === "iteration" && event.data) {
                const iterationData = event.data as Record<string, unknown>;
                const llmTokens = iterationData.llmTokens as { input?: number; output?: number; total?: number } | undefined;

                if (llmTokens) {
                  socket.emit("agent:iteration-metrics", {
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
          }
        );

        socket.emit("chat:complete", { ...result.result, conversationId: resolvedConversationId });
      } catch (error) {
        socket.emit("chat:error", {
          error: error instanceof Error ? error.message : String(error),
          conversationId,
        });
      } finally {
        if (registryRunId) {
          agentRegistry.unregister(registryRunId);
        }
        for (const runAgent of runAgents) {
          unregisterActiveAgent(socket.id, runAgent);
        }
      }
    });

    socket.on("chat:stop", (data?: { conversationId?: number }) => {
      stopSocketAgents(socket.id);
      socket.emit("chat:stopped", { timestamp: new Date().toISOString(), conversationId: data?.conversationId });
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

    socket.on("browser:stop", (data: { serverId?: string }) => {
      if (data.serverId) {
        logger.info("Browser stop requested", { serverId: data.serverId });
      }
    });

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
