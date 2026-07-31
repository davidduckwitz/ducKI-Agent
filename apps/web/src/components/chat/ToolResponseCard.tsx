import { useState } from "react";
import { ChevronDown, ChevronRight, X, Copy, ExternalLink } from "lucide-react";

interface ToolCallData {
  id: string;
  toolName: string;
  action?: string;
  timestamp: string;
  input?: Record<string, unknown>;
  status: "executing" | "completed" | "failed";
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    data?: unknown;
  };
  tabId?: string;
}

interface ToolResponseCardProps {
  toolCall: ToolCallData;
  onClose?: () => void;
}

export function ToolResponseCard({ toolCall, onClose }: ToolResponseCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case "browser":
        return "🌐";
      case "shell":
        return "💻";
      case "filesystem":
        return "📁";
      default:
        return "🔧";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "executing":
        return "bg-blue-500/10 border-blue-500/30 text-blue-200";
      case "completed":
        return "bg-green-500/10 border-green-500/30 text-green-200";
      case "failed":
        return "bg-red-500/10 border-red-500/30 text-red-200";
      default:
        return "bg-muted/60 border-border";
    }
  };

  const copyToClipboard = () => {
    const text = JSON.stringify(toolCall, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const displayOutput = toolCall.result?.output || JSON.stringify(toolCall.result?.data, null, 2) || "No output";

  return (
    <div className={`rounded-lg border p-3 space-y-2 text-sm ${getStatusColor(toolCall.status)}`}>
      {/* Header */}
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center gap-2 flex-1">
          <button className="p-0 hover:bg-white/10 rounded" onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}>
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <span className="text-lg">{getToolIcon(toolCall.toolName)}</span>
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold">
              {toolCall.toolName}
              {toolCall.action && `: ${toolCall.action}`}
            </div>
            <div className="text-xs opacity-75">{new Date(toolCall.timestamp).toLocaleTimeString()}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard();
            }}
            className="p-1 hover:bg-white/10 rounded transition"
            title="Copy"
          >
            <Copy className="w-3 h-3" />
          </button>
          {toolCall.tabId && (
            <button
              className="p-1 hover:bg-white/10 rounded transition"
              title="Open in browser"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
          {onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="p-1 hover:bg-white/10 rounded transition"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Status Badge */}
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 rounded text-xs font-mono ${
          toolCall.status === "executing"
            ? "bg-blue-500/20 text-blue-300 animate-pulse"
            : toolCall.status === "completed"
            ? "bg-green-500/20 text-green-300"
            : "bg-red-500/20 text-red-300"
        }`}>
          {toolCall.status === "executing" ? "⟳ Executing..." : toolCall.status === "completed" ? "✓ Done" : "✗ Failed"}
        </span>
        {toolCall.tabId && (
          <span className="px-2 py-0.5 rounded text-xs bg-white/10 text-foreground/80 font-mono">
            Tab: {toolCall.tabId}
          </span>
        )}
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="space-y-2 mt-3 pt-3 border-t border-white/10">
          {/* Input */}
          {toolCall.input && (
            <div className="space-y-1">
              <div className="text-xs font-semibold opacity-75">Input:</div>
              <div className="bg-black/20 rounded p-2 font-mono text-xs max-h-32 overflow-y-auto">
                <pre className="whitespace-pre-wrap break-words">
                  {JSON.stringify(toolCall.input, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Output */}
          <div className="space-y-1">
            <div className="text-xs font-semibold opacity-75">Output:</div>
            <div className="bg-black/20 rounded p-2 font-mono text-xs max-h-40 overflow-y-auto">
              <pre className="whitespace-pre-wrap break-words">
                {typeof displayOutput === "string"
                  ? displayOutput
                  : JSON.stringify(displayOutput, null, 2)}
              </pre>
            </div>
          </div>

          {/* Error if present */}
          {toolCall.result?.error && (
            <div className="space-y-1">
              <div className="text-xs font-semibold text-red-300">Error:</div>
              <div className="bg-red-500/10 rounded p-2 font-mono text-xs text-red-200">
                {toolCall.result.error}
              </div>
            </div>
          )}

          {/* Copy feedback */}
          {copied && (
            <div className="text-xs text-green-300 text-center">✓ Copied to clipboard</div>
          )}
        </div>
      )}
    </div>
  );
}

// Minimized/Docked Version für Chat
interface ToolResponseDockProps {
  toolCalls: ToolCallData[];
  onRemove?: (id: string) => void;
}

export function ToolResponseDock({ toolCalls, onRemove }: ToolResponseDockProps) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 space-y-2 max-w-sm">
      {toolCalls.map((call) => (
        <div key={call.id} className="animate-in slide-in-from-right">
          <ToolResponseCard
            toolCall={call}
            onClose={() => onRemove?.(call.id)}
          />
        </div>
      ))}
    </div>
  );
}
