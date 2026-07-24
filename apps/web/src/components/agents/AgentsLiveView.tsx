import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, Bot, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useSocket } from "../../lib/useSocket";

interface LiveAgentItem {
  id: string;
  source: "chat_http" | "chat_ws" | "task_run" | "workflow_run" | "gateway_inbound";
  startedAt: string;
  conversationId?: number;
  taskId?: number;
  socketId?: string;
  label?: string;
}

function sourceLabel(source: LiveAgentItem["source"]): string {
  if (source === "chat_ws") return "Chat (WebSocket)";
  if (source === "chat_http") return "Chat (HTTP)";
  if (source === "workflow_run") return "Workflow";
  if (source === "gateway_inbound") return "Messaging Gateway";
  return "Task Run";
}

export function AgentsLiveView() {
  const navigate = useNavigate();
  const socket = useSocket();
  const [wsSnapshot, setWsSnapshot] = useState<{ runningCount: number; agents: LiveAgentItem[] } | null>(null);

  useEffect(() => {
    if (!socket) return;

    socket.on("agent:metrics", (snapshot: { runningCount: number; agents: LiveAgentItem[] }) => {
      setWsSnapshot(snapshot);
    });

    return () => {
      socket.off("agent:metrics");
    };
  }, [socket]);

  const live = useQuery({
    queryKey: ["agents", "live"],
    queryFn: () => api.agents.live(),
    refetchInterval: 5000,
  });

  const snapshot = wsSnapshot ?? live.data;
  const runningCount = snapshot?.runningCount ?? 0;
  const agents = (snapshot?.agents ?? []) as LiveAgentItem[];
  const summary = live.data?.summary;
  const snapshotAt = live.data?.snapshotAt;
  const sourceMap = live.data?.sourceMap ?? {
    chat_http: agents.filter((entry) => entry.source === "chat_http").length,
    chat_ws: agents.filter((entry) => entry.source === "chat_ws").length,
    task_run: agents.filter((entry) => entry.source === "task_run").length,
    workflow_run: agents.filter((entry) => entry.source === "workflow_run").length,
    gateway_inbound: agents.filter((entry) => entry.source === "gateway_inbound").length,
  };
  const sourceTotal = sourceMap.chat_http + sourceMap.chat_ws + sourceMap.task_run + sourceMap.workflow_run + sourceMap.gateway_inbound;
  const mismatch = runningCount !== sourceTotal;
  const mismatchDelta = runningCount - sourceTotal;
  const chatCount = summary?.chats ?? agents.filter((entry) => entry.source === "chat_http" || entry.source === "chat_ws").length;
  const taskCount = summary?.tasks ?? agents.filter((entry) => entry.source === "task_run").length;
  const workflowCount = summary?.workflows ?? agents.filter((entry) => entry.source === "workflow_run").length;
  const gatewayCount = summary?.gateway ?? agents.filter((entry) => entry.source === "gateway_inbound").length;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Live Agenten</h1>
          <p className="text-sm text-gray-400">Aktive Agentenlaeufe mit direktem Sprung in den zugehoerigen Chat.</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          <Activity className="w-4 h-4" />
          Laufend: <span className="font-semibold">{runningCount}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card">
          <p className="text-xs text-gray-400">Agents gesamt</p>
          <p className="text-xl font-semibold text-emerald-200">{runningCount}</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400">Chats aktiv</p>
          <p className="text-xl font-semibold text-blue-200">{chatCount}</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400">Tasks aktiv</p>
          <p className="text-xl font-semibold text-cyan-200">{taskCount}</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400">Workflows aktiv</p>
          <p className="text-xl font-semibold text-violet-200">{workflowCount}</p>
          {gatewayCount > 0 && <p className="text-[11px] text-gray-500 mt-1">Gateway: {gatewayCount}</p>}
        </div>
      </div>

      <div className={`rounded-lg border px-3 py-2 text-[11px] ${mismatch ? "border-rose-500/60 bg-rose-950/20 text-rose-200" : "border-gray-800 bg-gray-950/70 text-gray-400"}`}>
        <p>
          Debug Snapshot: {snapshotAt ? new Date(snapshotAt).toLocaleTimeString() : "-"} | Sources: chat_http={sourceMap.chat_http}, chat_ws={sourceMap.chat_ws}, task_run={sourceMap.task_run}, workflow_run={sourceMap.workflow_run}, gateway_inbound={sourceMap.gateway_inbound}
        </p>
        <p className={mismatch ? "text-rose-200" : "text-gray-500"}>
          Check: runningCount={runningCount} vs sourceTotal={sourceTotal}
          {mismatch ? ` (delta=${mismatchDelta >= 0 ? `+${mismatchDelta}` : `${mismatchDelta}`})` : " (ok)"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((entry) => (
          <div key={entry.id} className="card space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-white">{entry.label ?? sourceLabel(entry.source)}</p>
                <p className="text-xs text-gray-500">{sourceLabel(entry.source)}</p>
              </div>
              <Bot className="w-4 h-4 text-blue-300" />
            </div>

            <div className="text-xs text-gray-400 space-y-1">
              <p>Start: {new Date(entry.startedAt).toLocaleString()}</p>
              {entry.conversationId && <p>Chat-ID: #{entry.conversationId}</p>}
              {entry.taskId && <p>Task-ID: #{entry.taskId}</p>}
            </div>

            <div className="pt-1">
              {entry.conversationId ? (
                <button
                  onClick={() => navigate(`/chat?conversationId=${entry.conversationId}`)}
                  className="btn-primary text-sm inline-flex items-center gap-2"
                >
                  <MessageSquare className="w-4 h-4" />
                  Zum Chat wechseln
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <span className="text-xs text-gray-500">Kein Chat zugeordnet</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {agents.length === 0 && (
        <div className="card text-sm text-gray-400">
          Derzeit laufen keine Agenten.
        </div>
      )}
    </div>
  );
}
