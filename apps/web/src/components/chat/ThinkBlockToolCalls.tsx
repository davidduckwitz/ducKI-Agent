import { Badge } from "@/components/ui/badge";
import { Wrench, AlertCircle, CheckCircle, Loader } from "lucide-react";

/** Tool call reference from think block */
interface ToolCallReference {
  position: number;
  toolName: string;
  purpose: string;
  status: "planned" | "executing" | "completed" | "failed";
  confidence: number;
}

interface ThinkBlockToolCallsProps {
  toolCalls: ToolCallReference[];
  compact?: boolean;
}

export function ThinkBlockToolCalls({
  toolCalls,
  compact = false,
}: ThinkBlockToolCallsProps) {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {toolCalls.map((toolCall, idx) => (
        <ToolCallBadge
          key={`${toolCall.toolName}-${toolCall.position}-${idx}`}
          toolCall={toolCall}
          compact={compact}
        />
      ))}
    </div>
  );
}

interface ToolCallBadgeProps {
  toolCall: ToolCallReference;
  compact?: boolean;
}

function ToolCallBadge({ toolCall, compact }: ToolCallBadgeProps) {
  const statusIcon = {
    planned: <Wrench className="w-3 h-3" />,
    executing: <Loader className="w-3 h-3 animate-spin" />,
    completed: <CheckCircle className="w-3 h-3" />,
    failed: <AlertCircle className="w-3 h-3" />,
  };

  const statusColor = {
    planned: "bg-amber-500/20 text-amber-200 border-amber-500/40",
    executing: "bg-blue-500/20 text-blue-200 border-blue-500/40",
    completed: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
    failed: "bg-red-500/20 text-red-200 border-red-500/40",
  };

  const icon = statusIcon[toolCall.status as keyof typeof statusIcon];
  const colors = statusColor[toolCall.status as keyof typeof statusColor];

  const displayText = compact
    ? `🔧 ${toolCall.toolName}`
    : `🔧 ${toolCall.toolName} → ${toolCall.purpose.substring(0, 30)}${toolCall.purpose.length > 30 ? "..." : ""}`;

  return (
    <Badge
      variant="outline"
      className={`${colors} border flex items-center gap-1 px-2 py-1 text-xs font-medium cursor-default transition-all hover:brightness-110`}
      title={`${toolCall.toolName}: ${toolCall.purpose}\nStatus: ${toolCall.status}\nConfidence: ${(toolCall.confidence * 100).toFixed(0)}%`}
    >
      {icon}
      <span className="truncate">{displayText}</span>
    </Badge>
  );
}
