import { CheckCircle, AlertCircle, Zap, Clock, Database, Image } from "lucide-react";

interface ToolEvent {
  type: "tool-start" | "tool-progress" | "tool-complete" | "tool-error" | "tool-warning";
  toolName: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

interface BrowserScreenshot {
  url?: string;
  screenshotUrl?: string;
}

interface ToolEventSummaryProps {
  events: ToolEvent[];
  onDismiss?: () => void;
}

export function ToolEventSummary({ events, onDismiss }: ToolEventSummaryProps) {
  if (events.length === 0) return null;

  // Group events by tool
  const toolGroups = new Map<string, ToolEvent[]>();
  for (const event of events) {
    if (!toolGroups.has(event.toolName)) {
      toolGroups.set(event.toolName, []);
    }
    toolGroups.get(event.toolName)!.push(event);
  }

  // Get completion status for each tool
  const toolStatuses = Array.from(toolGroups.entries()).map(([toolName, toolEvents]) => {
    const lastEvent = toolEvents[toolEvents.length - 1];
    const completeEvent = toolEvents.find((e) => e.type === "tool-complete");
    const errorEvent = toolEvents.find((e) => e.type === "tool-error");

    const duration =
      completeEvent && toolEvents[0]
        ? completeEvent.timestamp.getTime() - toolEvents[0].timestamp.getTime()
        : undefined;

    const outputSize = typeof completeEvent?.data?.outputSize === "number" ? completeEvent.data.outputSize : undefined;
    const summary = typeof completeEvent?.data?.summary === "string" ? completeEvent.data.summary : undefined;
    const error = typeof errorEvent?.data?.error === "string" ? errorEvent.data.error : undefined;

    return {
      toolName,
      status: errorEvent ? "error" : completeEvent ? "complete" : "running",
      duration,
      outputSize,
      summary,
      error,
    };
  });

  const completeCount = toolStatuses.filter((s) => s.status === "complete").length;
  const errorCount = toolStatuses.filter((s) => s.status === "error").length;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-lg border border-blue-800/40 bg-blue-900/20 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-blue-400" />
          <span className="font-semibold text-sm text-blue-300">Tool Execution Summary</span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground/80 transition text-xs"
          >
            ✕
          </button>
        )}
      </div>

      {/* Tool Results */}
      <div className="space-y-2">
        {toolStatuses.map((tool) => {
          const completeEvent = Array.from(toolGroups.values())
            .flat()
            .find((e) => e.toolName === tool.toolName && e.type === "tool-complete");
          const screenshotUrl = (completeEvent?.data?.screenshotUrl || completeEvent?.data?.url) as string | undefined;

          return (
            <div key={tool.toolName}>
              <div className="text-xs">
                <div className="flex items-start gap-2">
                  {tool.status === "complete" && (
                    <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-green-400" />
                  )}
                  {tool.status === "error" && (
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-red-400" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-foreground/80">{tool.toolName}</span>
                      {tool.status === "complete" && (
                        <span className="text-green-400 text-[10px]">✓ completed</span>
                      )}
                      {tool.status === "error" && (
                        <span className="text-red-400 text-[10px]">✗ failed</span>
                      )}
                    </div>

                    {/* Summary or error */}
                    {tool.summary && (
                      <div className="text-muted-foreground text-[11px] mt-0.5 line-clamp-2">{tool.summary}</div>
                    )}
                    {tool.error && (
                      <div className="text-red-300 text-[11px] mt-0.5">{tool.error}</div>
                    )}

                    {/* Metadata */}
                    {(tool.duration || tool.outputSize) && (
                      <div className="flex items-center gap-3 mt-1 text-muted-foreground text-[10px]">
                        {tool.duration && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {Math.round(tool.duration)}ms
                          </span>
                        )}
                        {tool.outputSize && (
                          <span className="flex items-center gap-1">
                            <Database className="w-2.5 h-2.5" />
                            {Math.round(tool.outputSize / 1024)}KB
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Browser Screenshot Preview */}
              {tool.toolName === "Browser" && screenshotUrl && (
                <div className="mt-2 rounded border border-cyan-500/30 bg-cyan-500/5 overflow-hidden">
                  <div className="flex items-center gap-2 bg-cyan-500/10 px-2 py-1.5 border-b border-cyan-500/20">
                    <Image className="w-3 h-3 text-cyan-400" />
                    <span className="text-[10px] text-cyan-300">Screenshot</span>
                  </div>
                  <div className="aspect-video bg-black/40 overflow-hidden">
                    <img
                      src={screenshotUrl}
                      alt="Browser screenshot"
                      className="w-full h-full object-contain"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer Stats */}
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground border-t border-blue-800/30 pt-2 mt-2">
        <span>
          <span className="text-green-400 font-semibold">{completeCount}</span> completed
        </span>
        {errorCount > 0 && (
          <span>
            <span className="text-red-400 font-semibold">{errorCount}</span> failed
          </span>
        )}
        <span className="ml-auto text-muted-foreground/70">
          {toolStatuses.length} total
        </span>
      </div>
    </div>
  );
}
