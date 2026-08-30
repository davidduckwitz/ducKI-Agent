import { useState } from "react";
import { Terminal, AlertCircle, HelpCircle, Save } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AgentModelProfileSettings } from "./AgentModelProfileSettings";

interface CodingAgentSettingsProps {
  settingsMap: Map<string, string>;
}

export function CodingAgentSettings({ settingsMap }: CodingAgentSettingsProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // Live preview: simulate a plan size and show which budget/timeout a run would get.
  const [previewSteps, setPreviewSteps] = useState(4);

  const settingKeys = [
    "CODING_AGENT_MAX_ITERATIONS",
    "CODING_AGENT_MAX_ITERATIONS_SIMPLE",
    "CODING_AGENT_MAX_ITERATIONS_MEDIUM",
    "CODING_AGENT_MAX_ITERATIONS_COMPLEX",
    "CODING_AGENT_MAX_ATTEMPTS",
    "CODING_AGENT_TIMEOUT_MS",
    "CODING_AGENT_EXPLORE_TIMEOUT_MS",
    "CODING_AGENT_ENABLE_VERIFY",
    "AGENT_CODING_ALLOW_GIT_COMMIT",
    "CODING_AGENT_PREPLAN_RESEARCH",
    "CODING_AGENT_PREPLAN_MAX_TOOL_CALLS",
    "CODING_AGENT_STALE_READ_RECOVERY",
    "CODING_AGENT_STALE_READ_REQUIRE_SAME_CONTENT",
    "CODING_AGENT_STALE_READ_MAX_RECOVERIES",
    "CODING_AGENT_ENFORCE_TOOL_ALLOWLIST",
    "CODING_AGENT_BROWSER_VERIFY_REPAIR_ATTEMPTS",
    "CODING_AGENT_BROWSER_RUNTIME_REPAIR_PROTOCOL",
    "CODING_AGENT_BROWSER_PREFLIGHT",
    "CODING_AGENT_BROWSER_IGNORE_BENIGN_ASSET_ERRORS",
    "CODING_AGENT_BROWSER_REQUIRE_ASSET_EVIDENCE",
    "AGENT_STALE_READ_STREAK",
    "AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES",
    "AGENT_RUN_JOURNAL_ENABLED",
    "AGENT_PROTOCOL_ERROR_RECOVERY",
  ];

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.settings.set(key, value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.refetchQueries({ queryKey: ["settings"] });
      // A manual field edit may mean the active preset is now "custom".
      void qc.invalidateQueries({ queryKey: ["agent-model-profiles"] });
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
      CODING_AGENT_TIMEOUT_MS: "1800000",
      CODING_AGENT_EXPLORE_TIMEOUT_MS: "600000",
      CODING_AGENT_ENABLE_VERIFY: "true",
      AGENT_CODING_ALLOW_GIT_COMMIT: "false",
      CODING_AGENT_PREPLAN_RESEARCH: "false",
      CODING_AGENT_PREPLAN_MAX_TOOL_CALLS: "12",
      CODING_AGENT_STALE_READ_RECOVERY: "true",
      CODING_AGENT_STALE_READ_REQUIRE_SAME_CONTENT: "true",
      CODING_AGENT_STALE_READ_MAX_RECOVERIES: "1",
      CODING_AGENT_ENFORCE_TOOL_ALLOWLIST: "true",
      CODING_AGENT_BROWSER_VERIFY_REPAIR_ATTEMPTS: "1",
      CODING_AGENT_BROWSER_RUNTIME_REPAIR_PROTOCOL: "true",
      CODING_AGENT_BROWSER_PREFLIGHT: "true",
      CODING_AGENT_BROWSER_IGNORE_BENIGN_ASSET_ERRORS: "true",
      CODING_AGENT_BROWSER_REQUIRE_ASSET_EVIDENCE: "true",
      AGENT_STALE_READ_STREAK: "4",
      AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES: "3",
      AGENT_RUN_JOURNAL_ENABLED: "true",
      AGENT_PROTOCOL_ERROR_RECOVERY: "true",
    };
    return defaults[key] ?? "";
  };

  const getDescription = (key: string): string => {
    const descriptions: Record<string, string> = {
      CODING_AGENT_MAX_ITERATIONS:
        "Maximale Iterationen für den Chat Coding Agent (Standard für alle Plan-Umsetzungen). Bestimmt, wie viele Gedankenschritte der Agent pro Versuch durchlaufen kann. Vorrang: Diese Einstellungen (einfach/mittel/komplex nach Schrittzahl) gelten für die Chat-Plan-Umsetzung ('Umsetzen') und überstimmen dort AGENT_MAX_ITERATIONS und AGENT_CODING_MAX_ITERATIONS. Coding-Area-Chat und CodingWorkspace-Plan nutzen weiterhin AGENT_CODING_MAX_ITERATIONS.",
      CODING_AGENT_MAX_ITERATIONS_SIMPLE:
        "Maximale Iterationen für einfache Pläne (1-3 Schritte) im Coding-Bereich. Höhere Werte ermöglichen mehr Fehlerbehandlung.",
      CODING_AGENT_MAX_ITERATIONS_MEDIUM:
        "Maximale Iterationen für mittlere Pläne (4-7 Schritte) im Coding-Bereich. Balanciert zwischen Durchsatz und Qualität.",
      CODING_AGENT_MAX_ITERATIONS_COMPLEX:
        "Maximale Iterationen für komplexe Pläne (8+ Schritte) im Coding-Bereich. Ermöglicht umfangreiche Implementierungen.",
      CODING_AGENT_MAX_ATTEMPTS:
        "Anzahl der Retry-Versuche wenn die Verifizierung fehlschlägt. 1-5 wird empfohlen.",
      CODING_AGENT_TIMEOUT_MS:
        "Timeout in Millisekunden für den gesamten Coding Agent Run. Standard: 30 Minuten (1800000ms). Grosszügig gewählt: die eigentliche Begrenzung sind Max Iterationen x Max Retry-Versuche - dies ist nur ein äusseres Sicherheitsnetz gegen einen wirklich hängenden Lauf.",
      CODING_AGENT_EXPLORE_TIMEOUT_MS:
        "Timeout in Millisekunden für EINEN Aufruf des Explore-Subagenten (das read-only 'schau dir den Code an, bevor du änderst'-Tool). Standard: 10 Minuten (600000ms). Bei langsamen/lokalen Modellen erhöhen, wenn 'Exploration timed out' Fehler auftreten.",
      CODING_AGENT_ENABLE_VERIFY:
        "Automatische Shell- und Browser-Verifikation am Ende eines Coding-Agent-Versuchs. Wenn deaktiviert, wird der Lauf schneller beendet, aber das Ergebnis als ungeprüft markiert.",
      AGENT_CODING_ALLOW_GIT_COMMIT:
        "Standard aus: der Coding Agent darf git nur zum Ansehen (status/diff/log) nutzen, niemals selbst 'add' oder 'commit' ausführen - Checkpoints werden ohnehin automatisch nach jeder Änderung mitgeschnitten (Tab 'Änderungen'), ein eigenes Commit wäre nur eine zweite, redundante Historie. Aktivieren, wenn der Agent eigenständig in einem im Sandbox-Projekt selbst angelegten git-Repo committen soll.",
      CODING_AGENT_PREPLAN_RESEARCH:
        "Startet vor einer neuen Planerstellung einen zusätzlichen, nur lesenden Modell-Research-Lauf. Aus nutzt ausschließlich den schnellen deterministischen Projekt-Snapshot; aktivieren bei großen oder ungewöhnlich strukturierten Projekten.",
      CODING_AGENT_PREPLAN_MAX_TOOL_CALLS:
        "Maximale Tool-Aufrufe für die optionale Vorab-Recherche. Begrenzt Kosten und Wartezeit, ohne den späteren normalen Explore-Schritt einzuschränken.",
      CODING_AGENT_STALE_READ_RECOVERY:
        "Bei mehrfach identischen Lesevorgängen wird zuerst eine gezielte Recovery-Anweisung gegeben statt sofort abzubrechen. Der Agent soll dann Status, neue Suche, andere Range, Diagnose oder einen blockierten Schritt wählen.",
      CODING_AGENT_STALE_READ_REQUIRE_SAME_CONTENT:
        "Die Recovery greift nur, wenn die zurückgelieferten Datei-Inhalte identisch sind. Verhindert Fehlabbrüche, falls eine Datei extern geändert wurde.",
      CODING_AGENT_STALE_READ_MAX_RECOVERIES:
        "Wie viele Recovery-Runden vor einem echten Read-Loop-Abbruch erlaubt sind. 0 deaktiviert die Recovery; 1 ist meist ausreichend.",
      CODING_AGENT_ENFORCE_TOOL_ALLOWLIST:
        "Entfernt aus Plan-Schritten Toolnamen, die im aktuellen Executor nicht registriert sind. So kann ein Begriff wie 'clock' bei einer Zeit-/Uhr-Funktion keinen Lauf abbrechen.",
      CODING_AGENT_BROWSER_VERIFY_REPAIR_ATTEMPTS:
        "Zusätzliche gezielte Reparaturversuche nur nach einem Browser-Laufzeitfehler. Der Agent muss die betroffene JavaScript-Stelle lesen und reparieren, bevor erneut geprüft wird.",
      CODING_AGENT_BROWSER_RUNTIME_REPAIR_PROTOCOL:
        "Übergibt Browser-Fehler mit Datei und Zeile als verbindliche Code-Debug-Aufgabe. Der Agent repariert den erzeugten JavaScript-Code statt den Browser-Check erneut auszuführen.",
      CODING_AGENT_BROWSER_PREFLIGHT:
        "Prüft eine statische Webseite automatisch, bevor der Agent alle Plan-Schritte als fertig markiert. Ein JavaScript-Laufzeitfehler wird noch im selben Versuch an den Agenten zur Reparatur zurückgegeben.",
      CODING_AGENT_BROWSER_IGNORE_BENIGN_ASSET_ERRORS:
        "Behandelt die implizite Browser-Anfrage nach favicon.ico bei 404 als Warnung statt als Verifikationsfehler. Explizit referenzierte oder andere fehlende Ressourcen bleiben prüfpflichtig.",
      CODING_AGENT_BROWSER_REQUIRE_ASSET_EVIDENCE:
        "Vor einer Änderung wegen eines fehlenden Assets muss der Agent dessen konkrete Referenz im Projekt nachweisen. Das verhindert Hinzufügen-und-Entfernen-Schleifen bei Browser-Standardanfragen.",
      AGENT_STALE_READ_STREAK:
        "Anzahl identischer reiner Lese-Iterationen, nach der die Read-Loop-Regel greift. Die Recovery oben wird vorher angewendet, sofern sie aktiv ist.",
      AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES:
        "Wie oft derselbe Verifikationsfehler aufeinanderfolgen darf, bevor der Coding-Lauf als nicht konvergent endet. Danach wird keine identische Reparatur weiter wiederholt.",
      AGENT_RUN_JOURNAL_ENABLED:
        "Speichert die letzten Tool-Aktionen im Laufzeitkontext, damit der Agent keine bereits erfolgreichen Aktionen wiederholt. Für mehrschrittige Coding-Läufe empfohlen.",
      AGENT_PROTOCOL_ERROR_RECOVERY:
        "Erkennt fehlerhaft vermischte native Tool-Aufrufe wie filesystem(action:'todo'), meldet die richtige Aufrufform zurück und zählt sie nicht als Arbeitsfehler für den Abbruchschutz.",
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
      CODING_AGENT_EXPLORE_TIMEOUT_MS: "Explore-Timeout (ms)",
      CODING_AGENT_ENABLE_VERIFY: "Automatische Verifikation",
      AGENT_CODING_ALLOW_GIT_COMMIT: "Git commit erlauben",
      CODING_AGENT_PREPLAN_RESEARCH: "LLM-Vorrecherche vor dem Plan",
      CODING_AGENT_PREPLAN_MAX_TOOL_CALLS: "Vorrecherche: max. Tool-Aufrufe",
      CODING_AGENT_STALE_READ_RECOVERY: "Read-Loop-Recovery",
      CODING_AGENT_STALE_READ_REQUIRE_SAME_CONTENT: "Nur bei identischem Dateiinhalt",
      CODING_AGENT_STALE_READ_MAX_RECOVERIES: "Read-Loop: max. Recoveries",
      CODING_AGENT_ENFORCE_TOOL_ALLOWLIST: "Nur verfügbare Plan-Tools zulassen",
      CODING_AGENT_BROWSER_VERIFY_REPAIR_ATTEMPTS: "Browserfehler: Reparaturversuche",
      CODING_AGENT_BROWSER_RUNTIME_REPAIR_PROTOCOL: "Browserfehler als Code-Debugging behandeln",
      CODING_AGENT_BROWSER_PREFLIGHT: "Browser-Preflight vor Abschluss",
      CODING_AGENT_BROWSER_IGNORE_BENIGN_ASSET_ERRORS: "Favicon-404 als Warnung behandeln",
      CODING_AGENT_BROWSER_REQUIRE_ASSET_EVIDENCE: "Asset-Änderungen nur mit Quellnachweis",
      AGENT_STALE_READ_STREAK: "Read-Loop-Schwelle",
      AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES: "Gleiche Verify-Fehler erlauben",
      AGENT_RUN_JOURNAL_ENABLED: "Run-Journal aktivieren",
      AGENT_PROTOCOL_ERROR_RECOVERY: "Tool-Protokollfehler abfangen",
    };
    return labels[key] ?? key;
  };

  /** A value counts as configured when the user typed it (unsaved) or it was saved in the DB. */
  const configuredValue = (key: string): string | undefined => {
    const v = edits[key] ?? settingsMap.get(key);
    return v !== undefined && v !== null && String(v).trim() !== "" ? String(v) : undefined;
  };

  const parsePositiveInt = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  /**
   * Mirrors the server's resolveCodingIterations(): the tier's own setting wins, then the flat
   * "Max Iterationen (Chat)" (CODING_AGENT_MAX_ITERATIONS), then the tier default (20/50/100).
   */
  const effectiveIterationsFor = (steps: number): number => {
    if (!Number.isFinite(steps) || steps < 1) return 0;
    const flat = configuredValue("CODING_AGENT_MAX_ITERATIONS");
    if (steps <= 3) {
      return parsePositiveInt(configuredValue("CODING_AGENT_MAX_ITERATIONS_SIMPLE"), parsePositiveInt(flat, 20));
    }
    if (steps <= 7) {
      return parsePositiveInt(configuredValue("CODING_AGENT_MAX_ITERATIONS_MEDIUM"), parsePositiveInt(flat, 50));
    }
    return parsePositiveInt(configuredValue("CODING_AGENT_MAX_ITERATIONS_COMPLEX"), parsePositiveInt(flat, 100));
  };

  const tierLabelFor = (steps: number): string => {
    if (steps <= 3) return "Einfach (1–3 Schritte)";
    if (steps <= 7) return "Mittel (4–7 Schritte)";
    return "Komplex (8+ Schritte)";
  };

  const effectiveTimeoutMs = (): number =>
    parsePositiveInt(configuredValue("CODING_AGENT_TIMEOUT_MS"), 1_800_000);

  const effectiveAttempts = (): number =>
    parsePositiveInt(configuredValue("CODING_AGENT_MAX_ATTEMPTS"), 3);

  const formatMs = (ms: number): string => {
    if (ms < 60000) return `${Math.round(ms / 1000)} s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes} Min ${seconds} s` : `${minutes} Min`;
  };

  return (
    <div className="space-y-6">
      {/* One centrally-applied profile for main Agent + Coding runtime budgets. Capability switches
          (vision/plugins/skill discovery/bot permissions/handoffs) are intentionally excluded. */}
      <AgentModelProfileSettings />

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
              "CODING_AGENT_EXPLORE_TIMEOUT_MS",
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

        {/* Deterministic planning and read-loop recovery */}
        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-medium">Planung &amp; Lese-Recovery</h4>
          <div className="space-y-3 pl-4">
            {[
              "CODING_AGENT_PREPLAN_RESEARCH",
              "CODING_AGENT_STALE_READ_RECOVERY",
              "CODING_AGENT_STALE_READ_REQUIRE_SAME_CONTENT",
              "CODING_AGENT_ENFORCE_TOOL_ALLOWLIST",
              "CODING_AGENT_BROWSER_RUNTIME_REPAIR_PROTOCOL",
              "CODING_AGENT_BROWSER_PREFLIGHT",
              "CODING_AGENT_BROWSER_IGNORE_BENIGN_ASSET_ERRORS",
              "CODING_AGENT_BROWSER_REQUIRE_ASSET_EVIDENCE",
              "AGENT_RUN_JOURNAL_ENABLED",
              "AGENT_PROTOCOL_ERROR_RECOVERY",
            ].map((key) => (
              <div key={key} className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-b-0 last:pb-0">
                <div>
                  <label className="block text-sm font-medium text-foreground">{getLabel(key)}</label>
                  <p className="mt-1 max-w-xl text-xs text-muted-foreground">{getDescription(key)}</p>
                </div>
                <input
                  type="checkbox"
                  checked={getDisplayValue(key) === "true"}
                  onChange={(e) => {
                    const value = e.target.checked ? "true" : "false";
                    setEdits((prev) => ({ ...prev, [key]: value }));
                    save.mutate({ key, value });
                  }}
                  className="h-4 w-4 shrink-0 rounded accent-primary"
                />
              </div>
            ))}
            {[
              "CODING_AGENT_PREPLAN_MAX_TOOL_CALLS",
              "CODING_AGENT_STALE_READ_MAX_RECOVERIES",
              "AGENT_STALE_READ_STREAK",
              "AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES",
              "CODING_AGENT_BROWSER_VERIFY_REPAIR_ATTEMPTS",
            ].map((key) => (
              <div key={key} className="space-y-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
                <label className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{getLabel(key)}</span>
                  <span className="text-xs text-muted-foreground">Standard: {getDefaultValue(key)}</span>
                </label>
                <p className="text-xs text-muted-foreground">{getDescription(key)}</p>
                <div className="flex items-start gap-2">
                  <input type="number" min={key === "AGENT_STALE_READ_STREAK" ? 2 : 0} max={key === "CODING_AGENT_PREPLAN_MAX_TOOL_CALLS" ? 100 : 20} step="1"
                    value={getDisplayValue(key)} onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="input flex-1" />
                  <button onClick={() => handleSaveField(key)} className="btn-primary flex items-center gap-1" disabled={save.isPending}>
                    <Save className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Verification */}
        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-medium">Verifikation</h4>
          <div className="pl-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground">
                  {getLabel("CODING_AGENT_ENABLE_VERIFY")}
                </label>
                <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                  {getDescription("CODING_AGENT_ENABLE_VERIFY")}
                </p>
              </div>
              <input
                type="checkbox"
                checked={getDisplayValue("CODING_AGENT_ENABLE_VERIFY") === "true"}
                onChange={(e) => {
                  const value = e.target.checked ? "true" : "false";
                  setEdits((prev) => ({ ...prev, CODING_AGENT_ENABLE_VERIFY: value }));
                  save.mutate({ key: "CODING_AGENT_ENABLE_VERIFY", value });
                }}
                className="w-4 h-4 accent-primary rounded shrink-0"
              />
            </div>
          </div>
        </div>

        {/* Git Behavior */}
        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-medium">Git-Verhalten</h4>
          <div className="pl-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground">
                  {getLabel("AGENT_CODING_ALLOW_GIT_COMMIT")}
                </label>
                <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                  {getDescription("AGENT_CODING_ALLOW_GIT_COMMIT")}
                </p>
              </div>
              <input
                type="checkbox"
                checked={getDisplayValue("AGENT_CODING_ALLOW_GIT_COMMIT") === "true"}
                onChange={(e) => {
                  const value = e.target.checked ? "true" : "false";
                  setEdits((prev) => ({ ...prev, AGENT_CODING_ALLOW_GIT_COMMIT: value }));
                  save.mutate({ key: "AGENT_CODING_ALLOW_GIT_COMMIT", value });
                }}
                className="w-4 h-4 accent-primary rounded shrink-0"
              />
            </div>
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
                <li>Timeout in Millisekunden: 300000 = 5 Min, 1800000 = 30 Min, 3600000 = 60 Min</li>
                <li>Änderungen gelten nur für neue Plan-Ausführungen</li>
                <li>
                  Vorrangregel Iterationsbudget: Chat-Plan „Umsetzen" = diese Tiers
                  (einfach/mittel/komplex); Coding-Area-Chat &amp; CodingWorkspace-Plan =
                  „Coding: Max Iterations" (AGENT_CODING_MAX_ITERATIONS); normaler Chat =
                  „Max Iterations (Full Mode)" (AGENT_MAX_ITERATIONS). Spezifischeres gewinnt.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Live Preview */}
      <div className="rounded-lg border border-border bg-card/50 p-4">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">Live-Vorschau: Budget eines Laufs</h4>
          <div className="group relative cursor-help">
            <HelpCircle className="h-4 w-4 text-muted-foreground" />
            <div className="absolute bottom-full right-0 hidden group-hover:block rounded bg-black/80 text-white text-xs p-2 mb-2 whitespace-nowrap z-10">
              Simuliert die Schrittzahl eines Plans und zeigt, welches Iterationsbudget und
              Zeitlimit ein Lauf über die Chat-Plan-Umsetzung („Umsetzen") bekommen würde.
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="1"
              max="20"
              value={previewSteps}
              onChange={(e) => setPreviewSteps(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-16 text-right text-sm font-medium tabular-nums">
              {previewSteps} Schritt{previewSteps === 1 ? "" : "e"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded bg-blue-500/10 p-2">
              <p className="text-xs text-muted-foreground">Tier (Schrittzahl)</p>
              <p className="font-medium">{tierLabelFor(previewSteps)}</p>
            </div>
            <div className="rounded bg-blue-500/10 p-2">
              <p className="text-xs text-muted-foreground">Iterationsbudget</p>
              <p className="font-medium">{effectiveIterationsFor(previewSteps)} Iterationen</p>
            </div>
            <div className="rounded bg-blue-500/10 p-2">
              <p className="text-xs text-muted-foreground">Zeitlimit (Timeout)</p>
              <p className="font-medium">{formatMs(effectiveTimeoutMs())}</p>
            </div>
            <div className="rounded bg-blue-500/10 p-2">
              <p className="text-xs text-muted-foreground">Max Versuche</p>
              <p className="font-medium">{effectiveAttempts()}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Die Vorschau aktualisiert sich live mit Ihren Eingaben — auch bevor Sie sie speichern.
          </p>
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
