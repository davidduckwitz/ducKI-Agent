import { Play, MessageSquare, X } from "lucide-react";

export interface Plan {
  id?: number;
  goal: string;
  title?: string;
  complexity?: number;
  steps?: Array<{ title: string; description: string; tools?: string[] }>;
  tools?: string[];
  markdown?: string;
  status?: string;
  createdAt?: string;
}

interface PlanExecutionPanelProps {
  plan: Plan;
  onRefine: () => void;
  onExecute: () => void;
  onClose: () => void;
  isExecuting?: boolean;
  executionProgress?: number;
}

export const PlanExecutionPanel = (props: PlanExecutionPanelProps) => {
  try {
    const { plan, onRefine, onExecute, onClose, isExecuting = false, executionProgress = 0 } = props;

    if (!plan?.goal) {
      return null;
    }

    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const progress = Math.min(Math.max(executionProgress || 0, 0), 100);

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
          {/* Header */}
          <div className="sticky top-0 bg-gray-900 border-b border-gray-700 p-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">{plan.title || "Plan"}</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-white" disabled={isExecuting}>
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4">
            <div>
              <p className="text-sm text-gray-400">Ziel:</p>
              <p className="text-gray-100 mt-1">{plan.goal}</p>
            </div>

            {typeof plan.complexity === "number" && (
              <div>
                <p className="text-sm text-gray-400">Komplexität:</p>
                <div className="flex gap-1 mt-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div
                      key={i}
                      className={`w-3 h-3 rounded-full ${
                        plan.complexity && i <= plan.complexity ? "bg-blue-500" : "bg-gray-600"
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}

            {steps.length > 0 && (
              <div>
                <p className="text-sm text-gray-400">Schritte ({steps.length}):</p>
                <ul className="space-y-2 mt-2">
                  {steps.map((step, idx) => (
                    <li key={idx} className="text-sm bg-gray-800/50 p-2 rounded">
                      <span className="text-gray-500 font-medium">{idx + 1}.</span> {step.title}
                      {step.description && <p className="text-xs text-gray-400 mt-1">{step.description}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isExecuting && (
              <div>
                <p className="text-sm text-gray-400">Fortschritt:</p>
                <div className="w-full bg-gray-700 rounded-full h-2 mt-2">
                  <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${progress}%` }} />
                </div>
                <p className="text-xs text-gray-400 mt-1">{Math.round(progress)}%</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="bg-gray-800 border-t border-gray-700 p-4 flex gap-3 justify-end">
            <button
              onClick={onClose}
              disabled={isExecuting}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
            >
              Schließen
            </button>
            <button
              onClick={onRefine}
              disabled={isExecuting}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <MessageSquare className="w-4 h-4" />
              Plan verbessern
            </button>
            <button
              onClick={onExecute}
              disabled={isExecuting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm text-white flex items-center gap-2 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {isExecuting ? "Läuft..." : "Umsetzen"}
            </button>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    console.error("PlanExecutionPanel error:", err);
    return null;
  }
};
