import { useState } from "react";
import { ChevronDown, Brain } from "lucide-react";

interface ReasoningDisplayProps {
  thinking?: string;
  compact?: boolean;
}

export function ReasoningDisplay({ thinking, compact }: ReasoningDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  if (!thinking || thinking.trim().length === 0) {
    return null;
  }

  const preview = thinking.length > 200 ? thinking.substring(0, 200) + "..." : thinking;
  const hasMore = thinking.length > 200;

  return (
    <div className="mt-2 rounded-lg border border-amber-200/30 bg-amber-50/30 dark:border-amber-900/30 dark:bg-amber-950/20 px-3 py-2 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200 hover:opacity-75 transition-opacity w-full"
      >
        <Brain className="h-4 w-4 flex-shrink-0" />
        <span>🧠 {compact ? "Reasoning" : "AI Reasoning"}</span>
        {hasMore && (
          <ChevronDown
            className={`h-4 w-4 ml-auto flex-shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {expanded ? (
        <div className="mt-2 text-amber-900/80 dark:text-amber-200/80 whitespace-pre-wrap break-words leading-relaxed">
          {thinking}
        </div>
      ) : (
        <div className="mt-1 text-amber-900/70 dark:text-amber-200/70 text-opacity-75">
          {preview}
        </div>
      )}
    </div>
  );
}
