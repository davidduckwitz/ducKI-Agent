import { useState, useEffect, useMemo } from "react";
import { ChevronDown, ChevronUp, X, Zap } from "lucide-react";
import type { ToolCallRecord } from "../../lib/store";
import { cn } from "../../lib/utils";

interface ToolActivityLoggerProps {
  toolCalls: ToolCallRecord[];
  onRemoveCall: (id: string) => void;
}

/** How long the popup lingers after the last tool call has settled. */
const AUTO_HIDE_DELAY = 5000;

export function ToolActivityLogger({ toolCalls, onRemoveCall }: ToolActivityLoggerProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [isVisible, setIsVisible] = useState(true);

  // Get last 2 tool calls
  const recentCalls = useMemo(() => toolCalls.slice(-2).reverse(), [toolCalls]);
  const newestCallId = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1]?.id : undefined;
  const hasRunningCall = recentCalls.some((call) => call.status === "executing");

  // A new tool call brings the popup back, including after it was closed by hand.
  useEffect(() => {
    if (newestCallId) {
      setIsVisible(true);
    }
  }, [newestCallId]);

  // Once nothing is running any more, the panel has said all it has to say. Leaving it pinned
  // over the chat for the rest of the session is what made the UI feel cluttered and slow.
  useEffect(() => {
    if (!isVisible || hasRunningCall || recentCalls.length === 0) {
      return;
    }
    const timer = setTimeout(() => setIsVisible(false), AUTO_HIDE_DELAY);
    return () => clearTimeout(timer);
  }, [isVisible, hasRunningCall, recentCalls.length, newestCallId]);

  if (!isVisible || recentCalls.length === 0) {
    return null;
  }

  const getStatusColor = (status: "executing" | "completed" | "failed") => {
    switch (status) {
      case "executing":
        return "from-amber-500/20 to-amber-600/10 border-amber-400/30";
      case "completed":
        return "from-emerald-500/20 to-emerald-600/10 border-emerald-400/30";
      case "failed":
        return "from-red-500/20 to-red-600/10 border-red-400/30";
    }
  };

  const getStatusIcon = (status: "executing" | "completed" | "failed") => {
    switch (status) {
      case "executing":
        return <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />;
      case "completed":
        return <div className="w-2 h-2 rounded-full bg-emerald-400" />;
      case "failed":
        return <div className="w-2 h-2 rounded-full bg-red-400" />;
    }
  };

  const getStatusText = (status: "executing" | "completed" | "failed") => {
    switch (status) {
      case "executing":
        return "Läuft...";
      case "completed":
        return "Fertig";
      case "failed":
        return "Fehler";
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    return date.toLocaleTimeString();
  };

  return (
    <div className="fixed bottom-6 right-6 w-80 z-40">
      {/* Tool Activity Logger Card */}
      <div
        className={cn(
          "bg-gradient-to-br from-slate-900/95 to-slate-800/95 backdrop-blur-xl",
          "border border-slate-700/50 rounded-lg shadow-2xl",
          "transition-all duration-300 transform",
          isOpen ? "scale-100 opacity-100" : "scale-95 opacity-75"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-slate-700/30 cursor-pointer" onClick={() => setIsOpen(!isOpen)}>
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-500/20 rounded-lg border border-blue-400/30">
              <Zap className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-100">Tool Activity</h3>
              <p className="text-[10px] text-slate-400">{recentCalls.length} recent</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsVisible(false);
              }}
              className="p-1 hover:bg-slate-700/50 rounded transition-colors"
              title="Schließen"
            >
              <X className="w-3 h-3 text-slate-400" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
              }}
              className="p-1 hover:bg-slate-700/50 rounded transition-colors"
            >
              {isOpen ? (
                <ChevronUp className="w-3 h-3 text-slate-400" />
              ) : (
                <ChevronDown className="w-3 h-3 text-slate-400" />
              )}
            </button>
          </div>
        </div>

        {/* Content */}
        {isOpen && (
          <div className="space-y-2 p-3">
            {recentCalls.length > 0 ? (
              recentCalls.map((call, idx) => (
                <div
                  key={call.id}
                  className={cn(
                    "p-2.5 rounded-lg border backdrop-blur-sm transition-all",
                    "hover:shadow-lg hover:border-opacity-75",
                    getStatusColor(call.status),
                    idx === 0 ? "ring-1 ring-slate-500/20" : ""
                  )}
                >
                  {/* Tool Name and Status */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {getStatusIcon(call.status)}
                      <span className="text-xs font-semibold text-slate-100 truncate">
                        {call.toolName}
                      </span>
                    </div>
                    <span className={cn(
                      "text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                      call.status === "executing" && "bg-amber-400/20 text-amber-300",
                      call.status === "completed" && "bg-emerald-400/20 text-emerald-300",
                      call.status === "failed" && "bg-red-400/20 text-red-300"
                    )}>
                      {getStatusText(call.status)}
                    </span>
                  </div>

                  {/* Tool Details */}
                  {call.action && (
                    <p className="text-[10px] text-slate-300 mb-1 line-clamp-2">
                      {call.action}
                    </p>
                  )}

                  {/* Timestamp */}
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] text-slate-500">{formatTime(call.timestamp)}</p>
                    {call.status === "completed" && call.result && (
                      <p className="text-[9px] text-emerald-400">
                        ✓ Success
                      </p>
                    )}
                    {call.status === "failed" && call.result?.error && (
                      <p className="text-[9px] text-red-400 truncate max-w-[120px]">
                        {call.result.error}
                      </p>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-slate-400 text-center py-3">
                Keine Tool Calls aktiv
              </p>
            )}

            {/* Status Indicator */}
            {recentCalls.some(call => call.status === "executing") && (
              <div className="pt-2 border-t border-slate-700/30 flex items-center gap-2 text-[10px] text-amber-400">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span>Tool läuft gerade...</span>
              </div>
            )}
          </div>
        )}

        {/* Minimized State */}
        {!isOpen && recentCalls.length > 0 && recentCalls[0] && (
          <div className="px-3 py-2 text-[10px] text-slate-400 bg-slate-800/50 border-t border-slate-700/30">
            <span className="font-medium text-slate-300">{recentCalls[0]?.toolName}</span>
            {" "}
            <span className="text-slate-500">({getStatusText(recentCalls[0]?.status ?? "completed")})</span>
          </div>
        )}
      </div>

      {/* Floating Pills wenn minimiert */}
      {!isOpen && recentCalls.length > 0 && (
        <div className="absolute -top-10 right-0 flex gap-1">
          {recentCalls.map((call) => (
            <button
              key={call.id}
              onClick={() => setIsOpen(true)}
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center",
                "border transition-all hover:scale-110",
                call.status === "executing" && "bg-amber-500/20 border-amber-400/50 animate-pulse",
                call.status === "completed" && "bg-emerald-500/20 border-emerald-400/50",
                call.status === "failed" && "bg-red-500/20 border-red-400/50"
              )}
              title={`${call.toolName} - ${getStatusText(call.status)}`}
            >
              <div className="w-2 h-2 rounded-full bg-current" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
