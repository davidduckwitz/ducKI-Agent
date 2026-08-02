import { useEffect, useState, useRef } from "react";
import { ChevronDown } from "lucide-react";

interface ThinkBlockCollapseProps {
  /** Whether the think block is currently being streamed */
  isStreaming: boolean;
  /** Time in milliseconds to wait after streaming before auto-collapsing */
  autoCollapseDelay?: number;
  /** Initial collapsed state */
  initialCollapsed?: boolean;
  /** Content height when expanded (CSS max-height) */
  expandedHeight?: string;
  /** Content height when collapsed (CSS max-height) */
  collapsedHeight?: string;
  children: React.ReactNode;
}

/**
 * Manages auto-collapse behavior for think blocks.
 * - Stays expanded while streaming
 * - Auto-collapses after N seconds of inactivity
 * - User can manually toggle
 * - Smooth animation between states
 */
export function ThinkBlockCollapse({
  isStreaming,
  autoCollapseDelay = 3000,
  initialCollapsed = false,
  expandedHeight = "400px",
  collapsedHeight = "120px",
  children,
}: ThinkBlockCollapseProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const collapseTimerRef = useRef<NodeJS.Timeout>();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-collapse logic
  useEffect(() => {
    // Clear any pending collapse timer
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
    }

    // While streaming, never auto-collapse
    if (isStreaming) {
      setIsCollapsed(false);
      return;
    }

    // After streaming ends, schedule auto-collapse
    collapseTimerRef.current = setTimeout(() => {
      setIsCollapsed(true);
    }, autoCollapseDelay);

    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
      }
    };
  }, [isStreaming, autoCollapseDelay]);

  const maxHeight = isCollapsed ? collapsedHeight : expandedHeight;
  const showCollapseButton = !isStreaming;

  return (
    <div className="space-y-1">
      <div
        ref={containerRef}
        className={`
          relative overflow-hidden rounded-lg border border-amber-200/30
          bg-amber-950/20 px-3 py-2
          transition-all duration-300 ease-in-out
        `}
        style={{
          maxHeight: maxHeight,
        }}
      >
        {children}

        {/* Fade-out overlay when collapsed */}
        {isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-amber-950/60 to-transparent pointer-events-none" />
        )}
      </div>

      {/* Toggle button */}
      {showCollapseButton && (
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={`
            flex items-center gap-1 text-xs font-medium
            text-amber-200/60 hover:text-amber-200/90
            transition-colors duration-200
            ml-2
          `}
        >
          <ChevronDown
            className={`w-3 h-3 transition-transform duration-200 ${
              !isCollapsed ? "rotate-180" : ""
            }`}
          />
          <span>{isCollapsed ? "Show" : "Hide"} Thinking</span>
        </button>
      )}
    </div>
  );
}
