import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap, RefreshCw, Plus, Trash2, Save, Play, Square } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface MCPServerRuntime extends MCPServerConfig {
  connected: boolean;
  reconnectAttempts: number;
  tools: number;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

interface StreamChunk {
  at: string;
  text: string;
}

function validateServerInput(
  server: MCPServerConfig,
  existing: MCPServerConfig[],
  currentId?: string
): string | null {
  const id = server.id.trim();
  const name = server.name.trim();
  const url = server.url.trim();

  if (!id || !name || !url) {
    return "mcpPage.validationMissing";
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return "mcpPage.validationIdFormat";
  }

  const idCollision = existing.some((entry) => entry.id === id && entry.id !== currentId);
  if (idCollision) {
    return "mcpPage.validationDuplicateId";
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "mcpPage.validationBadUrl";
    }
  } catch {
    return "mcpPage.validationBadUrl";
  }

  return null;
}

export function McpManager() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [newServer, setNewServer] = useState<MCPServerConfig>({ id: "", name: "", url: "", enabled: true });
  const [callToolName, setCallToolName] = useState("");
  const [callServerId, setCallServerId] = useState("");
  const [callInput, setCallInput] = useState("{}");
  const [callResult, setCallResult] = useState<string>("");
  const [serverError, setServerError] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string>("mcpPage.streamIdle");
  const [streamChunks, setStreamChunks] = useState<StreamChunk[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);

  const serversQuery = useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: () => api.mcp.servers(),
    refetchInterval: 5000,
  });

  const toolsQuery = useQuery({
    queryKey: ["mcp", "tools"],
    queryFn: () => api.mcp.tools(),
    refetchInterval: 5000,
  });

  const saveServers = useMutation({
    mutationFn: (servers: MCPServerConfig[]) => api.mcp.saveServers(servers),
    onSuccess: () => {
      setServerError("");
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
      qc.invalidateQueries({ queryKey: ["mcp", "tools"] });
    },
    onError: (error) => {
      setServerError(error instanceof Error ? error.message : String(error));
    },
  });

  const reloadServers = useMutation({
    mutationFn: () => api.mcp.reloadServers(),
    onSuccess: () => {
      setServerError("");
      qc.invalidateQueries({ queryKey: ["mcp", "servers"] });
      qc.invalidateQueries({ queryKey: ["mcp", "tools"] });
    },
    onError: (error) => {
      setServerError(error instanceof Error ? error.message : String(error));
    },
  });

  const callTool = useMutation({
    mutationFn: (payload: { toolName: string; input: Record<string, unknown>; serverId?: string }) =>
      api.mcp.callTool(payload),
    onSuccess: (result) => {
      setCallResult(JSON.stringify(result, null, 2));
    },
    onError: (error) => {
      setCallResult(String(error));
    },
  });

  const configured = (serversQuery.data?.configured ?? []) as MCPServerConfig[];
  const runtime = (serversQuery.data?.runtime ?? []) as MCPServerRuntime[];
  const mergedServers = useMemo(() => {
    const byId = new Map(runtime.map((item) => [item.id, item]));
    return configured.map((item) => ({ ...item, ...(byId.get(item.id) ?? {}) }));
  }, [configured, runtime]);

  const saveCurrent = () => {
    for (const server of mergedServers) {
      const validation = validateServerInput(server, mergedServers, server.id);
      if (validation) {
        setServerError(t(validation));
        return;
      }
    }
    saveServers.mutate(mergedServers);
  };

  const addServer = () => {
    const validation = validateServerInput(newServer, mergedServers);
    if (validation) {
      setServerError(t(validation));
      return;
    }
    setServerError("");
    saveServers.mutate([...mergedServers, { ...newServer, id: newServer.id.trim(), name: newServer.name.trim(), url: newServer.url.trim() }]);
    setNewServer({ id: "", name: "", url: "", enabled: true });
  };

  const toggleEnabled = (id: string) => {
    saveServers.mutate(
      mergedServers.map((server) => (server.id === id ? { ...server, enabled: !server.enabled } : server))
    );
  };

  const removeServer = (id: string) => {
    saveServers.mutate(mergedServers.filter((server) => server.id !== id));
  };

  const runCall = () => {
    if (!callToolName.trim()) {
      setCallResult(t("mcpPage.validationToolName"));
      return;
    }
    try {
      const parsed = JSON.parse(callInput || "{}");
      callTool.mutate({
        toolName: callToolName.trim(),
        input: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {},
        serverId: callServerId.trim() || undefined,
      });
    } catch {
      setCallResult("Invalid JSON input");
    }
  };

  const runStream = async () => {
    if (!callToolName.trim()) {
      setCallResult(t("mcpPage.validationToolName"));
      return;
    }

    if (streaming) {
      return;
    }

    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    setStreaming(true);
    setStreamStatus("mcpPage.streamRunning");
    setStreamChunks([]);

    try {
      const parsed = JSON.parse(callInput || "{}");
      const response = await fetch("/api/mcp/tools/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          toolName: callToolName.trim(),
          serverId: callServerId.trim() || undefined,
          input: parsed && typeof parsed === "object" ? parsed : {},
        }),
      });

      if (!response.ok || !response.body) {
        setCallResult(`Stream failed (HTTP ${response.status})`);
        setStreamStatus("mcpPage.streamFailed");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      setCallResult("");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n").map((line) => line.trim());
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const chunk = line.slice(5).trim();
            setCallResult((prev) => (prev ? `${prev}\n${chunk}` : chunk));
            setStreamChunks((prev) => [
              ...prev,
              { at: new Date().toISOString(), text: chunk },
            ]);
          }
        }
      }
      setStreamStatus("mcpPage.streamDone");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStreamStatus("mcpPage.streamStopped");
        return;
      }
      setStreamStatus("mcpPage.streamFailed");
      setCallResult(error instanceof Error ? error.message : String(error));
    } finally {
      streamAbortRef.current = null;
      setStreaming(false);
    }
  };

  const stopStream = () => {
    streamAbortRef.current?.abort();
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PlugZap className="w-6 h-6 text-cyan-400" />
            {t("mcpPage.title")}
          </h1>
          <p className="text-sm text-gray-400">{t("mcpPage.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary inline-flex items-center gap-2" onClick={() => reloadServers.mutate()}>
            <RefreshCw className="w-4 h-4" />
            {t("mcpPage.reload")}
          </button>
          <button className="btn-primary inline-flex items-center gap-2" onClick={saveCurrent}>
            <Save className="w-4 h-4" />
            {t("common.save")}
          </button>
        </div>
      </div>

      <section className="card space-y-3">
        <h2 className="font-semibold">{t("mcpPage.servers")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input className="input" placeholder="id" value={newServer.id} onChange={(e) => setNewServer((s) => ({ ...s, id: e.target.value }))} />
          <input className="input" placeholder={t("mcpPage.name")} value={newServer.name} onChange={(e) => setNewServer((s) => ({ ...s, name: e.target.value }))} />
          <input className="input md:col-span-2" placeholder="https://mcp.example.com" value={newServer.url} onChange={(e) => setNewServer((s) => ({ ...s, url: e.target.value }))} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-300 inline-flex items-center gap-2">
            <input type="checkbox" checked={newServer.enabled} onChange={(e) => setNewServer((s) => ({ ...s, enabled: e.target.checked }))} />
            {t("common.enabled")}
          </label>
          <button className="btn-secondary inline-flex items-center gap-2" onClick={addServer}>
            <Plus className="w-4 h-4" />
            {t("common.create")}
          </button>
        </div>
        {serverError && <p className="text-xs text-red-300">{serverError}</p>}

        <div className="space-y-2">
          {mergedServers.length === 0 && <p className="text-sm text-gray-500">{t("mcpPage.noServers")}</p>}
          {mergedServers.map((server) => (
            <div key={server.id} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{server.name} <span className="text-xs text-gray-500">({server.id})</span></p>
                <p className="text-xs text-gray-400 break-all">{server.url}</p>
                <p className="text-xs text-gray-500">
                  {server.connected ? t("layout.connected") : t("layout.disconnected")} | tools: {server.tools ?? 0} | retries: {server.reconnectAttempts ?? 0}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn-secondary text-xs" onClick={() => toggleEnabled(server.id)}>
                  {server.enabled ? t("common.disable") : t("common.enable")}
                </button>
                <button className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600/20 text-red-300 hover:bg-red-600/30 text-xs" onClick={() => removeServer(server.id)}>
                  <Trash2 className="w-3.5 h-3.5" /> {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">{t("mcpPage.tools")}</h2>
        <div className="text-xs text-gray-500">{(toolsQuery.data ?? []).length} {t("mcpPage.toolsDetected")}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(toolsQuery.data ?? []).map((tool: MCPTool) => (
            <div key={`${tool.serverId}:${tool.name}`} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3">
              <p className="font-mono text-sm text-gray-200">{tool.name}</p>
              <p className="text-xs text-gray-400">{tool.description || "-"}</p>
              <p className="text-[11px] text-gray-500 mt-1">server: {tool.serverId}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">{t("mcpPage.callTool")}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input className="input" placeholder={t("mcpPage.toolName")} value={callToolName} onChange={(e) => setCallToolName(e.target.value)} />
          <input className="input" placeholder={t("mcpPage.optionalServerId")} value={callServerId} onChange={(e) => setCallServerId(e.target.value)} />
          <div className="flex items-center gap-2">
            <button className="btn-primary inline-flex items-center justify-center gap-2 flex-1" onClick={runCall}>
              <Play className="w-4 h-4" /> {t("common.runNow")}
            </button>
            <button className="btn-secondary inline-flex items-center justify-center gap-2 flex-1" onClick={runStream}>
              {t("mcpPage.runStream")}
            </button>
            <button className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-red-600/20 text-red-300 hover:bg-red-600/30 disabled:opacity-50" onClick={stopStream} disabled={!streaming}>
              <Square className="w-4 h-4" /> {t("common.stop")}
            </button>
          </div>
        </div>
        <textarea className="input w-full min-h-[120px] font-mono text-xs" value={callInput} onChange={(e) => setCallInput(e.target.value)} />
        <div className="text-xs text-gray-400">{t("mcpPage.streamStatus")}: {t(streamStatus)}</div>
        <pre className="rounded border border-gray-800 bg-black/40 p-2 text-[11px] text-gray-200 max-h-60 overflow-auto whitespace-pre-wrap">{callResult || t("mcpPage.callResultPlaceholder")}</pre>
        <div className="rounded border border-gray-800 bg-black/30 p-2 max-h-52 overflow-auto">
          <p className="text-xs text-gray-400 mb-2">{t("mcpPage.streamChunks")}: {streamChunks.length}</p>
          <div className="space-y-1">
            {streamChunks.length === 0 && <p className="text-[11px] text-gray-500">-</p>}
            {streamChunks.map((chunk, idx) => (
              <div key={`${chunk.at}-${idx}`} className="text-[11px] text-gray-300 font-mono">
                <span className="text-gray-500">[{new Date(chunk.at).toLocaleTimeString()}]</span> {chunk.text}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
