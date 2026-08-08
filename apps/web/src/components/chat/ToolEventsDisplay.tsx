import { useEffect, useRef, useState } from "react";
import { Loader, CheckCircle, AlertCircle, Zap, X, AlertTriangle } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { ToolEventSummary } from "./ToolEventSummary";
import { BrowserPreview } from "./BrowserPreview";
import type { RenderedChatMessage } from "./chatTypes";

interface ToolEvent {
  type: "tool-start" | "tool-progress" | "tool-complete" | "tool-error" | "tool-warning";
  toolName: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

interface ToolEventSummaryState {
  events: ToolEvent[];
  timestamp: Date;
  id: string;
}

export function ToolEventsDisplay({
  conversationId,
  socket,
  onToolExecutionComplete,
}: {
  conversationId: string;
  socket: any;
  onToolExecutionComplete?: (summary: ToolEventSummaryState) => void;
}) {
  const { setRunningTools } = useAppStore();
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());
  const [completedSummary, setCompletedSummary] = useState<ToolEventSummaryState | null>(null);
  const [browserPreviewData, setBrowserPreviewData] = useState<any>(null);
  const previousActiveToolsRef = useRef<Set<string>>(new Set());

  // Clear events when conversation changes to prevent old tool calls from bleeding through
  useEffect(() => {
    setEvents([]);
    setCompletedSummary(null);
    setBrowserPreviewData(null);
  }, [conversationId]);

  useEffect(() => {
    if (!socket) return;

    const handleToolEvent = (event: ToolEvent) => {
      // Debug: Log event reception
      console.debug("[ToolEventsDisplay] chat:tool-event received", {
        toolName: (event as any).toolName,
        type: (event as any).type,
        eventConversationId: (event as any).conversationId,
        expectedConversationId: conversationId,
        conversationIdMatch: !((event as any).conversationId && (event as any).conversationId !== conversationId),
      });

      // Only show events for this conversation
      if ((event as any).conversationId && (event as any).conversationId !== conversationId) {
        console.debug("[ToolEventsDisplay] Filtering out event - conversation ID mismatch");
        return;
      }

      const eventWithDate = { ...event, timestamp: new Date(event.timestamp) };
      setEvents((prev) => [...prev, eventWithDate].slice(-10)); // Keep last 10 events
      console.debug("[ToolEventsDisplay] Event added to state", { toolName: eventWithDate.toolName, type: eventWithDate.type });

      // Capture browser preview data
      if (eventWithDate.toolName === "Browser" && eventWithDate.type === "tool-complete" && event.data) {
        setBrowserPreviewData({
          url: (event.data as any).url,
          screenshotStorageUrl: (event.data as any).screenshotUrl,
          screenshotUrl: (event.data as any).screenshotUrl,
          screenshotSize: (event.data as any).screenshotSize,
        });
      }

      // Track active tools. The updater MUST stay pure - it runs during React's render phase, so
      // calling another component's setState (setRunningTools, which RecentChatsSection subscribes to)
      // from inside it triggered "Cannot update a component while rendering a different component".
      // The global store is synced from activeTools in the effect below instead.
      setActiveTools((prev) => {
        const next = new Set(prev);
        if (eventWithDate.type === "tool-start") {
          next.add(eventWithDate.toolName);
        } else if (eventWithDate.type === "tool-complete" || eventWithDate.type === "tool-error") {
          next.delete(eventWithDate.toolName);
        }
        return next;
      });
    };

    socket.on("chat:tool-event", handleToolEvent);
    return () => socket.off("chat:tool-event", handleToolEvent);
  }, [socket, conversationId]);

  // Mirror the local active-tools set into the global store AFTER commit, never during render.
  useEffect(() => {
    setRunningTools(activeTools);
  }, [activeTools, setRunningTools]);

  // When all tools finish, save summary to chat
  useEffect(() => {
    const hadActiveTools = previousActiveToolsRef.current.size > 0;
    const nowHasActiveTools = activeTools.size > 0;

    // Transition from tools running to all tools finished
    if (hadActiveTools && !nowHasActiveTools && events.length > 0) {
      const summary: ToolEventSummaryState = {
        events: events.slice(), // Copy all events
        timestamp: new Date(),
        id: `tool-summary-${Date.now()}`,
      };
      setCompletedSummary(summary);
      onToolExecutionComplete?.(summary);

      // Clear events after summary is created
      setTimeout(() => {
        setEvents([]);
      }, 500);
    }

    previousActiveToolsRef.current = new Set(activeTools);
  }, [activeTools, events, onToolExecutionComplete]);

