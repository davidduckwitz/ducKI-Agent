import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Plug,
  Sparkles,
  X,
  AlertTriangle,
  ExternalLink,
  Check,
  FolderOpen,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Puzzle,
  Sun,
  Wand2,
} from "lucide-react";
import { api, type PluginInfo } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useTheme } from "../theme/ThemeProvider";
import { ACCENT_COLORS, ACCENT_SWATCH_CLASS, THEME_MODES, type ThemeMode } from "../../lib/theme";
import { getDesktopInfo, isTauriDesktop, openDesktopFolder, setDesktopPreferences, type DesktopFolder, type DesktopInfo } from "../../lib/desktop";
import { BackendSettings } from "../settings/BackendSettings";
import { PluginSettingsForm } from "../plugins/PluginSettingsForm";

interface SettingEntry {
  key: string;
  value: string;
}

interface SetupWizardModalProps {
  open: boolean;
  onClose: () => void;
  settings: SettingEntry[];
}

type ProviderName = "lmstudio" | "openrouter" | "openai" | "ollama" | "claude";
type SkillBehavior = "automatic" | "active";

function toBool(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

type StepKey = "appearance" | "llm" | "backend" | "connectors" | "plugins" | "features" | "agent" | "desktop" | "summary";

const THEME_MODE_ICONS: Record<ThemeMode, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };

interface DesktopPrefsState {
  autostart: boolean;
  closeToTray: boolean;
  showSplash: boolean;
}

interface ProviderTestState {
  status: "idle" | "testing" | "ok" | "error";
  models: Array<{ id: string; name: string }>;
  error?: string;
}

