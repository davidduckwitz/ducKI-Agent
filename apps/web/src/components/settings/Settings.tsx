import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Settings as SettingsIcon, Save, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";

interface Setting {
  key: string;
  value: string;
}

type SettingFieldType = "text" | "password" | "number" | "textarea" | "select";

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: SettingFieldType;
  section: "Provider" | "API" | "Speech" | "Agent" | "Memory";
  defaultValue: string;
  options?: { label: string; value: string }[];
}

const SYSTEM_PROMPT_FALLBACK =
  "You are DucKI, an intelligent AI coding agent. You are helpful, accurate, and professional.";

const PREDEFINED_FIELDS: SettingField[] = [
  {
    key: "DEFAULT_PROVIDER",
    label: "Model Provider",
    description: "Aktiver LLM-Provider",
    type: "select",
    section: "Provider",
    defaultValue: "lmstudio",
    options: [
      { label: "LM Studio", value: "lmstudio" },
      { label: "OpenAI", value: "openai" },
      { label: "OpenRouter", value: "openrouter" },
      { label: "Ollama", value: "ollama" },
    ],
  },
  {
    key: "OPENAI_MODEL",
    label: "OpenAI Model",
    description: "Modelname fuer OpenAI",
    type: "text",
    section: "Provider",
    defaultValue: "gpt-4o",
  },
  {
    key: "OPENROUTER_MODEL",
    label: "OpenRouter Model",
    description: "Modelname fuer OpenRouter",
    type: "text",
    section: "Provider",
    defaultValue: "anthropic/claude-3-5-sonnet",
  },
  {
    key: "LM_STUDIO_BASE_URL",
    label: "LM Studio Base URL",
    description: "HTTP Endpoint fuer LM Studio",
    type: "text",
    section: "Provider",
    defaultValue: "http://localhost:1234/v1",
  },
  {
    key: "LM_STUDIO_MODEL",
    label: "LM Studio Model",
    description: "Modelname fuer LM Studio",
    type: "text",
    section: "Provider",
    defaultValue: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
  },
  {
    key: "OLLAMA_BASE_URL",
    label: "Ollama Base URL",
    description: "HTTP Endpoint fuer Ollama",
    type: "text",
    section: "Provider",
    defaultValue: "http://localhost:11434",
  },
  {
    key: "OLLAMA_MODEL",
    label: "Ollama Model",
    description: "Modelname fuer Ollama",
    type: "text",
    section: "Provider",
    defaultValue: "llama3",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API Key",
    description: "Schluessel fuer OpenAI API",
    type: "password",
    section: "API",
    defaultValue: "",
  },
  {
    key: "OPENROUTER_API_KEY",
    label: "OpenRouter API Key",
    description: "Schluessel fuer OpenRouter API",
    type: "password",
    section: "API",
    defaultValue: "",
  },
  {
    key: "LM_STUDIO_API_KEY",
    label: "LM Studio API Key",
    description: "Optionaler Schluessel fuer LM Studio Proxy/API",
    type: "password",
    section: "API",
    defaultValue: "lm-studio",
  },
  {
    key: "AUTO_UPDATE_ENABLED",
    label: "Auto Update Check",
    description: "Prueft regelmaessig auf neue Commits im Git-Repo (kein automatisches Pull).",
    type: "select",
    section: "API",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AUTO_UPDATE_REPO_URL",
    label: "Update Repo URL",
    description: "Remote-Repository fuer Update-Pruefung.",
    type: "text",
    section: "API",
    defaultValue: "https://github.com/davidduckwitz/ducKI-Agent",
  },
  {
    key: "AUTO_UPDATE_BRANCH",
    label: "Update Branch",
    description: "Branch fuer Update-Pruefung und manuelles Pull.",
    type: "text",
    section: "API",
    defaultValue: "main",
  },
  {
    key: "AUTO_UPDATE_INTERVAL_MIN",
    label: "Update Check Interval (min)",
    description: "Intervall fuer automatische Update-Checks.",
    type: "number",
    section: "API",
    defaultValue: "5",
  },
  {
    key: "AUTO_UPDATE_REQUIRE_CLEAN_WORKTREE",
    label: "Require Clean Worktree",
    description: "Erlaubt Update nur bei sauberem Git-Worktree.",
    type: "select",
    section: "API",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AUTO_UPDATE_WORKDIR",
    label: "Update Working Directory",
    description: "Optionaler Pfad zum Git-Root fuer Update-Befehle.",
    type: "text",
    section: "API",
    defaultValue: "../..",
  },
  {
    key: "DEFAULT_SPEECH_TO_TEXT_PROVIDER",
    label: "Default STT Provider",
    description: "Standard Speech-to-Text Provider fuer lokale Audio-Transkription",
    type: "select",
    section: "Speech",
    defaultValue: "nodejs-whisper",
    options: [
      { label: "Local Command", value: "local" },
      { label: "nodejs-whisper", value: "nodejs-whisper" },
      { label: "OpenAI", value: "openai" },
      { label: "Ollama", value: "ollama" },
      { label: "Silero", value: "silero" },
    ],
  },
  {
    key: "DISCORD_VOICE_STT_PROVIDER",
    label: "Discord Voice STT Provider",
    description: "Provider fuer eingehende Discord-Sprachnachrichten",
    type: "select",
    section: "Speech",
    defaultValue: "nodejs-whisper",
    options: [
      { label: "Local Command", value: "local" },
      { label: "nodejs-whisper", value: "nodejs-whisper" },
      { label: "OpenAI", value: "openai" },
      { label: "Ollama", value: "ollama" },
      { label: "Silero", value: "silero" },
    ],
  },
  {
    key: "DISCORD_VOICE_STT_MODEL",
    label: "Discord STT Model",
    description: "Optionales Modell fuer den gewaehlten Discord-STT-Provider",
    type: "text",
    section: "Speech",
    defaultValue: "base",
  },
  {
    key: "LOCAL_STT_COMMAND",
    label: "Local STT Command",
    description: "Ausfuehrbares Kommando fuer lokalen STT-Aufruf (z. B. whisper-cli.exe)",
    type: "text",
    section: "Speech",
    defaultValue: "C:/tools/whispercpp/whisper-cli.exe",
  },
  {
    key: "LOCAL_STT_ARGS",
    label: "Local STT Arguments",
    description: "Argumente mit Platzhaltern wie {input}, {output}, {outputBase}, {language}",
    type: "textarea",
    section: "Speech",
    defaultValue: "-m C:/tools/whispercpp/models/ggml-base.bin -f {input} -otxt -of {outputBase} -l de",
  },
  {
    key: "LOCAL_STT_WORKDIR",
    label: "Local STT Working Directory",
    description: "Optionales Arbeitsverzeichnis fuer das lokale STT-Kommando",
    type: "text",
    section: "Speech",
    defaultValue: "",
  },
  {
    key: "LOCAL_STT_TIMEOUT_MS",
    label: "Local STT Timeout (ms)",
    description: "Timeout fuer lokale STT-Kommandos",
    type: "number",
    section: "Speech",
    defaultValue: "180000",
  },
  {
    key: "LOCAL_STT_INPUT_EXT",
    label: "Local STT Input Extension",
    description: "Dateiendung fuer temporaere Eingabedatei (z. B. ogg, wav)",
    type: "text",
    section: "Speech",
    defaultValue: "ogg",
  },
  {
    key: "DISCORD_VOICE_STT_COMMAND",
    label: "Discord STT Command Override",
    description: "Optionales Command-Override nur fuer Discord Voice",
    type: "text",
    section: "Speech",
    defaultValue: "C:/tools/whispercpp/whisper-cli.exe",
  },
  {
    key: "DISCORD_VOICE_STT_ARGS",
    label: "Discord STT Arguments Override",
    description: "Optionales Args-Override nur fuer Discord Voice",
    type: "textarea",
    section: "Speech",
    defaultValue: "-m C:/tools/whispercpp/models/ggml-base.bin -f {input} -otxt -of {outputBase} -l de",
  },
  {
    key: "DISCORD_VOICE_STT_TIMEOUT_MS",
    label: "Discord STT Timeout (ms)",
    description: "Optionales Timeout-Override fuer Discord Voice",
    type: "number",
    section: "Speech",
    defaultValue: "180000",
  },
  {
    key: "NODEJS_WHISPER_MODEL_NAME",
    label: "nodejs-whisper Model",
    description: "Whisper-Modellname (tiny, base, small, medium, large, ...)",
    type: "text",
    section: "Speech",
    defaultValue: "base",
  },
  {
    key: "NODEJS_WHISPER_MODEL_ROOT_PATH",
    label: "nodejs-whisper Model Root Path",
    description: "Optionales Verzeichnis der ggml-Modelle",
    type: "text",
    section: "Speech",
    defaultValue: "",
  },
  {
    key: "NODEJS_WHISPER_AUTO_DOWNLOAD",
    label: "nodejs-whisper Auto Download",
    description: "Lade fehlende Modelle automatisch herunter",
    type: "select",
    section: "Speech",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "NODEJS_WHISPER_USE_CUDA",
    label: "nodejs-whisper CUDA",
    description: "Aktiviert CUDA-Build fuer whisper.cpp (falls verfuegbar)",
    type: "select",
    section: "Speech",
    defaultValue: "false",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "NODEJS_WHISPER_LANGUAGE",
    label: "nodejs-whisper Language",
    description: "Sprache fuer Erkennung (de, en, auto)",
    type: "text",
    section: "Speech",
    defaultValue: "auto",
  },
  {
    key: "NODEJS_WHISPER_TIMEOUT_MS",
    label: "nodejs-whisper Timeout (ms)",
    description: "Maximale Laufzeit fuer nodejs-whisper",
    type: "number",
    section: "Speech",
    defaultValue: "180000",
  },
  {
    key: "NODEJS_WHISPER_INPUT_EXT",
    label: "nodejs-whisper Input Extension",
    description: "Dateiendung fuer temporaere Audiodatei",
    type: "text",
    section: "Speech",
    defaultValue: "ogg",
  },
  {
    key: "AGENT_MAX_ITERATIONS",
    label: "Max Iterations",
    description: "Maximale Agent-Schleifen pro Anfrage",
    type: "number",
    section: "Agent",
    defaultValue: "50",
  },
  {
    key: "AGENT_TIMEOUT_MS",
    label: "Timeout (ms)",
    description: "Inaktivitaets-Timeout fuer einen Agent-Run; wird bei Fortschritt zurueckgesetzt.",
    type: "number",
    section: "Agent",
    defaultValue: "600000",
  },
  {
    key: "AGENT_TOOL_TIMEOUT_SHELL_MS",
    label: "Shell Tool Timeout (ms)",
    description: "Maximale Laufzeit fuer Shell-Tool-Aufrufe.",
    type: "number",
    section: "Agent",
    defaultValue: "120000",
  },
  {
    key: "AGENT_TOOL_TIMEOUT_HTTP_MS",
    label: "HTTP Tool Timeout (ms)",
    description: "Maximale Laufzeit fuer HTTP-Tool-Aufrufe.",
    type: "number",
    section: "Agent",
    defaultValue: "60000",
  },
  {
    key: "AGENT_TOOL_TIMEOUT_BROWSER_MS",
    label: "Browser Tool Timeout (ms)",
    description: "Maximale Laufzeit fuer Browser-Automation und Waits.",
    type: "number",
    section: "Agent",
    defaultValue: "120000",
  },
  {
    key: "AGENT_TOOL_TIMEOUT_GIT_MS",
    label: "Git Tool Timeout (ms)",
    description: "Maximale Laufzeit fuer Git-Operationen.",
    type: "number",
    section: "Agent",
    defaultValue: "120000",
  },
  {
    key: "AGENT_MAX_TOOL_FAILURES",
    label: "Max Tool Failures",
    description: "Nach dieser Anzahl aufeinanderfolgender Tool-Fehler stoppt der Agent.",
    type: "number",
    section: "Agent",
    defaultValue: "3",
  },
  {
    key: "AGENT_MAX_REPEATED_TOOL_CALL",
    label: "Max Repeated Tool Calls",
    description: "Grenze fuer identische Tool-Aufrufe, bevor Guardrail stoppt.",
    type: "number",
    section: "Agent",
    defaultValue: "3",
  },
  {
    key: "AGENT_AUTO_MEMORY",
    label: "Auto Memory",
    description: "Speichert Erkenntnisse aus erfolgreichen Tool-Operationen automatisch.",
    type: "select",
    section: "Agent",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AGENT_ENABLE_REFLECTION",
    label: "Enable Reflection",
    description: "Aktiviert Qualitaetspruefung der finalen Antwort mit optionaler Verbesserung.",
    type: "select",
    section: "Agent",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AGENT_REFLECTION_MAX_RETRIES",
    label: "Reflection Max Retries",
    description: "Maximale Anzahl Reflection-Verbesserungsdurchlaeufe pro Run.",
    type: "number",
    section: "Agent",
    defaultValue: "1",
  },
  {
    key: "AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE",
    label: "Reasoner Min Confidence",
    description: "Mindest-Confidence, bevor Reasoner eine Antwort oder Tool-Ausfuehrung uebersteuern darf.",
    type: "number",
    section: "Agent",
    defaultValue: "0.65",
  },
  {
    key: "AGENT_AUTO_SKILL_SELECTION",
    label: "Auto Skill Selection",
    description: "Automatische Skill-Auswahl anhand Anfrage-Relevanz.",
    type: "select",
    section: "Agent",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AGENT_SKILL_BEHAVIOR",
    label: "Skill Behavior",
    description: "Automatic: Agent waehlt relevante Skills aus aktivierten Skills. Active Skills: Alle aktivierten Skills werden voll geladen.",
    type: "select",
    section: "Agent",
    defaultValue: "automatic",
    options: [
      { label: "Auto Skills = Automatic", value: "automatic" },
      { label: "Active Skills = All Activated full loaded", value: "active" },
    ],
  },
  {
    key: "AGENT_AUTO_SKILL_FALLBACK_NONE",
    label: "Auto Skill Fallback",
    description: "Wenn im Automatic-Mode kein passender Skill gefunden wird: Keine Skills laden (Aktiv) oder alle aktivierten Skills laden (Aus).",
    type: "select",
    section: "Agent",
    defaultValue: "true",
    options: [
      { label: "No auto-selection => no skill loaded", value: "true" },
      { label: "No auto-selection => load all activated skills", value: "false" },
    ],
  },
  {
    key: "AGENT_AUTO_SKILL_THRESHOLD",
    label: "Auto Skill Threshold",
    description: "Mindest-Score (0.0-1.0), damit ein Skill automatisch geladen wird.",
    type: "number",
    section: "Agent",
    defaultValue: "0.78",
  },
  {
    key: "AGENT_AUTO_SKILL_MARGIN",
    label: "Auto Skill Margin",
    description: "Mindestabstand zum zweitbesten Skill, um Ambiguitaet zu vermeiden.",
    type: "number",
    section: "Agent",
    defaultValue: "0.2",
  },
  {
    key: "AGENT_AUTO_SKILL_MIN_INPUT_LEN",
    label: "Auto Skill Min Input Length",
    description: "Mindest-Laenge der Anfrage fuer Auto-Skill-Auswahl.",
    type: "number",
    section: "Agent",
    defaultValue: "20",
  },
  {
    key: "AGENT_AUTO_SKILL_MIN_OVERLAP",
    label: "Auto Skill Min Overlap",
    description: "Mindestens benoetigte Token-Ueberschneidung zwischen Anfrage und Skill.",
    type: "number",
    section: "Agent",
    defaultValue: "2",
  },
  {
    key: "CODING_ENABLED",
    label: "Coding Area Enabled",
    description: "Aktiviert den Coding-Bereich (Menuepunkt + Coding-Workspace mit Chat und Editor).",
    type: "select",
    section: "Agent",
    defaultValue: "false",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "AGENT_SYSTEM_PROMPT",
    label: "System Prompt",
    description: "Globaler Prompt fuer das Agent-Verhalten",
    type: "textarea",
    section: "Agent",
    defaultValue: SYSTEM_PROMPT_FALLBACK,
  },
  {
    key: "MEMORY_SHORT_TERM_LIMIT",
    label: "Short-Term Memory Limit",
    description: "Maximale Anzahl kurzzeitiger Memory-Eintraege",
    type: "number",
    section: "Memory",
    defaultValue: "50",
  },
  {
    key: "MEMORY_IMPORTANCE_THRESHOLD",
    label: "Memory Importance Threshold",
    description: "Mindest-Relevanz zum Speichern in Memory",
    type: "number",
    section: "Memory",
    defaultValue: "2",
  },
  {
    key: "WIKI_ENABLED",
    label: "LLM Wiki Enabled",
    description: "Aktiviert/deaktiviert LLM-Wiki komplett. Bei Aus keine Ingestion, kein Auto-Lernen.",
    type: "select",
    section: "Memory",
    defaultValue: "false",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "WIKI_SHARED_SOURCE_PATH",
    label: "Wiki Source Path",
    description: "Relativer Pfad unter shared-workspace, Standard: llm-wiki",
    type: "text",
    section: "Memory",
    defaultValue: "llm-wiki",
  },
  {
    key: "WIKI_SHARED_SOURCE_AUTO_MEMORY",
    label: "Wiki Auto Memory",
    description: "Erzeugt aus ingestierten Wiki-Dateien automatisch semantic Memory-Eintraege.",
    type: "select",
    section: "Memory",
    defaultValue: "true",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "WIKI_AUTO_APPROVE",
    label: "Wiki Auto Approve",
    description: "Neue Wiki-Chunks direkt als approved markieren (sonst candidate).",
    type: "select",
    section: "Memory",
    defaultValue: "false",
    options: [
      { label: "Aktiv", value: "true" },
      { label: "Aus", value: "false" },
    ],
  },
  {
    key: "WIKI_SHARED_SOURCE_MAX_FILE_SIZE_KB",
    label: "Wiki Max File Size (KB)",
    description: "Dateien groesser als dieser Wert werden beim Ingest ignoriert.",
    type: "number",
    section: "Memory",
    defaultValue: "256",
  },
  {
    key: "WIKI_INGEST_INTERVAL_MS",
    label: "Wiki Ingest Interval (ms)",
    description: "Scan-Intervall fuer shared-workspace/llm-wiki.",
    type: "number",
    section: "Memory",
    defaultValue: "30000",
  },
  {
    key: "WIKI_CHUNK_SIZE_CHARS",
    label: "Wiki Chunk Size (chars)",
    description: "Maximale Groesse eines Wiki-Textchunks.",
    type: "number",
    section: "Memory",
    defaultValue: "1400",
  },
  {
    key: "WIKI_CHUNK_OVERLAP_CHARS",
    label: "Wiki Chunk Overlap (chars)",
    description: "Ueberlappung zwischen zwei Chunks fuer bessere Treffer.",
    type: "number",
    section: "Memory",
    defaultValue: "200",
  },
];

