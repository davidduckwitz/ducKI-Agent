import { AlertCircle, HelpCircle } from "lucide-react";

interface AgentQuestionPromptProps {
  /** The clarification question from the agent */
  question: string;
  /** Context or reasoning for why this question is being asked */
  context?: string;
  /** Visual importance level */
  importance?: "low" | "medium" | "high";
  /** Whether to show a visual indicator */
  showIndicator?: boolean;
}

/**
 * Displays an agent question/clarification prompt to the user.
 * Appears as a distinct visual block to ensure the user sees it.
 */
export function AgentQuestionPrompt({
  question,
  context,
  importance = "medium",
  showIndicator = true,
}: AgentQuestionPromptProps) {
  const importanceStyles = {
    low: {
      border: "border-blue-500/30",
      bg: "bg-blue-500/10",
      text: "text-blue-100",
      icon: "text-blue-300",
    },
    medium: {
      border: "border-amber-500/40",
      bg: "bg-amber-500/15",
      text: "text-amber-100",
      icon: "text-amber-300",
    },
    high: {
      border: "border-red-500/40",
      bg: "bg-red-500/15",
      text: "text-red-100",
      icon: "text-red-300",
    },
  };

  const styles = importanceStyles[importance];
  const Icon = importance === "high" ? AlertCircle : HelpCircle;

  return (
    <div
      className={`
        rounded-lg border px-4 py-3 space-y-2
        ${styles.border} ${styles.bg} ${styles.text}
        animate-in fade-in slide-in-from-top-2 duration-300
      `}
    >
      <div className="flex items-start gap-3">
        {showIndicator && (
          <Icon
            className={`w-5 h-5 flex-shrink-0 mt-0.5 ${styles.icon} ${
              importance === "high" ? "animate-pulse" : ""
            }`}
          />
        )}
        <div className="flex-1 space-y-1">
          {/* Main question */}
          <div className="font-semibold text-sm leading-snug">{question}</div>

          {/* Context (optional) */}
          {context && (
            <div className="text-xs opacity-75 leading-relaxed">{context}</div>
          )}
        </div>
      </div>

      {/* Visual indicator bar */}
      <div
        className={`h-1 rounded-full ${styles.icon.replace("text-", "bg-")} opacity-40`}
      />
    </div>
  );
}
