import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, RefreshCw, Send, Search, MessageSquare, Settings2, Mic, Image as ImageIcon, Smile, Copy, Upload } from "lucide-react";
import { api } from "../../lib/api";

type GatewayConfig = {
  id: string;
  portal: string;
  name: string;
  enabled: boolean;
  channelHint?: string;
  inboundLabel?: string;
  guildId?: string;
  userId?: string;
  appId?: string;
  publicKey?: string;
  metadata?: string;
  authToken?: string;
  webhookSecret?: string;
};

type GatewayConversation = {
  id: number;
  name: string;
  projectId?: number;
  createdAt: string;
  updatedAt: string;
};

type GatewayEndpoint = {
  id: string;
  portal: string;
  webhookUrl: string;
};

type SearchHit = {
  conversationId: number;
  conversationName: string;
  messageId: number;
  role: string;
  content: string;
  createdAt: string;
};

function makeId(portal: string): string {
  return `${portal}-${Date.now()}`;
}

function channelHintLabel(portal: string): string {
  return portal.trim().toLowerCase() === "discord" ? "Discord Channel ID / Hint" : "Channel Hint";
}

function inboundLabelLabel(portal: string): string {
  return portal.trim().toLowerCase() === "discord" ? "Discord User Label / Name" : "Inbound Label";
}

function authTokenLabel(portal: string): string {
  return portal.trim().toLowerCase() === "discord" ? "Discord Bot Token" : "Auth Token";
}

function webhookSecretLabel(portal: string): string {
  return portal.trim().toLowerCase() === "discord" ? "Discord Webhook URL / Secret" : "Webhook URL / Secret";
}

