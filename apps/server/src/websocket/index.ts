import type { Server as SocketIOServer } from "socket.io";
import type { Agent, AgentRunEvent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { agentRegistry } from "../lib/agent-registry.js";
import { runAgentWithRepairRetry } from "../lib/agent-retry.js";

const logger = getRootLogger().child("WebSocket");

export function setupWebSocket(
  io: SocketIOServer,
  createAgent: () => Agent,
  db: DatabaseService
): void {
  const activeAgentsBySocket = new Map<string, Set<Agent>>();

  agentRegistry.subscribe((snapshot) => {
    io.emit("agent:metrics", snapshot);
  });

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
    logger.info("Client connected", { id: socket.id });

    // Chat with streaming
    socket.on("chat:message", async (data: { message: string; conversationId?: number }) => {
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
            name: `Conversation ${new Date().toLocaleString()}`,
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
            onChunk: (chunk) => {
              socket.emit("chat:chunk", { content: chunk, conversationId: resolvedConversationId });
            },
            onEvent: (event: AgentRunEvent) => {
              socket.emit("chat:event", { ...event, conversationId: resolvedConversationId });
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

    socket.on("disconnect", () => {
      stopSocketAgents(socket.id);
      activeAgentsBySocket.delete(socket.id);
      logger.info("Client disconnected", { id: socket.id });
    });
  });
}

export function broadcastTaskUpdate(io: SocketIOServer, task: unknown): void {
  io.to("tasks").emit("task:updated", task);
}
