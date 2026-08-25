import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, ChevronLeft, ChevronRight, Plug, Sparkles, X, AlertTriangle, ExternalLink } from "lucide-react";
import { api, type PluginInfo } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
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

/** The wizard step index the generic "Connectors" step lives at (was the Discord-only step). */
const CONNECTORS_STEP = 2;

export function SetupWizardModal({ open, onClose, settings }: SetupWizardModalProps) {
  const { t } = useI18n();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settingsMap]);

  const saveSetup = useMutation({
    mutationFn: async () => {
      const writes: Array<Promise<unknown>> = [];
      writes.push(api.settings.set("DEFAULT_PROVIDER", provider));

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

      writes.push(api.settings.set("CODING_ENABLED", String(codingEnabled)));
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
      onClose();
      setStep(0);
    },
  });

  if (!open) return null;

  const isLastStep = step === 5;
  const steps = [
    t("setupWizard.steps.llm"),
    "Backend",
    t("setupWizard.steps.connectors"),
    t("setupWizard.steps.features"),
    t("setupWizard.steps.agent"),
    t("setupWizard.steps.summary"),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-start gap-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-300" />
                {t("setupWizard.title")}
              </h2>
              <p className="text-xs text-gray-400 mt-1">{t("setupWizard.step")} {step + 1} {t("setupWizard.of")} 6</p>
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

        <div className="p-5 space-y-4">
          {step === 0 && (
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
                  <input className="input" value={lmStudioModel} onChange={(e) => setLmStudioModel(e.target.value)} placeholder={t("setupWizard.placeholders.lmStudioModel")} />
                </div>
              )}

              {provider === "openrouter" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openRouterApiKey} onChange={(e) => setOpenRouterApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.openRouterApiKey")} />
                  <input className="input" value={openRouterModel} onChange={(e) => setOpenRouterModel(e.target.value)} placeholder="openrouter/free" />
                </div>
              )}

              {provider === "openai" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openAiApiKey} onChange={(e) => setOpenAiApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.openAiApiKey")} />
                  <input className="input" value={openAiModel} onChange={(e) => setOpenAiModel(e.target.value)} placeholder="gpt-4o" />
                </div>
              )}

              {provider === "ollama" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" value={ollamaBaseUrl} onChange={(e) => setOllamaBaseUrl(e.target.value)} placeholder={t("setupWizard.placeholders.ollamaBaseUrl")} />
                  <input className="input" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder={t("setupWizard.placeholders.ollamaModel")} />
                </div>
              )}

              {provider === "claude" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={claudeApiKey} onChange={(e) => setClaudeApiKey(e.target.value)} placeholder={t("setupWizard.placeholders.claudeApiKey")} />
                  <input className="input" value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} placeholder="claude-3-5-sonnet-20241022" />
                </div>
              )}

            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Backend-Verbindung</h3>
              <BackendSettings />
            </div>
          )}

          {step === CONNECTORS_STEP && (
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

          {step === 3 && (
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
            </div>
          )}

          {step === 4 && (
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
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">{t("setupWizard.section.summary")}</h3>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm space-y-2">
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
                <p><strong>{t("setupWizard.summary.skillBehavior")}:</strong> {skillBehavior === "automatic" ? t("setupWizard.agent.behaviorAutomatic") : t("setupWizard.agent.behaviorActive")}</p>
                <p><strong>{t("setupWizard.summary.skillSelection")}:</strong> {autoSkillSelection ? t("setupWizard.summary.on") : t("setupWizard.summary.off")}</p>
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
                if (step === CONNECTORS_STEP) {
                  await saveAndTestAllConnectors.mutateAsync().catch(() => {});
                }
                setStep((s) => Math.min(5, s + 1));
              }}
            >
              {saveAndTestAllConnectors.isPending && step === CONNECTORS_STEP ? t("setupWizard.connectors.testing") : t("setupWizard.next")} <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