export function MessagingGateway() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const [newPortal, setNewPortal] = useState("discord");
  const [newName, setNewName] = useState("Community Gateway");
  const [newChannelHint, setNewChannelHint] = useState("#general");
  const [newGuildId, setNewGuildId] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newAppId, setNewAppId] = useState("");
  const [newPublicKey, setNewPublicKey] = useState("");
  const [newMetadata, setNewMetadata] = useState("");
  const [newToken, setNewToken] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [demoConfigId, setDemoConfigId] = useState("");
  const [inboundText, setInboundText] = useState("Hello from Gateway");
  const [inboundVoiceTranscript, setInboundVoiceTranscript] = useState("");
  const [inboundVoiceLanguage, setInboundVoiceLanguage] = useState("de-DE");
  const [inboundReactions, setInboundReactions] = useState("😀,👍");
  const [inboundAgentEmoji, setInboundAgentEmoji] = useState("✅");
  const [inboundMode, setInboundMode] = useState<"text" | "voice" | "file">("text");
  const [inboundFileName, setInboundFileName] = useState("note.txt");
  const [inboundFileText, setInboundFileText] = useState("Sample attachment content");
  const [inboundFileUrl, setInboundFileUrl] = useState("");
  const [inboundFileBase64, setInboundFileBase64] = useState("");
  const [inboundFileMimeType, setInboundFileMimeType] = useState("");
  const [inboundFileInputName, setInboundFileInputName] = useState<File | null>(null);

  const gatewayQuery = useQuery({
    queryKey: ["gateway"],
    queryFn: () => api.gateway.list(),
    refetchInterval: 2500,
  });

  const searchQuery = useQuery({
    queryKey: ["chat", "search", searchText],
    queryFn: () => api.chat.search(searchText),
    enabled: searchText.trim().length > 0,
  });

  const saveMutation = useMutation({
    mutationFn: (configs: GatewayConfig[]) => api.gateway.save(configs),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["gateway"] });
    },
  });

  const inboundMutation = useMutation({
    mutationFn: api.gateway.inbound,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["gateway"] });
      navigate(`/chat?conversationId=${result.conversationId}`);
    },
  });

  const configs = gatewayQuery.data?.configs ?? [];
  const endpoints = (gatewayQuery.data?.endpoints ?? []) as GatewayEndpoint[];
  const conversations = gatewayQuery.data?.conversations ?? [];
  const hits = (searchQuery.data ?? []) as SearchHit[];
  const mergedConfigs = useMemo(() => configs.map((config) => ({ ...config })), [configs]);
  const demoConfig = useMemo(() => {
    if (demoConfigId) {
      return mergedConfigs.find((config) => config.id === demoConfigId);
    }
    return mergedConfigs[0];
  }, [demoConfigId, mergedConfigs]);

  const endpointFor = (configId: string): GatewayEndpoint | undefined => endpoints.find((entry) => entry.id === configId);

  const parseReactions = (value: string): Array<{ emoji: string }> =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((emoji) => ({ emoji }));

  const buildInboundAttachments = (): Array<{ name: string; text?: string; url?: string; contentBase64?: string; mimeType?: string }> => {
    if (inboundMode !== "file") return [];
    return [
      {
        name: inboundFileName.trim() || "attachment.txt",
        contentBase64: inboundFileBase64 || undefined,
        mimeType: inboundFileMimeType || undefined,
        text: inboundFileText.trim() || undefined,
        url: inboundFileUrl.trim() || undefined,
      },
    ];
  };

  const readFileAsBase64 = (file: File): Promise<{ base64: string; mimeType: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result ?? "");
        const base64 = value.includes(",") ? (value.split(",")[1] ?? "") : value;
        resolve({ base64, mimeType: file.type || "application/octet-stream" });
      };
      reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden"));
      reader.readAsDataURL(file);
    });

  function updateConfig(index: number, patch: Partial<GatewayConfig>): void {
    const next = mergedConfigs.map((config, currentIndex) => (currentIndex === index ? { ...config, ...patch } : config));
    saveMutation.mutate(next);
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">Messaging Gateway</p>
          <h1 className="text-3xl font-semibold mt-2">Discord, Telegram und andere Portale an den Agenten anbinden</h1>
          <p className="text-sm text-gray-400 mt-2 max-w-3xl">
            Externe Portal-Nachrichten laufen hier in echte Conversations ein und erscheinen danach im normalen Chat-Verlauf.
          </p>
        </div>
        <button
          type="button"
          onClick={() => gatewayQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200 hover:border-gray-500"
        >
          <RefreshCw className="w-4 h-4" />
          Neu laden
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-2xl border border-gray-800 bg-gray-900/70 p-5 shadow-xl shadow-black/20">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2"><Settings2 className="w-4 h-4 text-cyan-300" /> Gateway-Konfiguration</h2>
              <p className="text-sm text-gray-400">Aktivierte Portale und Zuordnungen speichern.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = [
                  ...mergedConfigs,
                  {
                    id: makeId(newPortal),
                    portal: newPortal,
                    name: newName,
                    enabled: true,
                    channelHint: newChannelHint,
                    guildId: newGuildId || undefined,
                    userId: newUserId || undefined,
                    appId: newAppId || undefined,
                    publicKey: newPublicKey || undefined,
                    metadata: newMetadata || undefined,
                    authToken: newToken || undefined,
                    webhookSecret: newSecret || undefined,
                  },
                ];
                saveMutation.mutate(next);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
            >
              <Plus className="w-4 h-4" />
              Gateway hinzufügen
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 mb-4">
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">Portal</span>
              <input value={newPortal} onChange={(event) => setNewPortal(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">Name</span>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">{channelHintLabel(newPortal)}</span>
              <input value={newChannelHint} onChange={(event) => setNewChannelHint(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">Guild ID</span>
              <input value={newGuildId} onChange={(event) => setNewGuildId(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">User ID</span>
              <input value={newUserId} onChange={(event) => setNewUserId(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">Discord Application ID</span>
              <input value={newAppId} onChange={(event) => setNewAppId(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm md:col-span-2 xl:col-span-4">
              <span className="text-gray-400">Discord Public Key</span>
              <input value={newPublicKey} onChange={(event) => setNewPublicKey(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm md:col-span-2 xl:col-span-4">
              <span className="text-gray-400">Zusatzdaten / Metadata</span>
              <input value={newMetadata} onChange={(event) => setNewMetadata(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">{authTokenLabel(newPortal)}</span>
              <input value={newToken} onChange={(event) => setNewToken(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-gray-400">{webhookSecretLabel(newPortal)}</span>
              <input value={newSecret} onChange={(event) => setNewSecret(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm outline-none" />
            </label>
          </div>
          <p className="mb-4 text-xs text-gray-500">
            Erlaubte Portale: discord, telegram, slack, signal oder custom. Für Telegram und Discord ist authToken das Bot-Token; webhookSecret kann eine Outbound-Webhook-URL sein.
          </p>

          <div className="space-y-3">
            {mergedConfigs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-700 bg-gray-950/60 p-4 text-sm text-gray-400">
                Noch keine Gateways konfiguriert. Füge Discord oder Telegram hinzu, um Inbound-Nachrichten zu importieren.
              </div>
            ) : (
              mergedConfigs.map((config, index) => (
                <article key={config.id} className="rounded-xl border border-gray-800 bg-gray-950/60 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-medium capitalize">{config.portal} · {config.name}</h3>
                      <p className="text-xs text-gray-500">{config.channelHint ?? "Kein Channel Hint"}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateConfig(index, { enabled: !config.enabled })}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${config.enabled ? "bg-emerald-500/20 text-emerald-300" : "bg-gray-800 text-gray-400"}`}
                    >
                      {config.enabled ? "Aktiv" : "Inaktiv"}
                    </button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>Name</span>
                      <input value={config.name} onChange={(event) => updateConfig(index, { name: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>{channelHintLabel(config.portal)}</span>
                      <input value={config.channelHint ?? ""} onChange={(event) => updateConfig(index, { channelHint: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>{inboundLabelLabel(config.portal)}</span>
                      <input value={config.inboundLabel ?? ""} onChange={(event) => updateConfig(index, { inboundLabel: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>Guild ID</span>
                      <input value={config.guildId ?? ""} onChange={(event) => updateConfig(index, { guildId: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>User ID</span>
                      <input value={config.userId ?? ""} onChange={(event) => updateConfig(index, { userId: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>Discord Application ID</span>
                      <input value={config.appId ?? ""} onChange={(event) => updateConfig(index, { appId: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400 md:col-span-2 xl:col-span-4">
                      <span>Discord Public Key</span>
                      <input value={config.publicKey ?? ""} onChange={(event) => updateConfig(index, { publicKey: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400 md:col-span-2 xl:col-span-4">
                      <span>Metadata</span>
                      <input value={config.metadata ?? ""} onChange={(event) => updateConfig(index, { metadata: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>{authTokenLabel(config.portal)}</span>
                      <input value={config.authToken ?? ""} onChange={(event) => updateConfig(index, { authToken: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                    <label className="space-y-1 text-xs text-gray-400">
                      <span>{webhookSecretLabel(config.portal)}</span>
                      <input value={config.webhookSecret ?? ""} onChange={(event) => updateConfig(index, { webhookSecret: event.target.value })} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                    </label>
                  </div>
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-cyan-100 break-all">
                    <div className="font-semibold mb-1">Inbound Webhook</div>
                    <div className="text-cyan-200/80">{endpointFor(config.id)?.webhookUrl ?? "Wird beim Neuladen erzeugt"}</div>
                    <div className="mt-1 text-cyan-200/60">
                      Telegram sendet Updates an diesen Endpoint. Discord kann ueber einen kleinen Bridge-Service denselben Payload schicken.
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-gray-800 bg-gray-900/70 p-5 shadow-xl shadow-black/20 space-y-5">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><MessageSquare className="w-4 h-4 text-cyan-300" /> Gateway-Chats</h2>
            <p className="text-sm text-gray-400">Portal-Konversationen tauchen hier als normale Chats auf.</p>
          </div>

          <div className="space-y-3 max-h-[22rem] overflow-y-auto pr-1">
            {conversations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-700 bg-gray-950/60 p-4 text-sm text-gray-400">
                Noch keine importierten Gateway-Conversations.
              </div>
            ) : (
              conversations.map((conversation: GatewayConversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => navigate(`/chat?conversationId=${conversation.id}`)}
                  className="w-full rounded-xl border border-gray-800 bg-gray-950/60 p-4 text-left hover:border-cyan-500/60 transition"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{conversation.name}</div>
                      <div className="text-xs text-gray-500">Conversation #{conversation.id}</div>
                    </div>
                    <Send className="w-4 h-4 text-cyan-300" />
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2"><Search className="w-4 h-4 text-cyan-300" /> Chat-Historie durchsuchen</h3>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="z. B. Deploy, Fehler, Erinnerung..."
                className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none"
                onKeyDown={(event) => {
                  if (event.key === "Enter") setSearchText(query);
                }}
              />
              <button
                type="button"
                onClick={() => setSearchText(query)}
                className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
              >
                Suchen
              </button>
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {(searchText.trim().length === 0 ? [] : hits).map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  onClick={() => navigate(`/chat?conversationId=${hit.conversationId}`)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/70 p-3 text-left hover:border-cyan-500/60 transition"
                >
                  <div className="flex items-center justify-between gap-3 text-xs text-gray-500 mb-1">
                    <span>{hit.conversationName}</span>
                    <span className="uppercase">{hit.role}</span>
                  </div>
                  <p className="text-sm text-gray-200 line-clamp-2">{hit.content}</p>
                </button>
              ))}
              {searchText.trim().length > 0 && hits.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/70 p-3 text-sm text-gray-400">
                  Keine Treffer gefunden.
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2"><Upload className="w-4 h-4 text-cyan-300" /> Gateway-Inbound simulieren</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-gray-400 md:col-span-2">
                <span>Ziel-Gateway</span>
                <select
                  value={demoConfig?.id ?? ""}
                  onChange={(event) => setDemoConfigId(event.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none"
                >
                  <option value="">Gateway auswählen</option>
                  {mergedConfigs.map((config) => (
                    <option key={config.id} value={config.id}>
                      {config.portal} · {config.name}{config.channelHint ? ` · ${config.channelHint}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-gray-400">
                <span>Nachrichtenmodus</span>
                <select value={inboundMode} onChange={(event) => setInboundMode(event.target.value as "text" | "voice" | "file")} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none">
                  <option value="text">Text</option>
                  <option value="voice">Sprache</option>
                  <option value="file">Datei</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-gray-400">
                <span>Agent Reaction Emoji</span>
                <input value={inboundAgentEmoji} onChange={(event) => setInboundAgentEmoji(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
              </label>
            </div>

            {inboundMode === "text" && (
              <label className="space-y-1 text-xs text-gray-400 block">
                <span>Text</span>
                <textarea value={inboundText} onChange={(event) => setInboundText(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none min-h-24" />
              </label>
            )}

            {inboundMode === "voice" && (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs text-gray-400 block md:col-span-2">
                  <span>Sprach-Transkript</span>
                  <textarea value={inboundVoiceTranscript} onChange={(event) => setInboundVoiceTranscript(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none min-h-24" />
                </label>
                <label className="space-y-1 text-xs text-gray-400">
                  <span>Sprache</span>
                  <input value={inboundVoiceLanguage} onChange={(event) => setInboundVoiceLanguage(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1 text-xs text-gray-400">
                  <span>Reactions</span>
                  <input value={inboundReactions} onChange={(event) => setInboundReactions(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                </label>
              </div>
            )}

            {inboundMode === "file" && (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs text-gray-400">
                  <span>Dateiname</span>
                  <input value={inboundFileName} onChange={(event) => setInboundFileName(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1 text-xs text-gray-400">
                  <span>URL / Quelle</span>
                  <input value={inboundFileUrl} onChange={(event) => setInboundFileUrl(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1 text-xs text-gray-400 md:col-span-2">
                  <span>Dateiinhalt / Upload-Text</span>
                  <textarea value={inboundFileText} onChange={(event) => setInboundFileText(event.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none min-h-24" />
                </label>
                <div className="md:col-span-2 flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    className="hidden"
                    id="gateway-file-input"
                    onChange={async (event) => {
                      const file = event.target.files?.[0] ?? null;
                      setInboundFileInputName(file);
                      if (!file) {
                        setInboundFileBase64("");
                        setInboundFileMimeType("");
                        return;
                      }
                      const uploaded = await readFileAsBase64(file);
                      setInboundFileName(file.name);
                      setInboundFileBase64(uploaded.base64);
                      setInboundFileMimeType(uploaded.mimeType);
                      event.currentTarget.value = "";
                    }}
                  />
                  <label htmlFor="gateway-file-input" className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 hover:border-gray-500">
                    <Upload className="w-4 h-4" />
                    Datei auswählen
                  </label>
                  <span className="text-xs text-gray-500">{inboundFileInputName?.name ?? "Keine Datei gewählt"}</span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  inboundMutation.mutate({
                    portal: demoConfig?.portal ?? newPortal,
                    configId: demoConfig?.id,
                    externalConversationId: demoConfig?.channelHint?.trim() || `demo-${Date.now()}`,
                    message: inboundMode === "voice" ? inboundVoiceTranscript : inboundText,
                    text: inboundMode === "voice" ? inboundVoiceTranscript : inboundText,
                    mode: inboundMode,
                    voiceTranscript: inboundMode === "voice" ? inboundVoiceTranscript : undefined,
                    voiceLanguage: inboundMode === "voice" ? inboundVoiceLanguage : undefined,
                    attachments: buildInboundAttachments(),
                    reactions: parseReactions(inboundReactions),
                    agentEmoji: inboundAgentEmoji,
                    channelName: demoConfig?.channelHint ?? newChannelHint,
                    userName: demoConfig?.inboundLabel ?? demoConfig?.name ?? newName,
                  })
                }
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/20"
              >
                <Send className="w-4 h-4" />
                Demo-Inbound importieren
              </button>
              <button type="button" onClick={() => setInboundMode("text")} className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">
                <Copy className="w-4 h-4" />
                Text
              </button>
              <button type="button" onClick={() => setInboundMode("voice")} className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">
                <Mic className="w-4 h-4" />
                Voice
              </button>
              <button type="button" onClick={() => setInboundMode("file")} className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">
                <ImageIcon className="w-4 h-4" />
                Datei
              </button>
              <button type="button" onClick={() => setInboundReactions("😀,👍,🔥")} className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">
                <Smile className="w-4 h-4" />
                Reactions preset
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
