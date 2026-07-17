import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Bot, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";

interface LiveAgentItem {
  id: string;
  source: "chat_http" | "chat_ws" | "task_run" | "gateway_inbound";
  startedAt: string;
  conversationId?: number;
  taskId?: number;
  socketId?: string;
  label?: string;
}

function sourceLabel(source: LiveAgentItem["source"]): string {
  if (source === "chat_ws") return "Chat (WebSocket)";
  if (source === "chat_http") return "Chat (HTTP)";
  if (source === "gateway_inbound") return "Messaging Gateway";
  return "Task Run";
}

export function AgentsLiveView() {
  const navigate = useNavigate();

  const live = useQuery({
    queryKey: ["agents", "live"],
    queryFn: () => api.agents.live(),
    refetchInterval: 1500,
  });

  const runningCount = live.data?.runningCount ?? 0;
  const agents = (live.data?.agents ?? []) as LiveAgentItem[];

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