export function SetupWizardModal({ open, onClose, settings }: SetupWizardModalProps) {
  const { t, language, setLanguage, languages } = useI18n();
  const theme = useTheme();
  const desktopMode = isTauriDesktop();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settingsMap = useMemo(() => new Map(settings.map((entry) => [entry.key, entry.value])), [settings]);

  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<ProviderName>((settingsMap.get("DEFAULT_PROVIDER") as ProviderName | undefined) ?? "lmstudio");
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState(settingsMap.get("LM_STUDIO_BASE_URL") ?? "http://localhost:1234/v1");
  const [lmStudioModel, setLmStudioModel] = useState(settingsMap.get("LM_STUDIO_MODEL") ?? "local-model");
  const [openRouterApiKey, setOpenRouterApiKey] = useState(settingsMap.get("OPENROUTER_API_KEY") ?? "");
  const [openRouterModel, setOpenRouterModel] = useState(settingsMap.get("OPENROUTER_MODEL") ?? "openrouter/free");
  const [openAiApiKey, setOpenAiApiKey] = useState(settingsMap.get("OPENAI_API_KEY") ?? "");
  const [openAiModel, setOpenAiModel] = useState(settingsMap.get("OPENAI_MODEL") ?? "gpt-4o");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(settingsMap.get("OLLAMA_BASE_URL") ?? "http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState(settingsMap.get("OLLAMA_MODEL") ?? "llama3");
  const [claudeApiKey, setClaudeApiKey] = useState(settingsMap.get("CLAUDE_API_KEY") ?? "");
  const [claudeModel, setClaudeModel] = useState(settingsMap.get("CLAUDE_MODEL") ?? "claude-3-5-sonnet-20241022");

  // Generic connector-plugin state (plan section 8b) - replaces the old Discord-only fields.
  // Keyed by plugin name so an arbitrary number of connector plugins (Discord, future Telegram,
  // ...) can be configured and enabled in one wizard pass.
  const connectorPluginsQuery = useQuery({ queryKey: ["plugins"], queryFn: () => api.plugins.list(), enabled: open });
  const connectorPlugins = useMemo(
    () => (connectorPluginsQuery.data ?? []).filter((p): p is PluginInfo & { connector: NonNullable<PluginInfo["connector"]> } => Boolean(p.connector)),
    [connectorPluginsQuery.data]
  );
  const [connectorEnabled, setConnectorEnabled] = useState<Record<string, boolean>>({});
  const [connectorValues, setConnectorValues] = useState<Record<string, Record<string, string>>>({});
  const [connectorMasked, setConnectorMasked] = useState<Record<string, Set<string>>>({});
  const [connectorTestResult, setConnectorTestResult] = useState<Record<string, { ok: boolean; error?: string } | undefined>>({});
  const [connectorTesting, setConnectorTesting] = useState<Record<string, boolean>>({});
  const [connectorSeeded, setConnectorSeeded] = useState<Set<string>>(new Set());

  // Seed each connector plugin's enabled state + current (masked) settings exactly once, the
  // first time it's seen - never overwrites in-progress edits on later re-renders.
  useEffect(() => {
    if (!open) return;
    for (const plugin of connectorPlugins) {
      if (connectorSeeded.has(plugin.name)) continue;
      setConnectorSeeded((prev) => new Set(prev).add(plugin.name));
      setConnectorEnabled((prev) => (plugin.name in prev ? prev : { ...prev, [plugin.name]: plugin.enabled }));
      api.plugins
        .getSettings(plugin.name)
        .then((result) => {
          const initial: Record<string, string> = {};
          const masked = new Set<string>();
          for (const spec of result.specs) {
            const raw = result.values[spec.key];
            if (raw === "***") {
              masked.add(spec.key);
              initial[spec.key] = "";
            } else {
              initial[spec.key] = raw !== undefined && raw !== null ? String(raw) : "";
            }
          }
          setConnectorValues((prev) => (plugin.name in prev ? prev : { ...prev, [plugin.name]: initial }));
          setConnectorMasked((prev) => ({ ...prev, [plugin.name]: masked }));
        })
        .catch(() => {
          // Keep the wizard usable even if a plugin's settings can't be loaded - the form just
          // starts empty for that plugin.
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectorPlugins]);

  /**
   * Persists one connector plugin's settings + enable/disable state, then (only if it ends up
   * enabled) runs the connectivity test and stores the result inline. Never throws - failures
   * (including a failed connectivity test) are surfaced in connectorTestResult/console instead
   * of blocking the caller, per the plan's "soft connectivity check" intent.
   */
  async function saveAndTestConnector(pluginName: string): Promise<void> {
    const plugin = connectorPlugins.find((p) => p.name === pluginName);
    if (!plugin) return;
    const enabled = connectorEnabled[pluginName] ?? plugin.enabled;
    const values = connectorValues[pluginName] ?? {};
    try {
      const changedValues: Record<string, string> = {};
      for (const spec of plugin.settings) {
        const value = values[spec.key];
        if (value !== undefined && value !== "") changedValues[spec.key] = value;
      }
      if (Object.keys(changedValues).length > 0) {
        await api.plugins.saveSettings(pluginName, changedValues);
      }
      if (enabled) await api.plugins.enable(pluginName);
      else await api.plugins.disable(pluginName);
    } catch (error) {
      setConnectorTestResult((prev) => ({
        ...prev,
        [pluginName]: { ok: false, error: error instanceof Error ? error.message : String(error) },
      }));
      return;
    }

    if (!enabled) {
      setConnectorTestResult((prev) => ({ ...prev, [pluginName]: undefined }));
      return;
    }

    setConnectorTesting((prev) => ({ ...prev, [pluginName]: true }));
    try {
      const result = await api.plugins.connectorTest(pluginName);
      setConnectorTestResult((prev) => ({ ...prev, [pluginName]: { ok: result.ok, error: result.error } }));
    } catch (error) {
      setConnectorTestResult((prev) => ({
        ...prev,
        [pluginName]: { ok: false, error: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setConnectorTesting((prev) => ({ ...prev, [pluginName]: false }));
    }
  }

  const saveAndTestAllConnectors = useMutation({
    mutationFn: async () => {
      for (const plugin of connectorPlugins) {
        await saveAndTestConnector(plugin.name);
      }
    },
  });

  const [backendType, setBackendType] = useState<"local" | "remote">("local");
  const [backendPort, setBackendPort] = useState("3001");
  const [backendUrl, setBackendUrl] = useState("");

  const [codingEnabled, setCodingEnabled] = useState(toBool(settingsMap.get("CODING_ENABLED"), false));
  const [wikiEnabled, setWikiEnabled] = useState(toBool(settingsMap.get("WIKI_ENABLED"), false));

  const [autoSkillSelection, setAutoSkillSelection] = useState(toBool(settingsMap.get("AGENT_AUTO_SKILL_SELECTION"), true));
  const [skillBehavior, setSkillBehavior] = useState<SkillBehavior>((settingsMap.get("AGENT_SKILL_BEHAVIOR") as SkillBehavior | undefined) ?? "automatic");
  const [autoSkillFallbackNone, setAutoSkillFallbackNone] = useState(toBool(settingsMap.get("AGENT_AUTO_SKILL_FALLBACK_NONE"), true));
  const [audioEnabled, setAudioEnabled] = useState(toBool(settingsMap.get("AUDIO_ENABLED"), false));

  // Plugins step: every installed non-connector plugin, toggled locally and applied on finish.
  const regularPlugins = useMemo(() => (connectorPluginsQuery.data ?? []).filter((p) => !p.connector), [connectorPluginsQuery.data]);
  const [pluginEnabled, setPluginEnabled] = useState<Record<string, boolean>>({});
  const isPluginEnabled = (plugin: PluginInfo) => pluginEnabled[plugin.name] ?? plugin.enabled;

  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills.list(), enabled: open });
  const [skillImportUrl, setSkillImportUrl] = useState("");
  const importSkill = useMutation({
    mutationFn: (url: string) => api.skills.import({ url }),
    onSuccess: async () => {
      setSkillImportUrl("");
      await qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const [providerTest, setProviderTest] = useState<ProviderTestState>({ status: "idle", models: [] });
  useEffect(() => setProviderTest({ status: "idle", models: [] }), [provider]);

  // Desktop step (Tauri shell only): read the shell's current preferences once per opening.
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [desktopPrefs, setDesktopPrefs] = useState<DesktopPrefsState | null>(null);
  useEffect(() => {
    if (!open || !desktopMode) return;
    getDesktopInfo()
      .then((info) => {
        setDesktopInfo(info);
        if (info) setDesktopPrefs({ autostart: info.autostart, closeToTray: info.closeToTray, showSplash: info.showSplash });
      })
      .catch(() => setDesktopInfo(null));
  }, [open, desktopMode]);

  useEffect(() => {
    if (!open) return;
    setProvider((settingsMap.get("DEFAULT_PROVIDER") as ProviderName | undefined) ?? "lmstudio");
    setLmStudioBaseUrl(settingsMap.get("LM_STUDIO_BASE_URL") ?? "http://localhost:1234/v1");
    setLmStudioModel(settingsMap.get("LM_STUDIO_MODEL") ?? "local-model");
    setOpenRouterApiKey(settingsMap.get("OPENROUTER_API_KEY") ?? "");
    setOpenRouterModel(settingsMap.get("OPENROUTER_MODEL") ?? "openrouter/free");
    setOpenAiApiKey(settingsMap.get("OPENAI_API_KEY") ?? "");
    setOpenAiModel(settingsMap.get("OPENAI_MODEL") ?? "gpt-4o");
    setOllamaBaseUrl(settingsMap.get("OLLAMA_BASE_URL") ?? "http://localhost:11434");
    setOllamaModel(settingsMap.get("OLLAMA_MODEL") ?? "llama3");
    setClaudeApiKey(settingsMap.get("CLAUDE_API_KEY") ?? "");
    setClaudeModel(settingsMap.get("CLAUDE_MODEL") ?? "claude-3-5-sonnet-20241022");

    setCodingEnabled(toBool(settingsMap.get("CODING_ENABLED"), false));
    setWikiEnabled(toBool(settingsMap.get("WIKI_ENABLED"), false));

    setAutoSkillSelection(toBool(settingsMap.get("AGENT_AUTO_SKILL_SELECTION"), true));
    setSkillBehavior((settingsMap.get("AGENT_SKILL_BEHAVIOR") as SkillBehavior | undefined) ?? "automatic");
    setAutoSkillFallbackNone(toBool(settingsMap.get("AGENT_AUTO_SKILL_FALLBACK_NONE"), true));
    setAudioEnabled(toBool(settingsMap.get("AUDIO_ENABLED"), false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settingsMap]);

  /** Settings writes for the currently selected provider (shared by "test" and "finish"). */
  function providerWrites(): Array<Promise<unknown>> {
    const writes: Array<Promise<unknown>> = [api.settings.set("DEFAULT_PROVIDER", provider)];
    if (provider === "lmstudio") {
      writes.push(api.settings.set("LM_STUDIO_BASE_URL", lmStudioBaseUrl));
      writes.push(api.settings.set("LM_STUDIO_MODEL", lmStudioModel));
    }
    if (provider === "openrouter") {
      writes.push(api.settings.set("OPENROUTER_API_KEY", openRouterApiKey));
      writes.push(api.settings.set("OPENROUTER_MODEL", openRouterModel || "openrouter/free"));
    }
    if (provider === "openai") {
      writes.push(api.settings.set("OPENAI_API_KEY", openAiApiKey));
      writes.push(api.settings.set("OPENAI_MODEL", openAiModel));
    }
    if (provider === "ollama") {
      writes.push(api.settings.set("OLLAMA_BASE_URL", ollamaBaseUrl));
      writes.push(api.settings.set("OLLAMA_MODEL", ollamaModel));
    }
    if (provider === "claude") {
      writes.push(api.settings.set("CLAUDE_API_KEY", claudeApiKey));
      writes.push(api.settings.set("CLAUDE_MODEL", claudeModel));
    }
    return writes;
  }

  /** Saves the provider settings, then asks the agent for that provider's model list. */
  async function testProvider(): Promise<void> {
    setProviderTest({ status: "testing", models: [] });
    try {
      await Promise.all(providerWrites());
      const result = await api.providerModels.getModels(provider);
      setProviderTest({ status: "ok", models: result.models ?? [] });
    } catch (error) {
      setProviderTest({ status: "error", models: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  const saveSetup = useMutation({
    mutationFn: async () => {
      const writes: Array<Promise<unknown>> = providerWrites();

      // Connector plugins (Discord etc.) are saved+enabled+tested via their own dedicated plugin
      // endpoints (PUT /api/plugins/:name/settings, POST enable/disable, POST connector/test) -
      // not via the legacy MESSAGING_GATEWAYS setting, which the wizard no longer reads or
      // writes at all. Run this first so a failed connectivity test never blocks the rest of the
      // wizard finishing (soft check, per the plan) and so it also covers the case where the
      // user jumped straight to the summary step via the step tabs instead of clicking "Next"
      // through the connectors step.
      for (const plugin of connectorPlugins) {
        await saveAndTestConnector(plugin.name).catch(() => {
          // Never abort the whole wizard finish because one connector plugin failed to save/test.
        });
      }

      // Plugin toggles: only touch plugins whose state actually changed.
      for (const plugin of regularPlugins) {
        const desired = pluginEnabled[plugin.name];
        if (desired === undefined || desired === plugin.enabled) continue;
        await (desired ? api.plugins.enable(plugin.name) : api.plugins.disable(plugin.name)).catch(() => {
          // A single plugin failing to (un)load must not block finishing the wizard.
        });
      }
      if (desktopMode && desktopPrefs) {
        await setDesktopPreferences(desktopPrefs).catch(() => {});
      }

      writes.push(api.settings.set("CODING_ENABLED", String(codingEnabled)));
      writes.push(api.settings.set("AUDIO_ENABLED", String(audioEnabled)));
      writes.push(api.settings.set("WIKI_ENABLED", String(wikiEnabled)));

      writes.push(api.settings.set("AGENT_AUTO_SKILL_SELECTION", String(autoSkillSelection)));
      writes.push(api.settings.set("AGENT_SKILL_BEHAVIOR", skillBehavior));
      writes.push(api.settings.set("AGENT_AUTO_SKILL_FALLBACK_NONE", String(autoSkillFallbackNone)));

      writes.push(api.settings.set("SETUP_COMPLETED", "true"));
      writes.push(api.settings.set("SETUP_COMPLETED_AT", new Date().toISOString()));

      await Promise.all(writes);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings"] });
      await qc.invalidateQueries({ queryKey: ["plugins"] });
      onClose();
      setStep(0);
    },
  });

  if (!open) return null;

  const stepKeys: StepKey[] = [
    "appearance",
    "llm",
    "backend",
    "connectors",
    "plugins",
    "features",
    "agent",
    ...(desktopMode ? (["desktop"] as StepKey[]) : []),
    "summary",
  ];
  const lastStep = stepKeys.length - 1;
  const stepKey = stepKeys[Math.min(step, lastStep)];
  const isLastStep = stepKey === "summary";
  const steps = stepKeys.map((key) => t(`setupWizard.steps.${key}`));
  const enabledPluginCount = regularPlugins.filter(isPluginEnabled).length;
  const modelListId = "setup-wizard-models";
  const modelInputProps = providerTest.models.length > 0 ? { list: modelListId } : {};

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-start gap-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-300" />
                {t("setupWizard.title")}
              </h2>
              <p className="text-xs text-gray-400 mt-1">{t("setupWizard.step")} {step + 1} {t("setupWizard.of")} {stepKeys.length}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-1">
              {steps.map((label, index) => {
                const active = step === index;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setStep(index)}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      active
                        ? "bg-emerald-500/20 text-emerald-200 border-emerald-400/40"
                        : "bg-gray-900 text-gray-300 border-gray-700 hover:text-white hover:border-gray-500"
                    }`}
                  >
                    {index + 1}. {label}
                  </button>
                );
              })}
            </div>
          </div>
          <button className="text-gray-400 hover:text-white" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="border-b border-gray-800 bg-gray-900/40 px-5 py-3">
          <p className="text-sm leading-6 text-gray-300">{t(`setupWizard.stepDescriptions.${stepKey}`)}</p>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto min-h-0">
          {stepKey === "appearance" && (
            <div className="space-y-5">
              <h3 className="text-base font-semibold flex items-center gap-2"><Palette className="w-4 h-4 text-amber-300" /> {t("setupWizard.section.appearance")}</h3>
              <div className="space-y-2">
                <label className="text-sm text-gray-300 block">{t("setupWizard.appearance.language")}</label>
                <div className="flex flex-wrap gap-2">
                  {languages.map((entry) => (
                    <button
                      key={entry.code}
                      type="button"
                      onClick={() => setLanguage(entry.code)}
                      className={language === entry.code ? "btn-primary flex items-center gap-2" : "btn-secondary flex items-center gap-2"}
                    >
                      <img src={entry.flagSrc} alt="" className="h-3 w-4 rounded-[2px]" />
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-gray-300 block">{t("themeSettings.modeTitle")}</label>
                <div className="flex flex-wrap gap-2">
                  {THEME_MODES.map((value) => {
                    const Icon = THEME_MODE_ICONS[value];
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => theme.setMode(value)}
                        className={theme.mode === value ? "btn-primary flex items-center gap-2" : "btn-secondary flex items-center gap-2"}
                      >
                        <Icon className="w-4 h-4" />
                        {t(`themeSettings.mode.${value}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-gray-300 block">{t("themeSettings.accentTitle")}</label>
                <div className="flex flex-wrap gap-3">
                  {ACCENT_COLORS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => theme.setAccent(value)}
                      title={t(`themeSettings.accent.${value}`)}
                      aria-label={t(`themeSettings.accent.${value}`)}
                      className={`relative w-9 h-9 rounded-full border-2 transition ${ACCENT_SWATCH_CLASS[value]} ${
                        theme.accent === value ? "border-white" : "border-transparent hover:border-gray-500"
                      }`}
                    >
                      {theme.accent === value && <Check className="w-4 h-4 text-white absolute inset-0 m-auto drop-shadow" />}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-gray-400">{t("setupWizard.appearance.hint")}</p>
            </div>
          )}

          {stepKey === "llm" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{t("setupWizard.section.llm")}</h3>
              <label className="text-sm text-gray-300 block">{t("setupWizard.provider")}</label>
              <select className="input w-full" value={provider} onChange={(e) => setProvider(e.target.value as ProviderName)}>
                <option value="lmstudio">{t("setupWizard.providerOptions.lmstudio")}</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="claude">Claude (Anthropic)</option>
              </select>

              {provider === "lmstudio" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" value={lmStudioBaseUrl} onChange={(e) => setLmStudioBaseUrl(e.target.value)} placeholder={t("setupWizard.placeholders.lmStudioBaseUrl")} />
                  <input className="input" value={lmStudioModel} onChange={(e) => setLmStudioModel(e.target.value)} placeholder={t("setupWizard.placeholders.lmStudioModel")} {...modelInputProps} />
                </div>
              )}

              {provider === "openrouter" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openRouterApiKey} onChange={(e) => setOpenRouterApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.openRouterApiKey")} />
                  <input className="input" value={openRouterModel} onChange={(e) => setOpenRouterModel(e.target.value)} placeholder="openrouter/free" {...modelInputProps} />
                </div>
              )}

              {provider === "openai" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openAiApiKey} onChange={(e) => setOpenAiApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.openAiApiKey")} />
                  <input className="input" value={openAiModel} onChange={(e) => setOpenAiModel(e.target.value)} placeholder="gpt-4o" {...modelInputProps} />
                </div>
              )}

              {provider === "ollama" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" value={ollamaBaseUrl} onChange={(e) => setOllamaBaseUrl(e.target.value)} placeholder={t("setupWizard.placeholders.ollamaBaseUrl")} />
                  <input className="input" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder={t("setupWizard.placeholders.ollamaModel")} {...modelInputProps} />
                </div>
              )}

              {provider === "claude" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={claudeApiKey} onChange={(e) => setClaudeApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.claudeApiKey")} />
                  <input className="input" value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} placeholder="claude-3-5-sonnet-20241022" {...modelInputProps} />
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" className="btn-secondary inline-flex items-center gap-2 text-sm" disabled={providerTest.status === "testing"} onClick={() => void testProvider()}>
                  {providerTest.status === "testing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  {t("setupWizard.llmTest.button")}
                </button>
                {providerTest.status === "ok" && (
                  <span className="text-xs text-emerald-300 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t("setupWizard.llmTest.ok").replace("{count}", String(providerTest.models.length))}
                  </span>
                )}
                {providerTest.status === "error" && (
                  <span className="text-xs text-amber-300 flex items-center gap-1 min-w-0">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate" title={providerTest.error}>{t("setupWizard.llmTest.failed")}: {providerTest.error}</span>
                  </span>
                )}
              </div>
              {providerTest.models.length > 0 && (
                <datalist id={modelListId}>
                  {providerTest.models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </datalist>
              )}

            </div>
          )}

          {stepKey === "backend" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Backend-Verbindung</h3>
              <BackendSettings />
            </div>
          )}

          {stepKey === "connectors" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold flex items-center gap-2"><Plug className="w-4 h-4 text-cyan-300" /> {t("setupWizard.section.connectors")}</h3>
              <p className="text-xs text-gray-400">{t("setupWizard.connectors.intro")}</p>

              {connectorPluginsQuery.isLoading ? (
                <p className="text-sm text-gray-400">...</p>
              ) : connectorPlugins.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900 p-4 text-sm text-gray-400 space-y-2">
                  <p>{t("setupWizard.connectors.none")}</p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-cyan-300 underline text-xs"
                    onClick={() => { onClose(); navigate("/plugins"); }}
                  >
                    <ExternalLink className="w-3 h-3" /> {t("setupWizard.connectors.noneLink")}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {connectorPlugins.map((plugin) => {
                    const enabled = connectorEnabled[plugin.name] ?? plugin.enabled;
                    const values = connectorValues[plugin.name] ?? {};
                    const masked = connectorMasked[plugin.name];
                    const testResult = connectorTestResult[plugin.name];
                    const testing = Boolean(connectorTesting[plugin.name]);
                    return (
                      <div key={plugin.name} className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium flex items-center gap-2">
                              {plugin.icon ?? "🔌"} {plugin.name}
                              <span className="text-xs font-normal text-gray-500">({plugin.connector.portal})</span>
                            </div>
                            {plugin.description && <p className="text-xs text-gray-500 mt-0.5">{plugin.description}</p>}
                          </div>
                          <label className="flex items-center gap-2 text-sm text-gray-300 shrink-0">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => setConnectorEnabled((prev) => ({ ...prev, [plugin.name]: e.target.checked }))}
                            />
                            {t("setupWizard.connectors.enable")}
                          </label>
                        </div>

                        {enabled && (
                          <>
                            <PluginSettingsForm
                              specs={plugin.settings}
                              values={values}
                              maskedKeys={masked}
                              onChange={(key, value) =>
                                setConnectorValues((prev) => ({ ...prev, [plugin.name]: { ...(prev[plugin.name] ?? {}), [key]: value } }))
                              }
                            />
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                className="btn-secondary text-xs"
                                disabled={testing}
                                onClick={() => void saveAndTestConnector(plugin.name)}
                              >
                                {testing ? t("setupWizard.connectors.testing") : `${t("setupWizard.connectors.save")} & ${t("setupWizard.connectors.test")}`}
                              </button>
                              {testResult && (
                                <span className={`text-xs flex items-center gap-1 ${testResult.ok ? "text-emerald-300" : "text-amber-300"}`}>
                                  {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                                  {testResult.ok ? t("setupWizard.connectors.testOk") : `${t("setupWizard.connectors.testFailed")}: ${testResult.error ?? "?"}`}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {stepKey === "plugins" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold flex items-center gap-2"><Puzzle className="w-4 h-4 text-violet-300" /> {t("setupWizard.section.plugins")}</h3>
              <p className="text-xs text-gray-400">{t("setupWizard.plugins.intro")}</p>
              {connectorPluginsQuery.isLoading ? (
                <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> …</p>
              ) : regularPlugins.length === 0 ? (
                <p className="text-sm text-gray-400">{t("setupWizard.plugins.none")}</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {regularPlugins.map((plugin) => {
                    const enabled = isPluginEnabled(plugin);
                    return (
                      <label
                        key={plugin.name}
                        className={`flex items-start gap-3 rounded-lg border p-3 text-sm cursor-pointer transition-colors ${
                          enabled ? "border-emerald-500/40 bg-emerald-500/5" : "border-gray-800 bg-gray-900"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={enabled}
                          onChange={(e) => setPluginEnabled((prev) => ({ ...prev, [plugin.name]: e.target.checked }))}
                        />
                        <span className="min-w-0">
                          <span className="font-medium flex items-center gap-1.5">
                            <span>{plugin.icon ?? "🧩"}</span>
                            <span className="truncate">{plugin.name}</span>
                            <span className="text-[10px] text-gray-500">v{plugin.version}</span>
                          </span>
                          {plugin.description && <span className="mt-0.5 text-xs text-gray-400 line-clamp-2">{plugin.description}</span>}
                          {plugin.toolNames.length > 0 && (
                            <span className="block text-[11px] text-gray-500 mt-1">
                              {t("setupWizard.plugins.tools").replace("{count}", String(plugin.toolNames.length))}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <button type="button" className="inline-flex items-center gap-1 text-cyan-300 underline text-xs" onClick={() => { onClose(); navigate("/plugins"); }}>
                <ExternalLink className="w-3 h-3" /> {t("setupWizard.plugins.more")}
              </button>
            </div>
          )}

          {stepKey === "features" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{t("setupWizard.section.features")}</h3>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>{t("setupWizard.features.coding")}</span>
                <input type="checkbox" checked={codingEnabled} onChange={(e) => setCodingEnabled(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>{t("setupWizard.features.wiki")}</span>
                <input type="checkbox" checked={wikiEnabled} onChange={(e) => setWikiEnabled(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>{t("setupWizard.features.voice")}</span>
                <input type="checkbox" checked={audioEnabled} onChange={(e) => setAudioEnabled(e.target.checked)} />
              </label>
            </div>
          )}

          {stepKey === "agent" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{t("setupWizard.section.agent")}</h3>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>
                  {t("setupWizard.agent.autoSelection")}
                  <span className="block text-xs text-gray-400 mt-0.5">{t("setupWizard.agent.autoSelectionHint")}</span>
                </span>
                <input type="checkbox" checked={autoSkillSelection} onChange={(e) => setAutoSkillSelection(e.target.checked)} />
              </label>

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
                <label className="text-sm text-gray-300 block">{t("setupWizard.agent.behavior")}</label>
                <select className="input w-full" value={skillBehavior} onChange={(e) => setSkillBehavior(e.target.value as SkillBehavior)}>
                  <option value="automatic">{t("setupWizard.agent.behaviorAutomatic")}</option>
                  <option value="active">{t("setupWizard.agent.behaviorActive")}</option>
                </select>
              </div>

              {skillBehavior === "automatic" && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
                  <label className="text-sm text-gray-300 block">{t("setupWizard.agent.fallback")}</label>
                  <select className="input w-full" value={String(autoSkillFallbackNone)} onChange={(e) => setAutoSkillFallbackNone(e.target.value === "true")}>
                    <option value="true">{t("setupWizard.agent.fallbackNone")}</option>
                    <option value="false">{t("setupWizard.agent.fallbackAll")}</option>
                  </select>
                </div>
              )}

              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm text-gray-300">{t("setupWizard.skills.installed").replace("{count}", String(skillsQuery.data?.length ?? 0))}</label>
                  {desktopMode && (
                    <button type="button" className="text-xs text-cyan-300 underline inline-flex items-center gap-1" onClick={() => void openDesktopFolder("skills")}>
                      <FolderOpen className="w-3 h-3" /> {t("setupWizard.desktop.folders.skills")}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                  {(skillsQuery.data ?? []).map((skill) => (
                    <span key={skill.slug} title={skill.description} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-0.5 text-xs text-gray-300">
                      {skill.name || skill.slug}
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    value={skillImportUrl}
                    onChange={(e) => setSkillImportUrl(e.target.value)}
                    placeholder={t("setupWizard.skills.importPlaceholder")}
                  />
                  <button
                    type="button"
                    className="btn-secondary text-sm inline-flex items-center gap-2"
                    disabled={!skillImportUrl.trim() || importSkill.isPending}
                    onClick={() => importSkill.mutate(skillImportUrl.trim())}
                  >
                    {importSkill.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t("setupWizard.skills.import")}
                  </button>
                </div>
                {importSkill.isSuccess && <p className="text-xs text-emerald-300">{t("setupWizard.skills.imported").replace("{slug}", importSkill.data.slug)}</p>}
                {importSkill.isError && <p className="text-xs text-amber-300">{importSkill.error instanceof Error ? importSkill.error.message : String(importSkill.error)}</p>}
              </div>
            </div>
          )}

          {stepKey === "desktop" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold flex items-center gap-2"><Monitor className="w-4 h-4 text-sky-300" /> {t("setupWizard.section.desktop")}</h3>
              {!desktopPrefs ? (
                <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> …</p>
              ) : (
                <>
                  {(
                    [
                      ["autostart", "setupWizard.desktop.autostart", "setupWizard.desktop.autostartHint"],
                      ["closeToTray", "setupWizard.desktop.closeToTray", "setupWizard.desktop.closeToTrayHint"],
                      ["showSplash", "setupWizard.desktop.showSplash", "setupWizard.desktop.showSplashHint"],
                    ] as const
                  ).map(([key, label, hint]) => (
                    <label key={key} className="flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                      <span>
                        {t(label)}
                        <span className="block text-xs text-gray-400 mt-0.5">{t(hint)}</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={desktopPrefs[key]}
                        onChange={(e) => setDesktopPrefs((prev) => (prev ? { ...prev, [key]: e.target.checked } : prev))}
                      />
                    </label>
                  ))}
                  <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
                    <p className="text-sm text-gray-300">{t("setupWizard.desktop.folders.title")}</p>
                    <div className="flex flex-wrap gap-2">
                      {(["workspace", "skills", "plugins", "data", "logs"] as DesktopFolder[]).map((kind) => (
                        <button key={kind} type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={() => void openDesktopFolder(kind)}>
                          <FolderOpen className="w-3.5 h-3.5" /> {t(`setupWizard.desktop.folders.${kind}`)}
                        </button>
                      ))}
                    </div>
                    {desktopInfo && (
                      <p className="text-[11px] text-gray-500 break-all">
                        {t("setupWizard.desktop.workspacePath")}: {desktopInfo.workspaceDir} · {t("setupWizard.desktop.agentPort")}: {desktopInfo.port} · v{desktopInfo.version}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {stepKey === "summary" && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{t("setupWizard.section.summary")}</h3>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm space-y-2">
                <p><strong>{t("setupWizard.summary.appearance")}:</strong> {languages.find((l) => l.code === language)?.label} · {t(`themeSettings.mode.${theme.mode}`)} · {t(`themeSettings.accent.${theme.accent}`)}</p>
                <p><strong>{t("setupWizard.summary.provider")}:</strong> {provider}</p>
                {provider === "openrouter" && <p><strong>{t("setupWizard.summary.openRouterModel")}:</strong> {openRouterModel || "openrouter/free"}</p>}
                {provider === "claude" && <p><strong>{t("setupWizard.summary.claudeModel")}:</strong> {claudeModel}</p>}
                <p>
                  <strong>{t("setupWizard.summary.gateway")}:</strong>{" "}
                  {connectorPlugins.filter((p) => connectorEnabled[p.name] ?? p.enabled).length > 0
                    ? connectorPlugins
                        .filter((p) => connectorEnabled[p.name] ?? p.enabled)
                        .map((p) => p.connector.portal)
                        .join(", ")
                    : t("setupWizard.summary.off")}
                </p>
                <p><strong>{t("setupWizard.summary.coding")}:</strong> {codingEnabled ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
                <p><strong>{t("setupWizard.summary.wiki")}:</strong> {wikiEnabled ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
                <p><strong>{t("setupWizard.summary.voice")}:</strong> {audioEnabled ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
                <p><strong>{t("setupWizard.summary.plugins")}:</strong> {enabledPluginCount} / {regularPlugins.length}</p>
                <p><strong>{t("setupWizard.summary.skillBehavior")}:</strong> {skillBehavior === "automatic" ? t("setupWizard.agent.behaviorAutomatic") : t("setupWizard.agent.behaviorActive")}</p>
                <p><strong>{t("setupWizard.summary.skillSelection")}:</strong> {autoSkillSelection ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
                {desktopMode && desktopPrefs && (
                  <p><strong>{t("setupWizard.summary.autostart")}:</strong> {desktopPrefs.autostart ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
                )}
              </div>
              <p className="text-xs text-gray-400 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-300" />{t("setupWizard.summary.saveHint")}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between">
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || saveSetup.isPending}
          >
            <ChevronLeft className="w-4 h-4" /> {t("setupWizard.back")}
          </button>

          {isLastStep ? (
            <button className="btn-primary" onClick={() => saveSetup.mutate()} disabled={saveSetup.isPending}>
              {saveSetup.isPending ? t("setupWizard.saving") : t("setupWizard.finish")}
            </button>
          ) : (
            <button
              className="btn-primary inline-flex items-center gap-2"
              disabled={saveAndTestAllConnectors.isPending}
              onClick={async () => {
                // Leaving the Connectors step: save + soft-test every connector plugin before
                // marking the step done, without blocking navigation on a failed test.
                if (stepKey === "connectors") {
                  await saveAndTestAllConnectors.mutateAsync().catch(() => {});
                }
                setStep((s) => Math.min(lastStep, s + 1));
              }}
            >
              {saveAndTestAllConnectors.isPending && stepKey === "connectors" ? t("setupWizard.connectors.testing") : t("setupWizard.next")} <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
