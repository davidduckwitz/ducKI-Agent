import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, HelpCircle, Save, AlertCircle, Zap } from "lucide-react";
import { api } from "../../lib/api";

interface BotsSettingsProps {
  settingsMap: Map<string, string>;
}

/**
 * Controls the timeouts/limits for custom bots and the group "bot chat" feature - all of these
 * used to be hardcoded constants that cut exchanges off too early for a multi-step task (see
 * BotChatOrchestrator's old MAX_ROUNDS=3/MAX_MESSAGES_PER_ROUND=10). Mirrors
 * CodingAgentSettings.tsx's pattern: per-field local edit state, per-field save button, no
 * refetch until saved.
 */
export function BotsSettings({ settingsMap }: BotsSettingsProps) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [toggleAnimating, setToggleAnimating] = useState(false);

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

  const defaults: Record<string, string> = {
    BOT_CHAT_MAX_ROUNDS: "6",
    BOT_CHAT_MAX_MESSAGES_PER_ROUND: "20",
    BOT_CHAT_PARALLEL_ENABLED: "true",
    BOT_CHAT_PARALLEL_MAX_CONCURRENT: "4",
    BOT_AGENT_MAX_ITERATIONS: "50",
    BOT_AGENT_TIMEOUT_MS: "600000",
  };

  const labels: Record<string, string> = {
    BOT_CHAT_MAX_ROUNDS: "Max. Runden pro Gruppen-Chat-Nachricht",
    BOT_CHAT_MAX_MESSAGES_PER_ROUND: "Max. Bots pro Runde",
    BOT_CHAT_PARALLEL_ENABLED: "Parallele Bot-Ausführung",
    BOT_CHAT_PARALLEL_MAX_CONCURRENT: "Max. gleichzeitige Bots",
    BOT_AGENT_MAX_ITERATIONS: "Max. Iterationen pro Bot-Zug",
    BOT_AGENT_TIMEOUT_MS: "Timeout pro Bot-Zug (ms)",
  };

  const descriptions: Record<string, string> = {
    BOT_CHAT_MAX_ROUNDS:
      "Wie oft ein Gruppen-Chat nach der ersten Nutzer-Nachricht noch weiterlaufen darf, wenn Bots sich gegenseitig @erwähnen (z.B. \"@eddy recherchiere, @main ergänze danach\" braucht mehrere Runden). Zu niedrig = der Austausch bricht ab, bevor die Aufgabe fertig ist.",
    BOT_CHAT_MAX_MESSAGES_PER_ROUND:
      "Wie viele Bots innerhalb einer einzelnen Runde gleichzeitig antworten dürfen. Nur relevant bei vielen Teilnehmern in einem Chat.",
    BOT_CHAT_PARALLEL_ENABLED:
      "Bots in der ersten Runde parallel statt nacheinander ausführen — Broadcast-Nachrichten (ohne sequenzielle \"dann\"/\"danach\" Cues) werden 3-4x schneller. Bot-@Erwähnungen in Folgerunden bleiben immer sequenziell.",
    BOT_CHAT_PARALLEL_MAX_CONCURRENT:
      "Wie viele Bots MAXIMAL gleichzeitig laufen dürfen (begrenzt API-Rate-Limits). Unabhängige Bots in einem Parallel-Batch werden auf dieses Limit gedeckelt.",
    BOT_AGENT_MAX_ITERATIONS:
      "Wie viele Werkzeug-Aufrufe/Denkschritte ein einzelner Bot innerhalb EINES Zuges (einer Antwort) durchführen darf, bevor er abbrechen muss. Zu niedrig = der Bot bricht mitten in einer mehrstufigen Aufgabe (z.B. Recherche + Bericht) ab.",
    BOT_AGENT_TIMEOUT_MS:
      "Wie lange ein einzelner Bot-Zug maximal laufen darf, bevor er als fehlgeschlagen gilt (dann erscheint eine sichtbare Fehlermeldung im Chat statt endlosem Warten). In Millisekunden: 300000 = 5 Min, 600000 = 10 Min.",
  };

  const getDisplayValue = (key: string): string => edits[key] ?? settingsMap.get(key) ?? defaults[key] ?? "";

  const handleSaveField = (key: string) => {
    const value = getDisplayValue(key);
    if (value) save.mutate({ key, value });
  };

  const handleToggle = (key: string) => {
    const current = getDisplayValue(key).toLowerCase() !== "false";
    setEdits((prev) => ({ ...prev, [key]: String(!current) }));
    handleSaveField(key);
    setToggleAnimating(true);
    setTimeout(() => setToggleAnimating(false), 400);
  };

  const formatMs = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    if (ms < 60000) return `${Math.round(ms / 1000)} s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes} Min ${seconds} s` : `${minutes} Min`;
  };

  const renderField = (key: string, opts: { min: number; step: number; max?: number }) => (
    <div key={key} className="space-y-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
      <label className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{labels[key]}</span>
        <span className="text-xs text-muted-foreground">
          Standard: {defaults[key]}
          {key === "BOT_AGENT_TIMEOUT_MS" ? ` (${formatMs(Number(defaults[key]))})` : ""}
        </span>
      </label>
      <p className="text-xs text-muted-foreground">{descriptions[key]}</p>
      <div className="flex items-start gap-2">
        <input
          type="number"
          min={opts.min}
          max={opts.max}
          step={opts.step}
          value={getDisplayValue(key)}
          onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
          className="input flex-1"
        />
        <button onClick={() => handleSaveField(key)} className="btn-primary flex items-center gap-1" disabled={save.isPending}>
          <Save className="w-4 h-4" />
        </button>
      </div>
      {key === "BOT_AGENT_TIMEOUT_MS" ? (
        <p className="text-xs text-muted-foreground">
          Aktuell: {formatMs(Number(getDisplayValue(key)) || 0)}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bot className="h-5 w-5 text-primary" />
        <div>
          <h3 className="font-semibold">Bots & Gruppen-Chat Konfiguration</h3>
          <p className="text-xs text-muted-foreground">
            Timeouts und Limits für eigene Bots und den Gruppen-Chat mehrerer Bots
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Gruppen-Chat</h4>
            <div className="group relative cursor-help">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              <div className="absolute bottom-full left-0 hidden group-hover:block rounded bg-black/80 text-white text-xs p-2 mb-2 w-72 z-10">
                Diese Werte bestimmen, wann der Orchestrator einen Gruppen-Chat-Austausch als
                "fertig" ansieht, statt weitere Bot-Antworten zuzulassen.
              </div>
            </div>
          </div>
          <div className="space-y-3 pl-4">
            {renderField("BOT_CHAT_MAX_ROUNDS", { min: 1, max: 20, step: 1 })}
            {renderField("BOT_CHAT_MAX_MESSAGES_PER_ROUND", { min: 1, max: 50, step: 1 })}
          </div>
        </div>

        {/* Parallel Execution */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Parallele Ausführung</h4>
            <div className="group relative cursor-help">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              <div className="absolute bottom-full left-0 hidden group-hover:block rounded bg-black/80 text-white text-xs p-2 mb-2 w-80 z-10">
                Wenn aktiviert, laufen unabhängige Bots (Broadcast, nicht-sequenzielle @Erwähnungen)
                in der ersten Runde parallel statt nacheinander — 3-4x schneller. Sequenzielle
                Cue-Words ("dann", "danach", "once that's done") erzwingen weiterhin sequenzielle
                Ausführung.
              </div>
            </div>
          </div>
          <div className="space-y-3 pl-4">
            {/* Toggle for parallel enabled */}
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="space-y-1">
                <span className="text-sm font-medium text-foreground">
                  {labels["BOT_CHAT_PARALLEL_ENABLED"]}
                </span>
                <p className="text-xs text-muted-foreground">
                  {descriptions["BOT_CHAT_PARALLEL_ENABLED"]}
                </p>
              </div>
              <button
                onClick={() => handleToggle("BOT_CHAT_PARALLEL_ENABLED")}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  toggleAnimating ? "animate-toggle-flash" : ""
                } ${
                  getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() !== "false"
                    ? "bg-emerald-600"
                    : "bg-muted"
                }`}
                title={
                  getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() !== "false"
                    ? "Deaktivieren"
                    : "Aktivieren"
                }
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    toggleAnimating ? "animate-toggle-pop" : ""
                  } ${
                    getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() !== "false"
                      ? "translate-x-6"
                      : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Slider for max concurrent */}
            <div
              className={`space-y-1 border-b border-border pb-3 last:border-b-0 last:pb-0 transition-opacity ${
                getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() === "false"
                  ? "pointer-events-none opacity-40"
                  : ""
              }`}
            >
              <label className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">
                  {labels["BOT_CHAT_PARALLEL_MAX_CONCURRENT"]}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Zap className="h-3 w-3 text-emerald-400" />
                  <span>{getDisplayValue("BOT_CHAT_PARALLEL_MAX_CONCURRENT")} Bots gleichzeitig</span>
                </span>
              </label>
              <p className="text-xs text-muted-foreground">
                {descriptions["BOT_CHAT_PARALLEL_MAX_CONCURRENT"]}
              </p>
              <div className="flex items-start gap-2">
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={getDisplayValue("BOT_CHAT_PARALLEL_MAX_CONCURRENT")}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      ["BOT_CHAT_PARALLEL_MAX_CONCURRENT"]: e.target.value,
                    }))
                  }
                  disabled={
                    getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() === "false"
                  }
                  className="flex-1"
                />
                <button
                  onClick={() => handleSaveField("BOT_CHAT_PARALLEL_MAX_CONCURRENT")}
                  className="btn-primary flex items-center gap-1"
                  disabled={
                    save.isPending ||
                    getDisplayValue("BOT_CHAT_PARALLEL_ENABLED").toLowerCase() === "false"
                  }
                >
                  <Save className="w-4 h-4" />
                </button>
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1 (langsam)</span>
                <span>8 (schnell, viele API-Calls)</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-medium">Einzelner Bot-Zug</h4>
          <div className="space-y-3 pl-4">
            {renderField("BOT_AGENT_MAX_ITERATIONS", { min: 5, max: 300, step: 5 })}
            {renderField("BOT_AGENT_TIMEOUT_MS", { min: 30000, step: 30000 })}
          </div>
        </div>

        <div className="space-y-2 rounded bg-blue-500/10 p-3 text-xs text-blue-600">
          <div className="flex gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Hinweise:</p>
              <ul className="space-y-1 pl-4 list-disc">
                <li>Diese Einstellungen gelten für alle eigenen Bots und Gruppen-Chats - nicht für den Haupt-Chat oder den Coding Agent (die haben eigene Limits unter "Agent").</li>
                <li>Höhere Werte = zuverlässigere Ergebnisse bei mehrstufigen Aufgaben, aber längere Wartezeit und mehr Tokenverbrauch, falls ein Bot sich verrennt.</li>
                <li>Wenn ein Bot-Zug abbricht (Fehler oder Timeout), erscheint jetzt eine sichtbare ⚠️-Nachricht im Chat statt stillem Abbruch.</li>
                <li>Änderungen gelten für die nächste Nachricht, laufende Läufe werden nicht unterbrochen.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {message ? (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
