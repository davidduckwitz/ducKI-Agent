import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Sparkles, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { toastManager as toast } from "../../lib/toast";

interface CreatePluginWizardModalProps {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
  onCreated: () => void;
}

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PHASES = ["explore", "plan", "edit", "verify", "report"] as const;
type Phase = (typeof PHASES)[number];
type PhaseStatus = "pending" | "in_progress" | "completed" | "failed";

const PHASE_LABELS: Record<Phase, string> = {
  explore: "Erkunden",
  plan: "Planen",
  edit: "Schreiben",
  verify: "Pruefen",
  report: "Bericht",
};

type PluginCreateEvent = {
  runId: string;
  type: "iteration" | "decision" | "internal_instruction";
  message?: string;
  data?: { phase_event?: "phase_started" | "phase_completed" | "phase_failed"; phase?: Phase };
};

type PluginCreateComplete = {
  runId: string;
  success: boolean;
  name: string;
  error?: string;
  conversationId?: number;
};

/** Slugifies first, THEN truncates - cutting the raw prompt to length before slugifying can
 *  chop a word in half (e.g. "...bitcoin-kurs-von-ein" instead of "...bitcoin-kurs"). Also
 *  trims back to the last full word boundary so a length-cut never leaves a stray fragment. */
function slugify(input: string, maxLength = 40): string {
  const full = input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= maxLength) return full;
  const truncated = full.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
}

