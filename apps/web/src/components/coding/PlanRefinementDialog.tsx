import { useState } from "react";
import { AlertCircle, Sparkles, X } from "lucide-react";
import type { Plan } from "../chat/PlanExecutionPanel";

interface PlanRefinementDialogProps {
  plan: Plan;
  onSubmit: (refinementPrompt: string) => void;
  onCancel: () => void;
}

export function PlanRefinementDialog({ plan, onSubmit, onCancel }: PlanRefinementDialogProps) {
  const [improvement, setImprovement] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    if (!improvement.trim()) return;

    setSubmitted(true);

    const refinementPrompt = `
# Plan-Verbesserung angefordert

**Aktueller Plan:** ${plan.goal}

**Verbesserungswunsch:** ${improvement}

**Bisheriger Plan:**
\`\`\`
${plan.markdown || JSON.stringify(plan.steps, null, 2)}
\`\`\`

Bitte überarbeite den Plan basierend auf dem Verbesserungswunsch:
1. Analysiere den aktuellen Plan
2. Identifiziere die angeforderten Verbesserungen
3. Erstelle einen verbesserten Plan mit besseren/klareren Schritten
4. Erkläre kurz, was sich geändert hat und warum
5. Frage am Ende, ob weitere Verbesserungen gewünscht sind

Antworte im folgenden Format:
## Verbesserter Plan
[Plan mit Schritten]

## Änderungen
- [Was sich geändert hat]

## Weitere Verbesserungen?
Möchtest du noch weitere Verbesserungen vornehmen? (Ja/Nein)
`;

    onSubmit(refinementPrompt);
  };

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
            className="p-1 text-gray-400 hover:text-gray-300"
            aria-label="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Info Box */}
        <div className="bg-blue-500/10 border border-blue-500/20 rounded p-3">
          <p className="text-xs text-blue-300">
            Beschreibe, was am Plan verbessert werden soll. Der Agent wird den Plan überarbeiten und einen Verbesserungsvorschlag machen.
          </p>
        </div>

        {/* Current Plan Preview */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-300">Bisheriger Plan:</label>
          <div className="bg-gray-800/50 rounded p-3 max-h-32 overflow-y-auto">
            <p className="text-xs text-gray-400 whitespace-pre-wrap">
              {plan.markdown || JSON.stringify(plan.steps, null, 2)}
            </p>
          </div>
        </div>

        {/* Improvement Input */}
        <div className="space-y-2">
          <label htmlFor="improvement" className="text-xs font-semibold text-gray-300">
            Was soll verbessert werden?
          </label>
          <textarea
            id="improvement"
            value={improvement}
            onChange={(e) => setImprovement(e.target.value)}
            placeholder="z.B.: Füge mehr Fehlerbehandlung hinzu, verkürze die Anzahl der Schritte, mache den Plan detaillierter..."
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none resize-none"
            rows={4}
            disabled={submitted}
          />
        </div>

        {/* Status Message */}
        {submitted && (
          <div className="bg-green-500/10 border border-green-500/20 rounded p-3">
            <p className="text-xs text-green-300">
              Der Agent überarbeitet den Plan...
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={submitted}
            className="px-4 py-2 rounded border border-gray-600 text-sm font-medium text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitted || !improvement.trim()}
            className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            Plan verbessern
          </button>
        </div>
      </div>
    </div>
  );
}
