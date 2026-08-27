import { useEffect, useState } from "react";
import { AlertCircle, Sparkles, X } from "lucide-react";
import { api, type ClarifyingQuestion } from "../../lib/api";
import { AgentQuestionBox } from "../chat/AgentQuestionBox";
import type { Plan } from "../chat/PlanExecutionPanel";

interface PlanRefinementDialogProps {
  plan: Plan;
  /** Fired once POST /plans/refine returns a new plan - the caller swaps it in directly, no
   *  chat round-trip and no dependence on the model choosing to emit a fresh plan event. */
  onRefined: (plan: Plan) => void;
  onCancel: () => void;
}

/** One question's answer, in the shape AgentQuestionBox's onAnswer callback provides. */
type QuestionAnswer = string | { option: string; custom?: string };

function answerToText(question: ClarifyingQuestion, answer: QuestionAnswer): string {
  if (typeof answer === "string") return answer;
  const label = question.options?.find((o) => o.id === answer.option)?.label ?? answer.option;
  return answer.custom ? `${label} (${answer.custom})` : label;
}

export function PlanRefinementDialog({ plan, onRefined, onCancel }: PlanRefinementDialogProps) {
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(true);
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  const [improvement, setImprovement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Plan | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingQuestions(true);
    api.plans
      .questions({ goal: plan.goal, steps: plan.steps ?? [] })
      .then((res) => {
        if (!cancelled) setQuestions(res.questions ?? []);
      })
      .catch(() => {
        // Degrade to a plain free-text box - the questions are a nice-to-have, not a
        // requirement, and the user can still describe what to improve.
        if (!cancelled) setQuestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingQuestions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.goal, JSON.stringify(plan.steps), plan.version]);

  const handleSubmit = async () => {
    const answeredParts = questions
      .filter((q) => answers[q.id] !== undefined)
      .map((q) => `- ${q.question}: ${answerToText(q, answers[q.id]!)}`);
    const feedback = [...answeredParts, improvement.trim()].filter(Boolean).join("\n");
    if (!feedback) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.plans.refine(plan, feedback);
      setCandidate(result.plan);
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const hasFeedback = questions.some((q) => answers[q.id] !== undefined) || improvement.trim().length > 0;
  const oldIds = new Set((plan.steps ?? []).map((step) => step.id ?? step.title));
  const newIds = new Set((candidate?.steps ?? []).map((step) => step.id ?? step.title));
  const added = [...newIds].filter((id) => !oldIds.has(id)).length;
  const removed = [...oldIds].filter((id) => !newIds.has(id)).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-2xl w-full border border-gray-700 space-y-4 p-6 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded">
              <Sparkles className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Plan verbessern</h3>
              <p className="text-sm text-gray-400">{plan.goal}</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="p-1 text-gray-400 hover:text-gray-300 disabled:opacity-50"
            aria-label="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {candidate && (
          <div className="space-y-3 rounded-lg border border-gray-700 bg-gray-800/50 p-3">
            <p className="text-sm font-semibold text-white">V{plan.version ?? 1} → V{candidate.version ?? (plan.version ?? 1) + 1}</p>
            <div className="flex gap-3 text-xs text-gray-400">
              <span>+{added} hinzugefügt</span><span>−{removed} entfernt</span><span>{candidate.steps?.length ?? 0} Schritte</span>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {(candidate.steps ?? []).map((step, index) => (
                <div key={step.id ?? `${step.title}-${index}`} className="rounded border border-gray-700 p-2 text-xs">
                  <span className="font-medium text-white">{index + 1}. {step.title}</span>
                  {step.description && <p className="mt-1 text-gray-400">{step.description}</p>}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-amber-400">Die neue Version startet einen getrennten Run; der bisherige Verlauf bleibt erhalten.</p>
          </div>
        )}

        {!candidate && loadingQuestions && (
          <p className="text-xs text-gray-400">Analysiere den Plan für Rückfragen...</p>
        )}

        {!candidate && !loadingQuestions && questions.length > 0 && (
          <div className="space-y-3">
            {questions.map((question) => (
              <AgentQuestionBox
                key={question.id}
                question={question}
                isLoading={submitting}
                onAnswer={(answer) => setAnswers((prev) => ({ ...prev, [question.id]: answer }))}
              />
            ))}
          </div>
        )}

        {/* Free-text fallback/addition - always available so nothing is lost when no
            questions come back, or the user wants to say something the questions didn't cover. */}
        {!candidate && <div className="space-y-2">
          <label htmlFor="improvement" className="text-xs font-semibold text-gray-300">
            {questions.length > 0 ? "Weitere Anmerkungen (optional):" : "Was soll verbessert werden?"}
          </label>
          <textarea
            id="improvement"
            value={improvement}
            onChange={(e) => setImprovement(e.target.value)}
            placeholder="z.B.: Füge mehr Fehlerbehandlung hinzu, verkürze die Anzahl der Schritte, mache den Plan detaillierter..."
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none resize-none"
            rows={3}
            disabled={submitting}
          />
        </div>}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {submitting && (
          <div className="bg-green-500/10 border border-green-500/20 rounded p-3">
            <p className="text-xs text-green-300">Plan wird überarbeitet...</p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 rounded border border-gray-600 text-sm font-medium text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            onClick={() => candidate ? onRefined(candidate) : void handleSubmit()}
            disabled={submitting || (!candidate && !hasFeedback)}
            className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            {candidate ? "Änderungen übernehmen" : "Plan verbessern"}
          </button>
        </div>
      </div>
    </div>
  );
}
