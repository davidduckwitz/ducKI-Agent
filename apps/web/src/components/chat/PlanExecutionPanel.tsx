import { Play, MessageSquare, X, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { DuckyMascot } from "./DuckyMascot";

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

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

interface PlanExecutionPanelProps {
  plan: Plan;
  onRefine: () => void;
  onExecute: () => void;
  onClose: () => void;
  isExecuting?: boolean;
  /** Real completion percentage. Omit when execution progress cannot be measured -
   *  the panel then shows an indeterminate bar instead of inventing a number. */
  executionProgress?: number;
  /** Status of each step */
  stepStatuses?: Record<number, StepStatus>;
}

export const PlanExecutionPanel = (props: PlanExecutionPanelProps) => {
  try {
    const { plan, onRefine, onExecute, onClose, isExecuting = false, executionProgress } = props;

    if (!plan?.goal) {
      return null;
    }

    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const hasProgress = typeof executionProgress === "number";
    const progress = Math.min(Math.max(executionProgress ?? 0, 0), 100);

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
                  {steps.map((step, idx) => {
                    const status = (props.stepStatuses?.[idx] ?? "pending") as StepStatus;
                    const isCompleted = status === "completed";
                    const isFailed = status === "failed";
                    const isInProgress = status === "in_progress";

                    return (
                      <li
                        key={idx}
                        className={`text-sm p-3 rounded border transition ${
                          isCompleted
                            ? "bg-green-500/10 border-green-500/30"
                            : isFailed
                              ? "bg-red-500/10 border-red-500/30"
                              : isInProgress
                                ? "bg-blue-500/10 border-blue-500/30"
                                : "bg-gray-800/50 border-gray-700/50"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex items-center gap-1">
                            {isCompleted && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                            {isFailed && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                            {isInProgress && (
                              <>
                                <Clock className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                                <DuckyMascot working={true} size={20} className="ml-1" title="DucKI arbeitet daran" />
                              </>
                            )}
                            {status === "pending" && <div className="w-4 h-4 rounded-full border border-gray-500 shrink-0" />}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-300 font-medium">{idx + 1}. {step.title}</span>
                              {status !== "pending" && (
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  isCompleted ? "bg-green-500/20 text-green-300" :
                                  isFailed ? "bg-red-500/20 text-red-300" :
                                  "bg-blue-500/20 text-blue-300"
                                }`}>
                                  {status === "completed" ? "Erledigt" :
                                   status === "failed" ? "Fehler" :
                                   "In Bearbeitung"}
                                </span>
                              )}
                            </div>
                            {step.description && <p className="text-xs text-gray-400 mt-1">{step.description}</p>}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {isExecuting && (
              <div>
                <p className="text-sm text-gray-400">Fortschritt:</p>
                <div className="w-full bg-gray-700 rounded-full h-2 mt-2 overflow-hidden">
                  {hasProgress ? (
                    <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${progress}%` }} />
                  ) : (
                    <div className="bg-blue-500 h-2 w-1/3 rounded-full animate-pulse" />
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {hasProgress ? `${Math.round(progress)}%` : "Umsetzung läuft - Details erscheinen im Chat."}
                </p>
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
