import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Sparkles, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { api, type PluginBuilderArchetype, type PluginBuilderSpec, type PluginScaffoldPreview } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { toastManager as toast } from "../../lib/toast";

interface CreatePluginWizardModalProps {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
  onCreated: () => void;
  /** Set when reopening this modal to watch/continue a draft whose builder run was already
   *  (re)started server-side (see PluginsPage's "Fortsetzen" action on a draft card). Jumps
   *  straight to the progress step and subscribes to that run's socket events instead of
   *  starting the normal from-scratch wizard flow. */
  resumeRun?: { name: string; runId: string } | null;
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
  stopped?: boolean;
};

type PluginCreateStarted = {
  runId: string;
  conversationId: number;
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

export function CreatePluginWizardModal({ open, onClose, existingNames, onCreated, resumeRun }: CreatePluginWizardModalProps) {
  const socket = useAppStore((s) => s.socket);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("🔌");
  const [nameTouched, setNameTouched] = useState(false);
  const [category, setCategory] = useState("automation");
  const [archetype, setArchetype] = useState<PluginBuilderArchetype>("data-source");
  const [targetHint, setTargetHint] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [authentication, setAuthentication] = useState<"none" | "api-key" | "bearer">("none");
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.example.com/v1");
  const [llmModel, setLlmModel] = useState("default-model");
  const [llmApiKeyRequired, setLlmApiKeyRequired] = useState(true);
  const [llmVision, setLlmVision] = useState(false);
  const [widgets, setWidgets] = useState<NonNullable<PluginBuilderSpec["widgets"]>>([
    { id: "main", title: "Widget", placement: "dashboard", align: "full", frame: "card", background: "card", height: 160, width: "full" },
  ]);
  const [preview, setPreview] = useState<PluginScaffoldPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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
  const [result, setResult] = useState<{ success: boolean; error?: string; conversationId?: number; stopped?: boolean } | null>(null);
  const [liveConversationId, setLiveConversationId] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);

  const existing = useMemo(() => new Set(existingNames), [existingNames]);
  const nameError = !name
    ? "Name ist erforderlich"
    : !SAFE_NAME.test(name)
      ? "Nur Kleinbuchstaben, Ziffern und Bindestriche (z.B. mein-plugin)"
      : existing.has(name)
        ? "Ein Plugin mit diesem Namen existiert bereits"
        : null;

  useEffect(() => {
    if (!nameTouched) setName(slugify(displayName || prompt));
  }, [prompt, displayName, nameTouched]);

  useEffect(() => {
    if (!open) {
      // Reset for the next time the modal opens.
      setStep(0);
      setPrompt("");
      setName("");
      setDisplayName("");
      setDescription("");
      setIcon("🔌");
      setNameTouched(false);
      setCategory("automation");
      setArchetype("data-source");
      setTargetHint("");
      setApiBaseUrl("");
      setAuthentication("none");
      setAllowedHostsText("");
      setLlmBaseUrl("https://api.example.com/v1");
      setLlmModel("default-model");
      setLlmApiKeyRequired(true);
      setLlmVision(false);
      setWidgets([{ id: "main", title: "Widget", placement: "dashboard", align: "full", frame: "card", background: "card", height: 160, width: "full" }]);
      setPreview(null);
      setPreviewError(null);
      setRunId(null);
      setStarting(false);
      setPhaseStatuses({ explore: "pending", plan: "pending", edit: "pending", verify: "pending", report: "pending" });
      setLog([]);
      setResult(null);
      setLiveConversationId(null);
      setStopping(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !resumeRun) return;
    setName(resumeRun.name);
    setStep(3);
    setStarting(false);
    setRunId(resumeRun.runId);
  }, [open, resumeRun]);

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
    const handleStarted = (event: PluginCreateStarted) => {
      if (event.runId !== runId) return;
      setLiveConversationId(event.conversationId);
    };
    const handleComplete = (event: PluginCreateComplete) => {
      if (event.runId !== runId) return;
      setResult({ success: event.success, error: event.error, conversationId: event.conversationId, stopped: event.stopped });
      setStopping(false);
      if (!event.success) {
        setPhaseStatuses((prev) => {
          const next = { ...prev };
          for (const p of PHASES) if (next[p] === "in_progress") next[p] = "failed";
          return next;
        });
      }
    };

    socket.on("plugin_create_started", handleStarted);
    socket.on("plugin_create_event", handleEvent);
    socket.on("plugin_create_complete", handleComplete);
    return () => {
      socket.off("plugin_create_started", handleStarted);
      socket.off("plugin_create_event", handleEvent);
      socket.off("plugin_create_complete", handleComplete);
    };
  }, [socket, runId]);

  const isReviewStep = step === 2;
  const isProgressStep = step === 3;

  const builderSpec: PluginBuilderSpec = {
    name,
    displayName: displayName.trim() || name,
    description: description.trim() || prompt.trim(),
    icon: icon.trim() || undefined,
    category: category as PluginBuilderSpec["category"],
    archetype,
    userRequest: prompt.trim(),
    targetHint: targetHint.trim() || undefined,
    allowedHosts: allowedHostsText.split(/[,\n]/).map((host) => host.trim()).filter(Boolean),
    ...(archetype === "data-source" ? { api: { baseUrl: apiBaseUrl.trim() || undefined, authentication } } : {}),
    ...(archetype === "llm-provider" ? { llmProvider: {
      protocol: "openai-compatible" as const,
      defaultBaseUrl: llmBaseUrl.trim(), defaultModel: llmModel.trim(), apiKeyRequired: llmApiKeyRequired,
      supportsStreaming: true, supportsTools: true, supportsVision: llmVision,
    } } : {}),
    ...(archetype === "widget" ? { widgets } : {}),
  };

  useEffect(() => {
    if (!open || step !== 2 || nameError || !prompt.trim()) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void api.plugins.previewScaffold(builderSpec)
      .then((value) => { if (!cancelled) setPreview(value); })
      .catch((error) => { if (!cancelled) { setPreview(null); setPreviewError(error instanceof Error ? error.message : "Vorschau fehlgeschlagen"); } })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
    // Preview is intentionally refreshed when entering the review step; editing happens on prior steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  if (!open) return null;

  const summaryText = [
    `${displayName || name} · ${archetype} · ${category}`,
    archetype === "storage-tool" ? "mit eigener SQLite-Ablage" : null,
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
        ...builderSpec,
      });
      setRunId(res.runId);
    } catch (e) {
      setResult({ success: false, error: e instanceof Error ? e.message : "Start fehlgeschlagen" });
    } finally {
      setStarting(false);
    }
  };

  const stopRun = () => {
    if (!socket || liveConversationId === null) return;
    setStopping(true);
    socket.emit("chat:stop", { conversationId: liveConversationId });
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
              <div className="grid grid-cols-[1fr_80px] gap-3">
                <div>
                  <label className="text-sm text-gray-300 block mb-1">Anzeigename</label>
                  <input className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Mein Plugin" />
                </div>
                <div>
                  <label className="text-sm text-gray-300 block mb-1">Icon</label>
                  <input className="input w-full text-center" value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={16} />
                </div>
              </div>
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
                <label className="text-sm text-gray-300 block mb-1">Kurzbeschreibung</label>
                <input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ein Satz für Plugin-Liste und Manifest" />
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
                <label className="text-sm text-gray-300 block mb-2">Plugin-Typ</label>
                <div className="grid gap-2 sm:grid-cols-3">
                  {([
                    ["data-source", "🌐 Datenquelle", "Deklarative HTTP-API ohne ausführbaren Node-Code"],
                    ["storage-tool", "🗄️ SQLite-Tool", "Sandboxed Tool mit eigener Datenbank"],
                    ["llm-provider", "🧠 LLM-Provider", "Gesperrte OpenAI-kompatible Host-Vorlage"],
                    ["widget", "🧩 Widgets", "Mehrere frei platzierbare iframe-Oberflächen"],
                  ] as const).map(([value, label, help]) => (
                    <button key={value} type="button" onClick={() => setArchetype(value)} className={`rounded-lg border p-3 text-left ${archetype === value ? "border-primary bg-primary/10" : "border-gray-800 bg-gray-900"}`}>
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="mt-1 block text-[11px] text-gray-400">{help}</span>
                    </button>
                  ))}
                </div>
              </div>
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
              <div>
                <label className="text-sm text-gray-300 block mb-1">Ziel-API/Datenquelle (optional)</label>
                <input
                  className="input w-full"
                  value={targetHint}
                  onChange={(e) => setTargetHint(e.target.value)}
                  placeholder="z.B. api.coingecko.com"
                />
              </div>
              {archetype === "data-source" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-sm text-gray-300 block mb-1">API Base URL</label>
                    <input className="input w-full" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                  </div>
                  <div>
                    <label className="text-sm text-gray-300 block mb-1">Authentifizierung</label>
                    <select className="input w-full" value={authentication} onChange={(e) => setAuthentication(e.target.value as typeof authentication)}>
                      <option value="none">Keine</option><option value="api-key">API-Key</option><option value="bearer">Bearer Token</option>
                    </select>
                  </div>
                </div>
              )}
              {archetype === "llm-provider" && (
                <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-3">
                  <p className="text-xs text-gray-400">Protokoll: OpenAI-kompatibel. Das System erzeugt und sperrt den Provider-Code.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input className="input" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                    <input className="input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="default-model" />
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2"><input type="checkbox" checked={llmApiKeyRequired} onChange={(e) => setLlmApiKeyRequired(e.target.checked)} /> API-Key</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={llmVision} onChange={(e) => setLlmVision(e.target.checked)} /> Vision</label>
                    <span className="text-gray-500">Streaming + Tool Calls aktiv</span>
                  </div>
                </div>
              )}
              {archetype === "widget" && (
                <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-400">Jedes Widget erhält eine eigene HTML-Datei.</p>
                    <button type="button" className="btn-secondary text-xs" onClick={() => setWidgets((current) => [...current, { id: `widget-${current.length + 1}`, title: `Widget ${current.length + 1}`, placement: "dashboard", align: "full", frame: "card", background: "card", height: 160, width: "full" }])}>+ Widget</button>
                  </div>
                  {widgets.map((widget, index) => (
                    <div key={`${widget.id}:${index}`} className="grid gap-2 rounded border border-gray-800 p-2 sm:grid-cols-4">
                      <input className="input" value={widget.id} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, id: slugify(e.target.value, 64) } : item))} placeholder="widget-id" />
                      <input className="input" value={widget.title ?? ""} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, title: e.target.value } : item))} placeholder="Titel" />
                      <select className="input" value={widget.placement} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, placement: e.target.value as typeof item.placement } : item))}>
                        <option value="dashboard">Dashboard</option><option value="topbar">Topbar</option><option value="footer">Footer</option>
                        <option value="sidebar-above-logo">Sidebar über Logo</option><option value="sidebar-before-mode">Sidebar vor Modus</option><option value="sidebar-after-mode">Sidebar nach Modus</option><option value="sidebar-content">Sidebar Content</option>
                      </select>
                      <select className="input" value={widget.align} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, align: e.target.value as typeof item.align } : item))}><option value="left">Links</option><option value="center">Mitte</option><option value="right">Rechts</option><option value="full">Full</option></select>
                      <select className="input" value={widget.frame} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, frame: e.target.value as typeof item.frame } : item))}><option value="card">Mit Rahmen</option><option value="borderless">Ohne Rahmen</option></select>
                      <select className="input" value={widget.background} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, background: e.target.value as typeof item.background } : item))}><option value="card">Card-Hintergrund</option><option value="transparent">Transparent</option><option value="inherit">Geerbt</option></select>
                      <select className="input" value={String(widget.width)} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, width: e.target.value as "auto" | "sm" | "md" | "lg" | "full" } : item))}><option value="auto">Auto</option><option value="sm">Klein</option><option value="md">Mittel</option><option value="lg">Breit</option><option value="full">Full</option></select>
                      <input className="input" type="number" min={20} max={800} value={widget.height} onChange={(e) => setWidgets((current) => current.map((item, i) => i === index ? { ...item, height: Number(e.target.value) } : item))} title="Höhe in Pixel" />
                      <button type="button" className="btn-secondary text-xs" disabled={widgets.length === 1} onClick={() => setWidgets((current) => current.filter((_, i) => i !== index))}>Entfernen</button>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <label className="text-sm text-gray-300 block mb-1">Erlaubte Hosts (optional, Komma oder Zeile)</label>
                <input className="input w-full" value={allowedHostsText} onChange={(e) => setAllowedHostsText(e.target.value)} placeholder="api.example.com" />
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-400">
                Trust-Level: <span className="text-gray-200">{archetype === "llm-provider" ? "node (gesperrte Systemvorlage)" : "sandboxed"}</span>.
                Der Agent darf ausschließlich die in der nächsten Ansicht markierten Dateien bearbeiten.
              </div>
            </div>
          )}

          {isReviewStep && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-300">Uebersicht</h3>
              <pre className="whitespace-pre-wrap rounded-lg border border-gray-800 bg-gray-900 p-3 text-xs text-gray-300">{summaryText}</pre>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                <h4 className="mb-2 text-sm font-medium">Vom System geplante Struktur</h4>
                {previewLoading && <p className="text-xs text-gray-400">Erzeuge Vorschau …</p>}
                {previewError && <p className="text-xs text-red-400">{previewError}</p>}
                <div className="space-y-1">
                  {preview?.files.map((file) => (
                    <div key={file.path} className="flex items-center justify-between gap-3 text-xs">
                      <code>{file.path}</code>
                      <span className={file.owner === "system" ? "text-amber-300" : "text-cyan-300"}>{file.owner === "system" ? "🔒 System" : "✎ Agent"}</span>
                    </div>
                  ))}
                </div>
              </div>
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
                <div
                  className={`rounded-lg border p-3 text-sm ${
                    result.success
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : result.stopped
                        ? "border-gray-700 bg-gray-900 text-gray-300"
                        : "border-red-500/30 bg-red-500/10 text-red-200"
                  }`}
                >
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
                  ) : result.stopped ? (
                    <p>Gestoppt. Der Entwurf bleibt unter "Unfertige Entwürfe" sichtbar — dort kannst du ihn fortsetzen oder löschen.</p>
                  ) : (
                    <div>
                      <p>Fehlgeschlagen: {result.error ?? "Unbekannter Fehler"}</p>
                      <p className="mt-1 text-xs text-red-300/80">Das Plugin wurde nicht aktiviert und erscheint nicht in der Plugin-Liste. Der Entwurf bleibt aber unter "Unfertige Entwürfe" sichtbar — dort kannst du ihn fortsetzen oder löschen.</p>
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
            <button className="btn-primary inline-flex items-center gap-2" onClick={() => void start()} disabled={!!nameError || !prompt.trim() || !preview || !!previewError || previewLoading}>
              Erstellen <ChevronRight className="w-4 h-4" />
            </button>
          ) : isProgressStep ? (
            <div className="flex gap-2">
              {!result && liveConversationId !== null && (
                <button
                  className="rounded border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  onClick={stopRun}
                  disabled={stopping}
                >
                  {stopping ? "Stoppe …" : "Stoppen"}
                </button>
              )}
              <button className="btn-secondary" onClick={onClose}>
                {result ? "Schliessen" : "Im Hintergrund weiterlaufen lassen"}
              </button>
            </div>
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
