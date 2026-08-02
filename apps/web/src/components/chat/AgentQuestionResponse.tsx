import { useState, useRef } from "react";
import { Send, Loader, Check } from "lucide-react";

interface AgentQuestionResponseProps {
  /** Question ID for tracking */
  questionId: string;
  /** Placeholder text for input */
  placeholder?: string;
  /** Whether the response is being submitted */
  isLoading?: boolean;
  /** Called when user submits a response */
  onSubmit: (response: string) => void | Promise<void>;
  /** Called when user cancels */
  onCancel?: () => void;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Auto-focus the input */
  autoFocus?: boolean;
}

/**
 * Input component for responding to agent questions.
 * Provides inline submission UI with loading state.
 */
export function AgentQuestionResponse({
  questionId,
  placeholder = "Your response...",
  isLoading = false,
  onSubmit,
  onCancel,
  disabled = false,
  autoFocus = true,
}: AgentQuestionResponseProps) {
  const [response, setResponse] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!response.trim() || isLoading) return;

    try {
      setIsSubmitted(true);
      await onSubmit(response.trim());
    } finally {
      setIsSubmitted(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd+Enter or Ctrl+Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      handleSubmit(e as any);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      {/* Input field */}
      <div className="relative">
        <textarea
          ref={inputRef}
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isLoading || isSubmitted}
          autoFocus={autoFocus}
          placeholder={placeholder}
          rows={2}
          className={`
            w-full rounded-lg border bg-slate-950/50 px-3 py-2 text-sm
            text-slate-100 placeholder-slate-500
            border-slate-700/50 focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30
            disabled:opacity-50 disabled:cursor-not-allowed
            resize-none transition-all duration-200
          `}
        />

        {/* Character counter (optional) */}
        <div className="absolute bottom-2 right-2 text-[10px] text-slate-500/50">
          {response.length} {response.length === 1 ? "char" : "chars"}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading || isSubmitted}
            className={`
              px-3 py-1.5 rounded text-xs font-medium
              border border-slate-600/50 text-slate-300
              hover:border-slate-500 hover:bg-slate-800/30
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-all duration-200
            `}
          >
            Cancel
          </button>
        )}

        <button
          type="submit"
          disabled={!response.trim() || isLoading || disabled || isSubmitted}
          className={`
            flex items-center gap-2 px-4 py-1.5 rounded text-xs font-medium
            bg-amber-600 text-white
            hover:bg-amber-700 active:bg-amber-800
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-all duration-200
          `}
        >
          {isSubmitted && <Check className="w-3 h-3" />}
          {isLoading && <Loader className="w-3 h-3 animate-spin" />}
          {!isLoading && !isSubmitted && <Send className="w-3 h-3" />}
          <span>{isSubmitted ? "Submitted" : "Send"}</span>
        </button>
      </div>

      {/* Helper text */}
      <div className="text-[10px] text-slate-500/60">
        Press Ctrl+Enter to submit quickly
      </div>
    </form>
  );
}
