import { useState } from "react";
import { AgentQuestionPrompt } from "./AgentQuestionPrompt";
import { AgentQuestionResponse } from "./AgentQuestionResponse";

export interface AgentQuestion {
  /** Unique identifier for this question */
  id: string;
  /** The clarification question text */
  question: string;
  /** Optional context explaining why this question is needed */
  context?: string;
  /** Visual importance level (affects styling) */
  importance?: "low" | "medium" | "high";
  /** Placeholder text for the response input */
  responsePlaceholder?: string;
  /** Whether a response has been submitted */
  answered?: boolean;
  /** The user's response (if answered) */
  response?: string;
}

interface AgentQuestionDisplayProps {
  /** The question data */
  question: AgentQuestion;
  /** Called when user submits a response */
  onSubmitResponse: (questionId: string, response: string) => void | Promise<void>;
  /** Called when user cancels the question */
  onCancel?: (questionId: string) => void;
  /** Whether the response is being submitted */
  isLoading?: boolean;
  /** Show in compact mode (inline, minimal styling) */
  compact?: boolean;
}

/**
 * Complete agent question component combining prompt and response input.
 *
 * Displays:
 * - Agent's clarification question
 * - Context explaining why question is needed
 * - Input field for user's response
 * - Response tracking
 */
export function AgentQuestionDisplay({
  question,
  onSubmitResponse,
  onCancel,
  isLoading = false,
  compact = false,
}: AgentQuestionDisplayProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (response: string) => {
    setIsSubmitting(true);
    try {
      await onSubmitResponse(question.id, response);
    } finally {
      setIsSubmitting(false);
    }
  };

  // If already answered, show confirmation
  if (question.answered) {
    return (
      <div
        className={`
          rounded-lg border border-emerald-500/30 bg-emerald-500/10
          px-4 py-3 animate-in fade-in slide-in-from-left-2 duration-300
        `}
      >
        <div className="flex items-start gap-3">
          <div className="text-xl leading-none mt-0.5">✓</div>
          <div className="flex-1 space-y-1">
            <div className="text-sm font-semibold text-emerald-100">
              Question Answered
            </div>
            <div className="text-xs text-emerald-200/80">
              Your response: <em>{question.response}</em>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (compact) {
    // Compact inline mode
    return (
      <div className="space-y-2">
        <AgentQuestionPrompt
          question={question.question}
          context={question.context}
          importance={question.importance}
          showIndicator={false}
        />
        <AgentQuestionResponse
          questionId={question.id}
          placeholder={question.responsePlaceholder}
          isLoading={isSubmitting || isLoading}
          onSubmit={handleSubmit}
          onCancel={onCancel ? () => onCancel(question.id) : undefined}
        />
      </div>
    );
  }

  // Full mode with visual separation
  return (
    <div className="space-y-3 rounded-lg bg-slate-950/30 p-4 border border-slate-800/50">
      <AgentQuestionPrompt
        question={question.question}
        context={question.context}
        importance={question.importance}
        showIndicator={true}
      />

      <div className="border-t border-slate-800/30 pt-3">
        <AgentQuestionResponse
          questionId={question.id}
          placeholder={question.responsePlaceholder}
          isLoading={isSubmitting || isLoading}
          onSubmit={handleSubmit}
          onCancel={onCancel ? () => onCancel(question.id) : undefined}
          autoFocus={true}
        />
      </div>
    </div>
  );
}
