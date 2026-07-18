import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Sparkles, X } from "lucide-react";
import { api } from "../../lib/api";

interface SettingEntry {
  key: string;
  value: string;
}

interface SetupWizardModalProps {
  open: boolean;
  onClose: () => void;
  settings: SettingEntry[];
}

type ProviderName = "lmstudio" | "openrouter" | "openai" | "ollama";

function toBool(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseGateways(raw: string | undefined): Array<{ id: string; portal: string; enabled: boolean; authToken?: string; guildId?: string; userId?: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item, index) => ({
        id: String(item["id"] ?? `gateway_${index + 1}`),
        portal: String(item["portal"] ?? "custom"),
        enabled: item["enabled"] !== false,
        authToken: item["authToken"] ? String(item["authToken"]) : undefined,
        guildId: item["guildId"] ? String(item["guildId"]) : undefined,
        userId: item["userId"] ? String(item["userId"]) : undefined,
      }));
  } catch {
    return [];
  }
}

export function SetupWizardModal({ open, onClose, settings }: SetupWizardModalProps) {
  const qc = useQueryClient();
  const settingsMap = useMemo(() => new Map(settings.map((entry) => [entry.key, entry.value])), [settings]);

  const gateways = useMemo(() => parseGateways(settingsMap.get("MESSAGING_GATEWAYS")), [settingsMap]);
  const discordGateway = gateways.find((entry) => entry.portal === "discord");

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

  const [gatewayEnabled, setGatewayEnabled] = useState(Boolean(discordGateway?.enabled));
  const [discordBotToken, setDiscordBotToken] = useState(discordGateway?.authToken ?? "");
  const [discordGuildId, setDiscordGuildId] = useState(discordGateway?.guildId ?? "");
  const [discordAllowedUserId, setDiscordAllowedUserId] = useState(discordGateway?.userId ?? "");

  const [codingEnabled, setCodingEnabled] = useState(toBool(settingsMap.get("CODING_ENABLED"), false));
  const [wikiEnabled, setWikiEnabled] = useState(toBool(settingsMap.get("WIKI_ENABLED"), false));

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

      const gatewayPayload = gatewayEnabled
        ? [
            {
              id: "discord_main",
              portal: "discord",
              name: "Discord Gateway",
              enabled: true,
              authToken: discordBotToken,
              guildId: discordGuildId || undefined,
              userId: discordAllowedUserId || undefined,
            },
          ]
        : [];
      writes.push(api.settings.set("MESSAGING_GATEWAYS", JSON.stringify(gatewayPayload)));

      writes.push(api.settings.set("CODING_ENABLED", String(codingEnabled)));
      writes.push(api.settings.set("WIKI_ENABLED", String(wikiEnabled)));
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

  const isLastStep = step === 3;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-300" />
              Setup Assistent
            </h2>
            <p className="text-xs text-gray-400 mt-1">Schritt {step + 1} von 4</p>
          </div>
          <button className="text-gray-400 hover:text-white" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {step === 0 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">LLM Einstellungen</h3>
              <label className="text-sm text-gray-300 block">Provider</label>
              <select className="input w-full" value={provider} onChange={(e) => setProvider(e.target.value as ProviderName)}>
                <option value="lmstudio">LM Studio (lokal)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
              </select>

              {provider === "lmstudio" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" value={lmStudioBaseUrl} onChange={(e) => setLmStudioBaseUrl(e.target.value)} placeholder="LM Studio Base URL" />
                  <input className="input" value={lmStudioModel} onChange={(e) => setLmStudioModel(e.target.value)} placeholder="LM Studio Model" />
                </div>
              )}

              {provider === "openrouter" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openRouterApiKey} onChange={(e) => setOpenRouterApiKey(e.target.value)} placeholder="OpenRouter API Key" />
                  <input className="input" value={openRouterModel} onChange={(e) => setOpenRouterModel(e.target.value)} placeholder="openrouter/free" />
                </div>
              )}

              {provider === "openai" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" type="password" value={openAiApiKey} onChange={(e) => setOpenAiApiKey(e.target.value)} placeholder="OpenAI API Key" />
                  <input className="input" value={openAiModel} onChange={(e) => setOpenAiModel(e.target.value)} placeholder="gpt-4o" />
                </div>
              )}

              {provider === "ollama" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input className="input" value={ollamaBaseUrl} onChange={(e) => setOllamaBaseUrl(e.target.value)} placeholder="Ollama Base URL" />
                  <input className="input" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder="llama3" />
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Gateway Einstellungen</h3>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={gatewayEnabled} onChange={(e) => setGatewayEnabled(e.target.checked)} />
                Discord Gateway aktivieren
              </label>
              {gatewayEnabled && (
                <div className="space-y-3">
                  <input className="input w-full" type="password" value={discordBotToken} onChange={(e) => setDiscordBotToken(e.target.value)} placeholder="Discord Bot Token" />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input className="input" value={discordGuildId} onChange={(e) => setDiscordGuildId(e.target.value)} placeholder="Discord Guild ID (optional)" />
                    <input className="input" value={discordAllowedUserId} onChange={(e) => setDiscordAllowedUserId(e.target.value)} placeholder="Allowed User ID (optional)" />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Features aktivieren</h3>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>Coding Bereich</span>
                <input type="checkbox" checked={codingEnabled} onChange={(e) => setCodingEnabled(e.target.checked)} />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm">
                <span>LLM-Wiki</span>
                <input type="checkbox" checked={wikiEnabled} onChange={(e) => setWikiEnabled(e.target.checked)} />
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Uebersicht</h3>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm space-y-2">
                <p><strong>Provider:</strong> {provider}</p>
                {provider === "openrouter" && <p><strong>OpenRouter Modell:</strong> {openRouterModel || "openrouter/free"}</p>}
                <p><strong>Gateway:</strong> {gatewayEnabled ? "Discord aktiv" : "Aus"}</p>
                <p><strong>Coding:</strong> {codingEnabled ? "An" : "Aus"}</p>
                <p><strong>LLM-Wiki:</strong> {wikiEnabled ? "An" : "Aus"}</p>
              </div>
              <p className="text-xs text-gray-400 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-300" />Beim Speichern werden die Einstellungen direkt in die Settings geschrieben.</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between">
          <button
            className="btn-secondary inline-flex items-center gap-2"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || saveSetup.isPending}
          >
            <ChevronLeft className="w-4 h-4" /> Zurueck
          </button>

          {isLastStep ? (
            <button className="btn-primary" onClick={() => saveSetup.mutate()} disabled={saveSetup.isPending}>
              {saveSetup.isPending ? "Speichert..." : "Setup abschliessen"}
            </button>
          ) : (
            <button className="btn-primary inline-flex items-center gap-2" onClick={() => setStep((s) => Math.min(3, s + 1))}>
              Weiter <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
