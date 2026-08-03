import { useState } from "react";
import { Terminal, AlertCircle, HelpCircle, Save } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface CodingAgentSettingsProps {
  settingsMap: Map<string, string>;
}

export function CodingAgentSettings({ settingsMap }: CodingAgentSettingsProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const settingKeys = [
    "CODING_AGENT_MAX_ITERATIONS",
    "CODING_AGENT_MAX_ITERATIONS_SIMPLE",
    "CODING_AGENT_MAX_ITERATIONS_MEDIUM",
    "CODING_AGENT_MAX_ITERATIONS_COMPLEX",
    "CODING_AGENT_MAX_ATTEMPTS",
    "CODING_AGENT_TIMEOUT_MS",
  ];

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.settings.set(key, value),
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

  const getDisplayValue = (key: string): string =>
    edits[key] ?? settingsMap.get(key) ?? getDefaultValue(key);

  const handleSaveField = (key: string) => {
    const value = getDisplayValue(key);
    if (value) {
      save.mutate({ key, value });
    }
  };

  const getDefaultValue = (key: string): string => {
    const defaults: Record<string, string> = {
      CODING_AGENT_MAX_ITERATIONS: "100",
      CODING_AGENT_MAX_ITERATIONS_SIMPLE: "20",
      CODING_AGENT_MAX_ITERATIONS_MEDIUM: "50",
      CODING_AGENT_MAX_ITERATIONS_COMPLEX: "100",
      CODING_AGENT_MAX_ATTEMPTS: "3",
      CODING_AGENT_TIMEOUT_MS: "300000",
    };
    return defaults[key] ?? "";
  };

  const getDescription = (key: string): string => {
    const descriptions: Record<string, string> = {
      CODING_AGENT_MAX_ITERATIONS:
        "Maximale Iterationen für den Chat Coding Agent (Standard für alle Plan-Umsetzungen). Bestimmt, wie viele Gedankenschritte der Agent pro Versuch durchlaufen kann.",
      CODING_AGENT_MAX_ITERATIONS_SIMPLE:
        "Maximale Iterationen für einfache Pläne (1-3 Schritte) im Coding-Bereich. Höhere Werte ermöglichen mehr Fehlerbehandlung.",
      CODING_AGENT_MAX_ITERATIONS_MEDIUM:
        "Maximale Iterationen für mittlere Pläne (4-7 Schritte) im Coding-Bereich. Balanciert zwischen Durchsatz und Qualität.",
      CODING_AGENT_MAX_ITERATIONS_COMPLEX:
        "Maximale Iterationen für komplexe Pläne (8+ Schritte) im Coding-Bereich. Ermöglicht umfangreiche Implementierungen.",
      CODING_AGENT_MAX_ATTEMPTS:
        "Anzahl der Retry-Versuche wenn die Verifizierung fehlschlägt. 1-5 wird empfohlen.",
      CODING_AGENT_TIMEOUT_MS:
        "Timeout in Millisekunden für den gesamten Coding Agent Run. Standard: 5 Minuten (300000ms).",
    };
    return descriptions[key] ?? "";
  };

  const getLabel = (key: string): string => {
    const labels: Record<string, string> = {
      CODING_AGENT_MAX_ITERATIONS: "Max Iterationen (Chat)",
      CODING_AGENT_MAX_ITERATIONS_SIMPLE: "Max Iterationen (einfach)",
      CODING_AGENT_MAX_ITERATIONS_MEDIUM: "Max Iterationen (mittel)",
      CODING_AGENT_MAX_ITERATIONS_COMPLEX: "Max Iterationen (komplex)",
      CODING_AGENT_MAX_ATTEMPTS: "Max Retry-Versuche",
      CODING_AGENT_TIMEOUT_MS: "Timeout (ms)",
    };
    return labels[key] ?? key;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Terminal className="h-5 w-5 text-blue-500" />
        <div>
          <h3 className="font-semibold">Coding Agent Konfiguration</h3>
          <p className="text-xs text-muted-foreground">
            Passen Sie die Iteration und Timeout-Limits des Coding Agents an
          </p>
        </div>
      </div>

      {/* Settings Grid */}
      <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4">
        {/* Iterations Settings */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Iterationslimits</h4>
            <div className="group relative cursor-help">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              <div className="absolute bottom-full right-0 hidden group-hover:block rounded bg-black/80 text-white text-xs p-2 mb-2 whitespace-nowrap z-10">
                Höhere Werte ermöglichen längere Ausführungen, verbrauchen aber mehr Ressourcen
              </div>
            </div>
          </div>
          <div className="space-y-3 pl-4">
            {[
              "CODING_AGENT_MAX_ITERATIONS_SIMPLE",
              "CODING_AGENT_MAX_ITERATIONS_MEDIUM",
              "CODING_AGENT_MAX_ITERATIONS_COMPLEX",
            ].map((key: string) => (
              <div key={key} className="space-y-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
                <label className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{getLabel(key)}</span>
                  <span className="text-xs text-muted-foreground">Standard: {getDefaultValue(key)}</span>
                </label>
                <p className="text-xs text-muted-foreground">{getDescription(key)}</p>
                <div className="flex gap-2 items-start">
                  <input
                    type="number"
                    min="5"
                    max="500"
                    step="5"
                    value={getDisplayValue(key)}
                    onChange={(e) => setEdits(prev => ({ ...prev, [key]: e.target.value }))}
                    className="input flex-1"
                  />
                  <button
                    onClick={() => handleSaveField(key)}
                    className="btn-primary flex items-center gap-1"
                    disabled={save.isPending}
                  >
                    <Save className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Attempts and Timeout */}
        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-medium">Retry & Timeout</h4>
          <div className="space-y-3 pl-4">
            {[
              "CODING_AGENT_MAX_ATTEMPTS",
              "CODING_AGENT_TIMEOUT_MS",
            ].map((key: string) => (
              <div key={key} className="space-y-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
                <label className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{getLabel(key)}</span>
                  <span className="text-xs text-muted-foreground">Standard: {getDefaultValue(key)}</span>
                </label>
                <p className="text-xs text-muted-foreground">{getDescription(key)}</p>
                <div className="flex gap-2 items-start">
                  <input
                    type="number"
                    min={key === "CODING_AGENT_MAX_ATTEMPTS" ? 1 : 30000}
                    step={key === "CODING_AGENT_MAX_ATTEMPTS" ? 1 : 10000}
                    value={getDisplayValue(key)}
                    onChange={(e) => setEdits(prev => ({ ...prev, [key]: e.target.value }))}
                    className="input flex-1"
                  />
                  <button
                    onClick={() => handleSaveField(key)}
                    className="btn-primary flex items-center gap-1"
                    disabled={save.isPending}
                  >
                    <Save className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Info Box */}
        <div className="space-y-2 rounded bg-blue-500/10 p-3 text-xs text-blue-600">
          <div className="flex gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Tipps zum Anpassen:</p>
              <ul className="space-y-1 pl-4 list-disc">
                <li>Höhere Iterationen = bessere Fehlerbehandlung, aber längere Laufzeiten</li>
                <li>Max Attempts sollte 1-5 sein. Höher = sehr lange Ausführungen</li>
                <li>Timeout in Millisekunden: 300000 = 5 Min, 600000 = 10 Min</li>
                <li>Änderungen gelten nur für neue Plan-Ausführungen</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Status Message */}
      {message && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-500/10 text-green-600"
              : "bg-red-500/10 text-red-600"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
