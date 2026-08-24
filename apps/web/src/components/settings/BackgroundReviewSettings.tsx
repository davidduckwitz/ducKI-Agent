import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, HelpCircle, Save, AlertCircle } from "lucide-react";
import { api } from "../../lib/api";

interface BackgroundReviewSettingsProps {
  settingsMap: Map<string, string>;
}

const KEYS = {
  ENABLED: "BG_REVIEW_ENABLED",
  PROVIDER: "BG_REVIEW_PROVIDER",
  MODEL: "BG_REVIEW_MODEL",
} as const;

const DEFAULTS: Record<string, string> = {
  [KEYS.ENABLED]: "true",
  [KEYS.PROVIDER]: "openrouter",
  [KEYS.MODEL]: "google/gemini-2.0-flash-001",
};

const LABELS: Record<string, string> = {
  [KEYS.ENABLED]: "Hintergrund-Lernanalyse aktivieren",
  [KEYS.PROVIDER]: "Lern-Modell Provider",
  [KEYS.MODEL]: "Lern-Modell Name",
};

const DESCRIPTIONS: Record<string, string> = {
  [KEYS.ENABLED]:
    "Nach jeder Chat-Antwort analysiert ein günstiges Modell die Konversation und schlägt Memory-Einträge oder neue Skills vor. Vorschläge landen im Write-Approval Gate und müssen bestätigt werden.",
  [KEYS.PROVIDER]:
    "Welcher Provider für die Hintergrund-Analyse verwendet wird. 'auto' = der Haupt-Chat-Provider wird genutzt. Ein eigener, günstiger Provider (z.B. OpenRouter mit Flash-Modell) hält die Kosten niedrig.",
  [KEYS.MODEL]:
    "Welches Modell für die Analyse läuft. Ein schnelles, günstiges Modell reicht — die Analyse ist eine einfache Zusammenfassung, kein komplexes Reasoning.",
};

const PROVIDER_OPTIONS = [
  { label: "Auto (Haupt-Provider)", value: "auto" },
  { label: "OpenRouter", value: "openrouter" },
  { label: "OpenAI", value: "openai" },
  { label: "Claude (Anthropic)", value: "claude" },
  { label: "Ollama (lokal)", value: "ollama" },
  { label: "LM Studio (lokal)", value: "lmstudio" },
  { label: "Nous Research", value: "nous" },
];

