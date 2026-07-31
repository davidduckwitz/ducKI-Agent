import type { Logger } from "@ducki/logger";
import type { Server as SocketIOServer } from "socket.io";

export interface ToolEvent {
  type: "tool-start" | "tool-progress" | "tool-complete" | "tool-error" | "tool-warning";
  toolName: string;
  timestamp: Date;
  conversationId?: string;
  data?: Record<string, unknown>;
}

/**
 * Broadcasts tool execution events to WebSocket
 * Enables real-time chat updates showing tool progress
 */
export class ChatToolEventBroadcaster {
  constructor(
    private readonly logger: Logger,
    private readonly io: SocketIOServer
  ) {}

  /**
   * Broadcast tool start event
   */
  broadcastToolStart(
    toolName: string,
    conversationId?: string,
    params?: Record<string, unknown>
  ): void {
    const event: ToolEvent = {
      type: "tool-start",
      toolName,
      timestamp: new Date(),
      conversationId,
      data: {
        status: "started",
        params,
      },
    };

    this.broadcast(event);
    this.logger.debug("Tool started", { toolName, conversationId });
  }

  /**
   * Broadcast tool progress event
   */
  broadcastToolProgress(
    toolName: string,
    progress: string,
    conversationId?: string
  ): void {
    const event: ToolEvent = {
      type: "tool-progress",
      toolName,
      timestamp: new Date(),
      conversationId,
      data: {
        status: "running",
        progress,
      },
    };

    this.broadcast(event);
  }

  /**
   * Broadcast tool completion event
   */
  broadcastToolComplete(
    toolName: string,
    summary: string,
    conversationId?: string,
    metadata?: {
      duration?: number;
      outputSize?: number;
      staged?: boolean;
      stagingId?: string;
    }
  ): void {
    const event: ToolEvent = {
      type: "tool-complete",
      toolName,
      timestamp: new Date(),
      conversationId,
      data: {
        status: "completed",
        summary,
        ...metadata,
      },
    };

    this.broadcast(event);
    this.logger.debug("Tool completed", {
      toolName,
      conversationId,
      duration: metadata?.duration,
    });
  }

  /**
   * Broadcast tool error event
   */
  broadcastToolError(
    toolName: string,
    error: string,
    conversationId?: string
  ): void {
    const event: ToolEvent = {
      type: "tool-error",
      toolName,
      timestamp: new Date(),
      conversationId,
      data: {
        status: "error",
        error,
      },
    };

    this.broadcast(event);
    this.logger.error("Tool error", { toolName, conversationId, error });
  }

  /**
   * Broadcast tool warning event (e.g., timeout warning)
   */
  broadcastToolWarning(
    toolName: string,
    warning: string,
    elapsedTime?: number,
    conversationId?: string
  ): void {
    const event: ToolEvent = {
      type: "tool-warning",
      toolName,
      timestamp: new Date(),
      conversationId,
      data: {
        status: "warning",
        warning,
        elapsedTime,
      },
    };

    this.broadcast(event);
    this.logger.warn("Tool warning", { toolName, conversationId, warning, elapsedTime });
  }

  /**
   * Internal: broadcast to all connected clients
   */
  private broadcast(event: ToolEvent): void {
    // Broadcast to all clients
    this.io.emit("chat:tool-event", event);

    // Also broadcast to conversation-specific room if available
    if (event.conversationId) {
      this.io.to(`conversation:${event.conversationId}`).emit("chat:tool-event", event);
    }
  }
}

let globalBroadcaster: ChatToolEventBroadcaster | undefined;

export function getChatToolEventBroadcaster(): ChatToolEventBroadcaster | undefined {
  return globalBroadcaster;
}

export function initChatToolEventBroadcaster(
  logger: Logger,
  io: SocketIOServer
): ChatToolEventBroadcaster {
  globalBroadcaster = new ChatToolEventBroadcaster(logger, io);
  return globalBroadcaster;
}
