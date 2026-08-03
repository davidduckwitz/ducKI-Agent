import { useState } from "react";
import { HelpCircle, Send } from "lucide-react";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  id: string;
  question: string;
  description?: string;
  type: "multiple-choice" | "text" | "combined"; // combined = choices + custom input
  options?: QuestionOption[]; // für multiple-choice und combined
  placeholder?: string; // für text und combined input
  required?: boolean;
}

interface AgentQuestionBoxProps {
  question: AgentQuestion;
  onAnswer: (answer: string | { option: string; custom?: string }) => void;
  isLoading?: boolean;
}

export function AgentQuestionBox({ question, onAnswer, isLoading = false }: AgentQuestionBoxProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmitMultipleChoice = (optionId: string) => {
    onAnswer(optionId);
    setSubmitted(true);
  };

  const handleSubmitText = () => {
    if (!customInput.trim() && question.required) return;
    onAnswer(customInput);
    setSubmitted(true);
  };

  const handleSubmitCombined = () => {
    if (!selectedOption && question.required) return;
    onAnswer({
      option: selectedOption || "",
      custom: customInput,
    });
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
        <p className="text-xs text-green-300">✓ Antwort erhalten</p>
      </div>
    );
  }

  return (
    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 space-y-4">
      {/* Question Header */}
      <div className="flex items-start gap-3">
        <HelpCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-medium text-sm text-gray-100">{question.question}</p>
          {question.description && (
            <p className="text-xs text-gray-400 mt-1">{question.description}</p>
          )}
        </div>
      </div>

      {/* Multiple Choice */}
      {(question.type === "multiple-choice" || question.type === "combined") && question.options && (
        <div className="space-y-2">
          {question.options.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                if (question.type === "multiple-choice") {
                  handleSubmitMultipleChoice(option.id);
                } else {
                  setSelectedOption(option.id);
                }
              }}
              disabled={isLoading}
              className={`w-full text-left px-3 py-2 rounded border transition-colors ${
                selectedOption === option.id
                  ? "border-blue-500 bg-blue-500/20 text-blue-100"
                  : "border-gray-600 bg-gray-800/50 text-gray-300 hover:border-gray-500 hover:bg-gray-800"
              }`}
            >
              <p className="text-sm font-medium">{option.label}</p>
              {option.description && (
                <p className="text-xs text-gray-400 mt-0.5">{option.description}</p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Text Input */}
      {(question.type === "text" || question.type === "combined") && (
        <div className="space-y-2">
          {question.type === "combined" && (
            <label className="text-xs text-gray-400">Oder eigene Antwort eingeben:</label>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !isLoading) {
                  if (question.type === "combined") {
                    handleSubmitCombined();
                  } else {
                    handleSubmitText();
                  }
                }
              }}
              placeholder={question.placeholder || "Deine Antwort eingeben..."}
              disabled={isLoading}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={() => {
                if (question.type === "combined") {
                  handleSubmitCombined();
                } else {
                  handleSubmitText();
                }
              }}
              disabled={isLoading || (!customInput.trim() && question.required && question.type === "text")}
              className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Combined Submit Button */}
      {question.type === "combined" && (
        <button
          onClick={handleSubmitCombined}
          disabled={isLoading || (!selectedOption && question.required)}
          className="w-full px-3 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Absenden
        </button>
      )}
    </div>
  );
}