const SECTIONS: Array<SettingField["section"]> = ["Provider", "API", "Speech", "Agent", "Memory"];

export function Settings() {
  const { t } = useI18n();
  const { setSetupModalOpen } = useAppStore();
  const qc = useQueryClient();
  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.list() as Promise<Setting[]>,
  });

  const [edits, setEdits] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.settings.set(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const settingsMap = new Map((settings as Setting[]).map((entry) => [entry.key, entry.value]));
  const predefinedKeys = new Set(PREDEFINED_FIELDS.map((field) => field.key));
  const customSettings = (settings as Setting[]).filter((entry) => !predefinedKeys.has(entry.key));

  const getDisplayValue = (field: SettingField): string =>
    edits[field.key] ?? settingsMap.get(field.key) ?? field.defaultValue;

  const saveField = (key: string, value: string): void => {
    save.mutate({ key, value });
  };

  const saveAll = (): void => {
    for (const field of PREDEFINED_FIELDS) {
      save.mutate({ key: field.key, value: getDisplayValue(field) });
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("settingsPage.title")}</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setSetupModalOpen(true)} className="btn-secondary flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            {t("setupWizard.openButton")}
          </button>
          <button onClick={saveAll} className="btn-primary flex items-center gap-2" disabled={save.isPending}>
            <Save className="w-4 h-4" />
            {t("settingsPage.saveAll")}
          </button>
        </div>
      </div>

      {SECTIONS.map((section) => {
        const fields = PREDEFINED_FIELDS.filter((field) => field.section === section);
        return (
          <div key={section} className="card space-y-3">
            <h2 className="text-lg font-semibold">{section}</h2>

            {fields.map((field) => {
              const value = getDisplayValue(field);

              return (
                <div key={field.key} className="space-y-1 border-b border-gray-800 pb-3 last:border-b-0 last:pb-0">
                  <label className="text-sm text-gray-100 block">{field.label}</label>
                  <p className="text-xs text-gray-400">{field.description}</p>
                  <p className="text-xs text-gray-500 font-mono">{field.key}</p>

                  <div className="flex gap-2 items-start">
                    {field.type === "textarea" && (
                      <textarea
                        className="input flex-1 min-h-28"
                        value={value}
                        onChange={(e) =>
                          setEdits((ed) => ({ ...ed, [field.key]: e.target.value }))
                        }
                      />
                    )}

                    {field.type === "select" && (
                      <select
                        className="input flex-1"
                        value={value}
                        onChange={(e) =>
                          setEdits((ed) => ({ ...ed, [field.key]: e.target.value }))
                        }
                      >
                        {field.options?.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    )}

                    {(field.type === "text" || field.type === "password" || field.type === "number") && (
                      <input
                        className="input flex-1"
                        type={field.type}
                        value={value}
                        onChange={(e) =>
                          setEdits((ed) => ({ ...ed, [field.key]: e.target.value }))
                        }
                      />
                    )}

                    <button
                      onClick={() => saveField(field.key, value)}
                      className="btn-primary flex items-center gap-1"
                      disabled={save.isPending}
                    >
                      <Save className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {customSettings.length > 0 && (
        <div className="card space-y-3">
          <h2 className="text-lg font-semibold">{t("settingsPage.otherSettings")}</h2>
          {customSettings.map((setting) => (
            <div key={setting.key} className="space-y-1 border-b border-gray-800 pb-3 last:border-b-0 last:pb-0">
              <p className="text-xs text-gray-500 font-mono">{setting.key}</p>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={edits[setting.key] ?? setting.value}
                  onChange={(e) => setEdits((ed) => ({ ...ed, [setting.key]: e.target.value }))}
                />
                <button
                  onClick={() => saveField(setting.key, edits[setting.key] ?? setting.value)}
                  className="btn-primary flex items-center gap-1"
                  disabled={save.isPending}
                >
                  <Save className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(settings as Setting[]).length === 0 && (
        <div className="text-center text-gray-500 py-8">
          <SettingsIcon className="w-10 h-10 mx-auto mb-3 text-gray-700" />
          <p>{t("settingsPage.defaultsHint")}</p>
        </div>
      )}
    </div>
  );
}