export function BackgroundReviewSettings({ settingsMap }: BackgroundReviewSettingsProps) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.settings.set(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.refetchQueries({ queryKey: ["settings"] });
      setMessage({ type: "success", text: "Einstellungen gespeichert" });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: () => {
      setMessage({ type: "error", text: "Fehler beim Speichern der Einstellungen" });
    },
  });

  const getValue = (key: string): string => edits[key] ?? settingsMap.get(key) ?? DEFAULTS[key] ?? "";

  const isEnabled = getValue(KEYS.ENABLED).toLowerCase() !== "false";

  const handleSave = (key: string, value: string) => {
    if (value) save.mutate({ key, value });
  };

  const handleToggle = (key: string) => {
    const current = getValue(key).toLowerCase() !== "false";
    handleSave(key, String(!current));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BrainCircuit className="h-5 w-5 text-violet-400" />
        <div>
          <h3 className="font-semibold">Hintergrund-Lernanalyse (Background Review)</h3>
          <p className="text-xs text-muted-foreground">
            Automatisches Lernen aus jedem Chat — Memory-Einträge und Skill-Vorschläge durch eine
            kostengünstige Hintergrund-Analyse
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4">
        {/* Toggle */}
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{LABELS[KEYS.ENABLED]}</span>
              <div className="group relative cursor-help">
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
                <div className="absolute bottom-full left-0 hidden group-hover:block rounded bg-black/80 text-white text-xs p-2 mb-2 w-80 z-10">
                  Die Analyse läuft im Hintergrund, blockiert den Chat nicht und nutzt ein
                  separates, günstiges Modell. Alle Vorschläge müssen manuell bestätigt werden
                  (Write-Approval Gate).
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{DESCRIPTIONS[KEYS.ENABLED]}</p>
          </div>
          <button
            onClick={() => handleToggle(KEYS.ENABLED)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              isEnabled ? "bg-violet-600" : "bg-muted"
            }`}
            title={isEnabled ? "Deaktivieren" : "Aktivieren"}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                isEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Provider */}
        <div
          className={`space-y-2 border-b border-border pb-4 transition-opacity ${
            !isEnabled ? "pointer-events-none opacity-40" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">{LABELS[KEYS.PROVIDER]}</label>
            <span className="text-xs text-muted-foreground">
              Standard: {DEFAULTS[KEYS.PROVIDER]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{DESCRIPTIONS[KEYS.PROVIDER]}</p>
          <div className="flex items-start gap-2">
            <select
              value={getValue(KEYS.PROVIDER)}
              onChange={(e) => setEdits((prev) => ({ ...prev, [KEYS.PROVIDER]: e.target.value }))}
              disabled={!isEnabled}
              className="input flex-1"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => handleSave(KEYS.PROVIDER, getValue(KEYS.PROVIDER))}
              className="btn-primary flex items-center gap-1"
              disabled={save.isPending || !isEnabled}
            >
              <Save className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Model */}
        <div
          className={`space-y-2 transition-opacity ${
            !isEnabled ? "pointer-events-none opacity-40" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">{LABELS[KEYS.MODEL]}</label>
            <span className="text-xs text-muted-foreground">
              Standard: {DEFAULTS[KEYS.MODEL]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{DESCRIPTIONS[KEYS.MODEL]}</p>
          <div className="flex items-start gap-2">
            <input
              type="text"
              value={getValue(KEYS.MODEL)}
              onChange={(e) => setEdits((prev) => ({ ...prev, [KEYS.MODEL]: e.target.value }))}
              placeholder={DEFAULTS[KEYS.MODEL]}
              disabled={!isEnabled}
              className="input flex-1"
            />
            <button
              onClick={() => handleSave(KEYS.MODEL, getValue(KEYS.MODEL))}
              className="btn-primary flex items-center gap-1"
              disabled={save.isPending || !isEnabled}
            >
              <Save className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Tipp: Für OpenRouter sind{" "}
            <code className="rounded bg-muted px-1">google/gemini-2.0-flash-001</code> (günstig, schnell)
            oder <code className="rounded bg-muted px-1">meta-llama/llama-3.3-70b-instruct</code>{" "}
            (lokal via Ollama) gute Optionen.
          </p>
        </div>

        {/* Info box */}
        <div className="space-y-2 rounded bg-violet-500/10 p-3 text-xs text-violet-600">
          <div className="flex gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">So funktioniert's:</p>
              <ul className="space-y-1 pl-4 list-disc">
                <li>Nach <strong>jeder Chat-Antwort</strong> startet eine Hintergrund-Analyse.</li>
                <li>
                  Die Analyse <strong>blockiert den Chat nicht</strong> — du kannst sofort
                  weiterschreiben.
                </li>
                <li>
                  Erkannte Fakten werden als <strong>Memory-Vorschläge</strong> gespeichert (z.B.
                  "Nutzer bevorzugt TypeScript").
                </li>
                <li>
                  Wiederholte Workflows werden als <strong>Skill-Vorschläge</strong> gespeichert
                  (z.B. "Deployment-Checkliste").
                </li>
                <li>
                  <strong>Alle Vorschläge müssen bestätigt werden</strong>, bevor sie aktiv werden
                  — nichts ändert sich automatisch.
                </li>
                <li>
                  Ausstehende Vorschläge findest du unter{" "}
                  <strong>Einstellungen → Memory → Pending</strong>.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {message ? (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-500/10 text-green-600"
              : "bg-red-500/10 text-red-600"
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}