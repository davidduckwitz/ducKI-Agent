import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, ScrollText } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface LogEntry {
  id: number;
  level: string;
  message: string;
  context?: string;
  timestamp: string;
}

interface ParsedLogContext {
  path?: string;
  source?: string;
  type?: string;
  emoji?: string;
  phase?: string;
  portal?: string;
  configId?: string;
  conversationId?: number;
  externalConversationId?: string;
  channelName?: string;
  userName?: string;
  error?: string;
}

const levelColor: Record<string, string> = {
  error: "text-red-400 bg-red-400/10",
  warn: "text-yellow-400 bg-yellow-400/10",
  info: "text-blue-400 bg-blue-400/10",
  debug: "text-gray-400 bg-gray-400/10",
};

const tagColor: Record<string, string> = {
  gateway: "text-cyan-300 bg-cyan-400/10 border-cyan-400/20",
  inbound: "text-emerald-300 bg-emerald-400/10 border-emerald-400/20",
  outbound: "text-violet-300 bg-violet-400/10 border-violet-400/20",
  reaction: "text-amber-300 bg-amber-400/10 border-amber-400/20",
  error: "text-red-300 bg-red-400/10 border-red-400/20",
};

function parseLogContext(context?: string): ParsedLogContext | undefined {
  if (!context) return undefined;
  try {
    return JSON.parse(context) as ParsedLogContext;
  } catch {
    return undefined;
  }
}

export function LogViewer() {
  const { t } = useI18n();
  const [level, setLevel] = useState("");
  const [limit, setLimit] = useState(100);
  const [showViewerRequests, setShowViewerRequests] = useState(false);

  const { data: logs = [], refetch } = useQuery({
    queryKey: ["logs", level, limit],
    queryFn: () => api.logs.list(level || undefined, limit) as Promise<LogEntry[]>,
    refetchInterval: 5000,
  });

  const allLogs = logs as LogEntry[];
  const viewerRequestLogs = allLogs.filter((log) => {
    if (!log.message.includes("/api/logs")) return false;
    if (!log.context) return true;
    try {
      const parsed = JSON.parse(log.context) as { path?: string };
      return typeof parsed.path === "string" && parsed.path.startsWith("/api/logs");
    } catch {
      return log.message.includes("/api/logs");
    }
  });
  const mainLogs = allLogs.filter((log) => !viewerRequestLogs.includes(log));

  const renderGatewayTags = (context?: ParsedLogContext) => {
    if (!context || context.source !== "gateway") return null;

    const isReaction = context.type === "reaction_set" || context.type === "reaction_error" || context.type === "reaction_skipped";
    const direction = context.type === "outbound_reply" || context.type === "outbound_error" ? "outbound" : isReaction ? "reaction" : "inbound";
    const reactionStatusLabel =
      context.type === "reaction_set"
        ? "Reaction OK"
        : context.type === "reaction_error"
          ? "Reaction Error"
          : context.type === "reaction_skipped"
            ? "Reaction Skipped"
            : undefined;
    const labels = [
      "Gateway",
      context.portal ? context.portal.charAt(0).toUpperCase() + context.portal.slice(1) : undefined,
      direction === "outbound" ? "Ausgang" : direction === "reaction" ? "Reaction" : "Eingang",
      reactionStatusLabel,
      context.emoji ? `Emoji ${context.emoji}` : undefined,
      context.phase ? `Phase ${context.phase}` : undefined,
      context.type,
    ].filter((value): value is string => Boolean(value));

    const colorKey =
      direction === "outbound" && context.type === "outbound_error"
        ? "error"
        : direction === "reaction" && context.type === "reaction_error"
          ? "error"
          : direction;

    return (
      <span className="flex flex-wrap gap-1 shrink-0">
        {labels.map((label) => (
          <span
            key={label}
            className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${tagColor[colorKey] ?? tagColor.gateway}`}
          >
            {label}
          </span>
        ))}
      </span>
    );
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">{t("logsPage.title")}</h1>
        <select
          className="input"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">{t("logsPage.allLevels")}</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <select
          className="input"
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value))}
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={500}>500</option>
        </select>
        <button onClick={() => refetch()} className="btn-secondary">
          {t("logsPage.refresh")}
        </button>
        <button onClick={() => setShowViewerRequests((s) => !s)} className="btn-secondary flex items-center gap-2">
          {showViewerRequests ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          /api/logs {t("logsPage.viewerRequests")} ({viewerRequestLogs.length})
        </button>
      </div>

      <div className="space-y-1 font-mono text-xs">
        {mainLogs.map((log) => {
          const parsedContext = parseLogContext(log.context);
          return (
            <div key={log.id} className={`px-3 py-2 rounded-lg flex gap-3 flex-wrap ${levelColor[log.level] ?? levelColor.info}`}>
              <span className="shrink-0 text-gray-500">
                {new Date(log.timestamp).toLocaleTimeString("de-DE")}
              </span>
              <span className="uppercase font-bold shrink-0 w-10">{log.level}</span>
              {renderGatewayTags(parsedContext)}
              <span className="break-words">{log.message}</span>
              {parsedContext?.error && (
                <span className="text-red-300 break-words">{t("logsPage.errorLabel")}: {parsedContext.error}</span>
              )}
              {log.context && !parsedContext?.error && (
                <span className="text-gray-500 truncate max-w-full">{log.context}</span>
              )}
            </div>
          );
        })}
        {mainLogs.length === 0 && (
          <div className="text-center text-gray-500 py-12">
            <ScrollText className="w-10 h-10 mx-auto mb-3 text-gray-700" />
            <p>{t("logsPage.noLogs")}</p>
          </div>
        )}
      </div>

      {showViewerRequests && viewerRequestLogs.length > 0 && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-200">LogViewer-Eigenanfragen (/api/logs)</h2>
            <span className="text-xs text-gray-500">{viewerRequestLogs.length} {t("logsPage.entries")}</span>
          </div>
          <div className="space-y-1 font-mono text-xs">
            {viewerRequestLogs.map((log) => (
              <div key={log.id} className="px-3 py-2 rounded-lg flex gap-3 bg-gray-900 border border-gray-800 text-gray-300">
                <span className="shrink-0 text-gray-500">
                  {new Date(log.timestamp).toLocaleTimeString("de-DE")}
                </span>
                <span className="uppercase font-bold shrink-0 w-10">{log.level}</span>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