  // Only show display while tools are running
  const isRunning = activeTools.size > 0;

  if (!isRunning && !completedSummary) {
    return null;
  }

  // Show completed summary in chat (rendered by caller), not here
  if (completedSummary && !isRunning) {
    return null;
  }

  return (
    <div className="space-y-2 text-xs">
      {/* Active tools */}
      {isRunning && (
        <div className="rounded bg-blue-900/20 border border-blue-800/30 p-2">
          <div className="flex items-center gap-2 text-blue-300 mb-1">
            <Zap className="w-3 h-3 animate-pulse" />
            <span className="font-semibold">Running Tools</span>
          </div>
          <div className="space-y-1">
            {Array.from(activeTools).map((toolName) => (
              <div key={toolName} className="flex items-center gap-2 text-foreground/80 ml-4">
                <Loader className="w-3 h-3 animate-spin text-blue-400" />
                <span className="font-mono">{toolName}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Event history - only while running */}
      {isRunning && events.length > 0 && (
        <div className="rounded bg-card/40 border border-border/40 p-2 max-h-40 overflow-y-auto">
          {events.map((event, idx) => (
            <div key={idx} className="flex items-start gap-2 text-muted-foreground mb-1 last:mb-0">
              {event.type === "tool-start" && (
                <Loader className="w-3 h-3 flex-shrink-0 mt-0.5 text-blue-400 animate-spin" />
              )}
              {event.type === "tool-progress" && (
                <Zap className="w-3 h-3 flex-shrink-0 mt-0.5 text-yellow-400 animate-pulse" />
              )}
              {event.type === "tool-complete" && (
                <CheckCircle className="w-3 h-3 flex-shrink-0 mt-0.5 text-green-400" />
              )}
              {event.type === "tool-error" && (
                <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5 text-red-400" />
              )}
              {event.type === "tool-warning" && (
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5 text-yellow-500 animate-pulse" />
              )}

              <div className="flex-1 min-w-0">
                {(() => {
                  const duration = typeof event.data?.duration === "number" ? event.data.duration : undefined;
                  const outputSize = typeof event.data?.outputSize === "number" ? event.data.outputSize : undefined;
                  const elapsedTime = typeof event.data?.elapsedTime === "number" ? event.data.elapsedTime : undefined;
                  const progress = typeof event.data?.progress === "string" ? event.data.progress : "running";
                  const summary = typeof event.data?.summary === "string" ? event.data.summary : "done";
                  const error = typeof event.data?.error === "string" ? event.data.error : "error";
                  const warning = typeof event.data?.warning === "string" ? event.data.warning : "warning";

                  return (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground/80">{event.toolName}</span>
                        <span className={`${event.type === "tool-warning" ? "text-yellow-400" : "text-muted-foreground"}`}>
                          {event.type === "tool-start" && "🔄 started"}
                          {event.type === "tool-progress" && `⏳ ${progress}`}
                          {event.type === "tool-complete" && `✓ ${summary}`}
                          {event.type === "tool-error" && `✗ ${error}`}
                          {event.type === "tool-warning" && `⚠️ ${warning}`}
                        </span>
                      </div>
                      {(duration || elapsedTime) !== undefined && (
                        <div className={`text-[10px] ${event.type === "tool-warning" ? "text-yellow-600" : "text-muted-foreground/70"}`}>
                          {Math.round(duration || elapsedTime || 0)}ms
                          {outputSize !== undefined && ` • ${Math.round(outputSize / 1024)}KB`}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Browser Preview */}
      {browserPreviewData && (
        <div className="rounded border border-cyan-500/30 bg-cyan-500/5 overflow-hidden">
          <div className="flex items-center justify-between gap-2 bg-cyan-500/10 px-2 py-1.5 border-b border-cyan-500/20">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
              <span className="text-[11px] font-medium text-cyan-200">Browser Preview</span>
              {browserPreviewData.url && (
                <span className="text-[10px] text-cyan-300/70 truncate">{browserPreviewData.url}</span>
              )}
            </div>
          </div>
          <div className="relative bg-black/40 aspect-video overflow-hidden">
            {browserPreviewData.screenshotStorageUrl ? (
              <img
                src={browserPreviewData.screenshotStorageUrl}
                alt="Browser screenshot"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                Screenshot wird geladen...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