export function CreatePluginWizardModal({ open, onClose, existingNames, onCreated }: CreatePluginWizardModalProps) {
  const socket = useAppStore((s) => s.socket);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [category, setCategory] = useState("automation");
  const [needsStorage, setNeedsStorage] = useState(false);
  const [targetHint, setTargetHint] = useState("");

  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [phaseStatuses, setPhaseStatuses] = useState<Record<Phase, PhaseStatus>>({
    explore: "pending",
    plan: "pending",
    edit: "pending",
    verify: "pending",
    report: "pending",
  });
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ success: boolean; error?: string; conversationId?: number } | null>(null);

  const existing = useMemo(() => new Set(existingNames), [existingNames]);
  const nameError = !name
    ? "Name ist erforderlich"
    : !SAFE_NAME.test(name)
      ? "Nur Kleinbuchstaben, Ziffern und Bindestriche (z.B. mein-plugin)"
      : existing.has(name)
        ? "Ein Plugin mit diesem Namen existiert bereits"
        : null;

  useEffect(() => {
    if (!nameTouched) setName(slugify(prompt));
  }, [prompt, nameTouched]);

  useEffect(() => {
    if (!open) {
      // Reset for the next time the modal opens.
      setStep(0);
      setPrompt("");
      setName("");
      setNameTouched(false);
      setCategory("automation");
      setNeedsStorage(false);
      setTargetHint("");
      setRunId(null);
      setStarting(false);
      setPhaseStatuses({ explore: "pending", plan: "pending", edit: "pending", verify: "pending", report: "pending" });
      setLog([]);
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    if (!socket || !runId) return;

    const handleEvent = (event: PluginCreateEvent) => {
      if (event.runId !== runId) return;
      const phase = event.data?.phase;
      const phaseEvent = event.data?.phase_event;
      if (phase && phaseEvent) {
        setPhaseStatuses((prev) => ({
          ...prev,
          [phase]: phaseEvent === "phase_started" ? "in_progress" : phaseEvent === "phase_completed" ? "completed" : "failed",
        }));
      }
      if (event.message) setLog((prev) => [...prev.slice(-49), event.message as string]);
    };
    const handleComplete = (event: PluginCreateComplete) => {
      if (event.runId !== runId) return;
      setResult({ success: event.success, error: event.error, conversationId: event.conversationId });
      if (!event.success) {
        setPhaseStatuses((prev) => {
          const next = { ...prev };
          for (const p of PHASES) if (next[p] === "in_progress") next[p] = "failed";
          return next;
        });
      }
    };

    socket.on("plugin_create_event", handleEvent);
    socket.on("plugin_create_complete", handleComplete);
    return () => {
      socket.off("plugin_create_event", handleEvent);
      socket.off("plugin_create_complete", handleComplete);
    };
  }, [socket, runId]);

  if (!open) return null;

  const isReviewStep = step === 2;
  const isProgressStep = step === 3;

  const summaryText = [
    `Plugin "${name}" (${category})`,
    needsStorage ? "mit eigener SQLite-Ablage" : "ohne persistente Ablage",
    targetHint ? `Ziel-API/Quelle: ${targetHint}` : null,
    "",
    `Auftrag: ${prompt}`,
  ].filter(Boolean).join("\n");

  const start = async () => {
    if (nameError || !prompt.trim()) return;
    setStarting(true);
    setStep(3);
    try {
      const res = await api.plugins.createRun({
        prompt: prompt.trim(),
        name,
        category,
        needsStorage,
        targetHint: targetHint.trim() || undefined,
      });
      setRunId(res.runId);
    } catch (e) {
      setResult({ success: false, error: e instanceof Error ? e.message : "Start fehlgeschlagen" });
    } finally {
      setStarting(false);
    }
  };

  const enableNow = async () => {
    try {
      await api.plugins.enable(name);
      toast.success(`${name} aktiviert`);
      onCreated();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktivieren fehlgeschlagen");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-300" />
            Plugin erstellen
          </h2>
          <button className="text-gray-400 hover:text-white" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {step === 0 && (
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-300 block mb-1">Was soll das Plugin tun?</label>
                <textarea
                  className="input w-full min-h-[100px]"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="z.B. Zeige den aktuellen Bitcoin-Kurs von einer oeffentlichen API"
                />
              </div>
              <div>
                <label className="text-sm text-gray-300 block mb-1">Plugin-Name</label>
                <input
                  className="input w-full"
                  value={name}
                  onChange={(e) => { setNameTouched(true); setName(slugify(e.target.value)); }}
                  placeholder="mein-plugin"
                />
                {nameError && <p className="text-xs text-red-400 mt-1">{nameError}</p>}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-300 block mb-1">Kategorie</label>
                <select className="input w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="overview">Uebersicht</option>
                  <option value="workspace">Workspace</option>
                  <option value="automation">Automatisierung</option>
                  <option value="knowledge">Wissen</option>
                  <option value="system">System</option>
                </select>
              </div>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>Eigene Datenablage (SQLite)</span>
                <input type="checkbox" checked={needsStorage} onChange={(e) => setNeedsStorage(e.target.checked)} />
              </label>
              <div>
                <label className="text-sm text-gray-300 block mb-1">Ziel-API/Datenquelle (optional)</label>
                <input
                  className="input w-full"
                  value={targetHint}
                  onChange={(e) => setTargetHint(e.target.value)}
                  placeholder="z.B. api.coingecko.com"
                />
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-400">
                Trust-Level: <span className="text-gray-200">sandboxed</span> — aus Sicherheitsgruenden fest vorgegeben.
                Agent-erstellte Plugins erhalten nie Code-Ausfuehrungsrechte, OAuth oder eigene Oberflaechen.
              </div>
            </div>
          )}

          {isReviewStep && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-300">Uebersicht</h3>
              <pre className="whitespace-pre-wrap rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-300">{summaryText}</pre>
              <p className="text-xs text-gray-500">
                Das Plugin wird nach erfolgreicher Pruefung erstellt, aber deaktiviert — du aktivierst es danach bewusst selbst.
              </p>
            </div>
          )}

          {isProgressStep && (
            <div className="space-y-3">
              {starting && !runId && <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Starte …</p>}
              <div className="space-y-2">
                {PHASES.map((phase) => {
                  const status = phaseStatuses[phase];
                  return (
                    <div key={phase} className="flex items-center gap-2 text-sm">
                      {status === "completed" && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                      {status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
                      {status === "in_progress" && <Loader2 className="w-4 h-4 animate-spin text-cyan-300" />}
                      {status === "pending" && <div className="w-4 h-4 rounded-full border border-gray-700" />}
                      <span className={status === "pending" ? "text-gray-500" : "text-gray-200"}>{PHASE_LABELS[phase]}</span>
                    </div>
                  );
                })}
              </div>
              {log.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-2 text-[11px] text-gray-400 space-y-0.5">
                  {log.map((line, i) => <div key={i}>{line}</div>)}
                </div>
              )}
              {result && (
                <div className={`rounded-lg border p-3 text-sm ${result.success ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
                  {result.success ? (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span>Plugin "{name}" erstellt (deaktiviert).</span>
                      <div className="flex gap-2 shrink-0">
                        {result.conversationId !== undefined && (
                          <button
                            className="btn-secondary"
                            onClick={() => { onClose(); navigate(`/chat?conversationId=${result.conversationId}`); }}
                          >
                            Im Chat weiterentwickeln
                          </button>
                        )}
                        <button className="btn-primary" onClick={() => void enableNow()}>Jetzt aktivieren</button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p>Fehlgeschlagen: {result.error ?? "Unbekannter Fehler"}</p>
                      <p className="mt-1 text-xs text-red-300/80">Das Plugin wurde nicht aktiviert und erscheint nicht in der Liste. Die geschriebenen Dateien bleiben serverseitig zur Pruefung liegen.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between">
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || isProgressStep}
          >
            <ChevronLeft className="w-4 h-4" /> Zurueck
          </button>

          {isReviewStep ? (
            <button className="btn-primary inline-flex items-center gap-2" onClick={() => void start()} disabled={!!nameError || !prompt.trim()}>
              Erstellen <ChevronRight className="w-4 h-4" />
            </button>
          ) : isProgressStep ? (
            <button className="btn-secondary" onClick={onClose}>
              {result ? "Schliessen" : "Im Hintergrund weiterlaufen lassen"}
            </button>
          ) : (
            <button
              className="btn-primary inline-flex items-center gap-2"
              onClick={() => setStep((s) => Math.min(2, s + 1))}
              disabled={step === 0 && (!!nameError || !prompt.trim())}
            >
              Weiter <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CreatePluginWizardModal;
