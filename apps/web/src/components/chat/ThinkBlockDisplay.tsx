import { useMemo } from "react";
import { BrainCircuit, Zap } from "lucide-react";
import { ThinkBlockStream } from "./ThinkBlockStream";
import { ThinkBlockToolCalls } from "./ThinkBlockToolCalls";
import { ThinkBlockCollapse } from "./ThinkBlockCollapse";

/** Parsed think block with metadata */
interface ThinkBlock {
  id: string;
  content: string;
  startTime: Date;
  endTime?: Date;
  toolCalls: ToolCallReference[];
  thinkingDepth: "shallow" | "medium" | "deep";
  tokenEstimate?: number;
  status: "streaming" | "complete";
}

/** Tool call reference from think block */
interface ToolCallReference {
  position: number;
  toolName: string;
  purpose: string;
  status: "planned" | "executing" | "completed" | "failed";
  confidence: number;
}

interface ThinkBlockDisplayProps {
  /** The think block data to display */
  thinkBlock: ThinkBlock;
  /** Whether this block is currently receiving streaming updates */
  isStreaming?: boolean;
  /** Called when streaming is complete */
  onStreamComplete?: () => void;
  /** Compact mode (smaller UI, fewer details) */
  compact?: boolean;
  /** Show detailed statistics */
  showStats?: boolean;
}

/**
 * Main component for displaying parsed think blocks.
 *
 * Features:
 * - Live streaming with typewriter animation
 * - Auto-collapse after 3s of inactivity
 * - Tool call visualization
 * - Thinking depth indicator
 * - Token counter
 * - Smooth animations
 */
export function ThinkBlockDisplay({
  thinkBlock,
  isStreaming = false,
  onStreamComplete,
  compact = false,
  showStats = true,
}: ThinkBlockDisplayProps) {
  // Thinking depth visual indicator
  const depthIndicator = useMemo(() => {
    const levels: Record<
      "shallow" | "medium" | "deep",
      { icon: string; glow: string; intensity: number }
    > = {
      shallow: { icon: "🧠", glow: "text-amber-300", intensity: 1 },
      medium: { icon: "🧠🧠", glow: "text-amber-400", intensity: 2 },
      deep: { icon: "🧠🧠🧠", glow: "text-amber-500", intensity: 3 },
    };
    return levels[thinkBlock.thinkingDepth as keyof typeof levels];
  }, [thinkBlock.thinkingDepth]);

  // Token estimate with uncertainty indicator
  const tokenDisplay = useMemo(() => {
    if (!thinkBlock.tokenEstimate) return null;
    return `~${thinkBlock.tokenEstimate}`;
  }, [thinkBlock.tokenEstimate]);

  return (
    <div className="space-y-2">
      {/* Header with stats */}
      {!compact && (
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`text-lg leading-none transform transition-all ${
                isStreaming ? "scale-110" : "scale-100"
              }`}
              title={`Thinking depth: ${thinkBlock.thinkingDepth}`}
            >
              {depthIndicator.icon}
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <h4 className="text-xs font-semibold text-amber-200/90 truncate">
                AI Reasoning
              </h4>
              <div className="flex items-center gap-2 text-[10px] text-amber-200/60">
                {isStreaming && (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
                    Streaming...
                  </span>
                )}
                {showStats && tokenDisplay && (
                  <span className="inline-flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    {tokenDisplay} tokens
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Status icon */}
          {isStreaming && (
            <BrainCircuit className="w-4 h-4 text-amber-400 animate-pulse flex-shrink-0" />
          )}
        </div>
      )}

      {/* Main content with collapse wrapper */}
      <ThinkBlockCollapse
        isStreaming={isStreaming}
        autoCollapseDelay={3000}
        expandedHeight={compact ? "250px" : "400px"}
        collapsedHeight={compact ? "80px" : "120px"}
      >
        {/* Content stream */}
        <ThinkBlockStream
          content={thinkBlock.content}
          isStreaming={isStreaming}
          onStreamComplete={onStreamComplete}
        />

        {/* Tool calls visualization */}
        {!compact && thinkBlock.toolCalls.length > 0 && (
          <div className="mt-3 pt-2 border-t border-amber-200/20">
            <div className="text-[10px] text-amber-200/60 mb-2 font-semibold">
              Referenced Tools:
            </div>
            <ThinkBlockToolCalls toolCalls={thinkBlock.toolCalls} compact={false} />
          </div>
        )}

        {/* Compact tool calls (one line) */}
        {compact && thinkBlock.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            <ThinkBlockToolCalls toolCalls={thinkBlock.toolCalls} compact={true} />
          </div>
        )}
      </ThinkBlockCollapse>

      {/* Detailed statistics (expanded view) */}
      {showStats && !compact && (
        <div className="px-1 space-y-1 text-[10px]">
          {/* Thinking depth details */}
          <div className="flex items-center justify-between text-amber-200/50">
            <span>Depth:</span>
            <span className={`font-semibold ${depthIndicator.glow}`}>
              {thinkBlock.thinkingDepth.charAt(0).toUpperCase() +
                thinkBlock.thinkingDepth.slice(1)}
            </span>
          </div>

          {/* Tool references summary */}
          {thinkBlock.toolCalls.length > 0 && (
            <div className="flex items-center justify-between text-amber-200/50">
              <span>Tools referenced:</span>
              <span className="font-semibold text-amber-200/70">
                {thinkBlock.toolCalls.length}
              </span>
            </div>
          )}

          {/* Block ID for debugging */}
          <div className="flex items-center justify-between text-amber-200/40">
            <span>Block ID:</span>
            <span className="font-mono text-[9px] truncate">
              {thinkBlock.id.substring(0, 16)}...
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
