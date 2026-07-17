import type { Server as SocketIOServer } from "socket.io";
import type { Agent, AgentRunEvent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { agentRegistry } from "../lib/agent-registry.js";

const logger = getRootLogger().child("WebSocket");

function readEnabledSkillSlugs(rawValue: string | null | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0 && /^[a-z0-9_-]+$/.test(item));
  } catch {
    return [];
  }
}

function withEnabledSkillsPrefix(message: string, enabledSkills: string[]): string {
  if (enabledSkills.length === 0) return message;
  const prefix = enabledSkills.map((slug) => `/${slug}`).join(" ");
  return `${prefix} ${message}`.trim();
}

export function setupWebSocket(
  io: SocketIOServer,
  createAgent: () => Agent,
  db: DatabaseService
): void {
  const activeAgentsBySocket = new Map<string, Set<Agent>>();

  const registerActiveAgent = (socketId: string, agent: Agent): void => {
    const bucket = activeAgentsBySocket.get(socketId) ?? new Set<Agent>();
    bucket.add(agent);
    activeAgentsBySocket.set(socketId, bucket);
  };

  const emitLiveMetrics = (): void => {
    io.emit("agent:metrics", agentRegistry.snapshot());
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
      const agent = createAgent();
      registerActiveAgent(socket.id, agent);
      let registryRunId: string | undefined;
      try {
        let conversationId: number;
        if (data.conversationId) {
          await agent.loadConversation(data.conversationId);
          conversationId = data.conversationId;
        } else {
          const convId = await agent.startConversation();
          socket.emit("chat:conversation", { conversationId: convId });
          conversationId = convId;
        }

        registryRunId = agentRegistry.register({
          source: "chat_ws",
          socketId: socket.id,
          conversationId,
          label: "WebSocket Chat",
        });
        emitLiveMetrics();

        socket.emit("chat:start", { timestamp: new Date().toISOString() });

        const enabledSkills = readEnabledSkillSlugs(await db.getSetting("ENABLED_SKILLS"));
        const finalMessage = withEnabledSkillsPrefix(data.message, enabledSkills);

        const result = await agent.run(finalMessage, {
          stream: true,
          onChunk: (chunk) => {
            socket.emit("chat:chunk", { content: chunk });
          },
          onEvent: (event: AgentRunEvent) => {
            socket.emit("chat:event", event);
          },
        });

        socket.emit("chat:complete", result);
      } catch (error) {
        socket.emit("chat:error", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (registryRunId) {
          agentRegistry.unregister(registryRunId);
          emitLiveMetrics();
        }
        unregisterActiveAgent(socket.id, agent);
      }
    });

    socket.on("chat:stop", () => {
      stopSocketAgents(socket.id);
      socket.emit("chat:stopped", { timestamp: new Date().toISOString() });
      emitLiveMetrics();
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
      emitLiveMetrics();
    });
  });
}

export function broadcastTaskUpdate(io: SocketIOServer, task: unknown): void {
  io.to("tasks").emit("task:updated", task);
}
