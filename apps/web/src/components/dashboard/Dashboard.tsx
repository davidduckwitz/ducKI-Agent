import { useQuery } from "@tanstack/react-query";
import { FolderOpen, CheckSquare, Wrench, Bot, Activity, Sparkles, MessageCircle, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";
import { PluginWidgets } from "../plugins/PluginWidgets";

interface ConversationItem {
  id: number;
  name: string;
  projectId?: number;
  createdAt: string;
  updatedAt: string;
}

export function Dashboard() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { agentStatus, connected, setSetupModalOpen, setConversationId, messages, isLoading } = useAppStore();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list() });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks.list() });
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api.tools.list() });
  const conversations = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () =>
      api.chat.listConversationsPage({ limit: 3 }) as Promise<{
        items: ConversationItem[];
        hasMore: boolean;
      }>,
  });

  // Get last 5 messages for dashboard preview
  const recentMessages = messages.slice(-5);

  const stats = [
    {
      label: t("dashboard.projects"),
      value: (projects.data as unknown[])?.length ?? 0,
      icon: FolderOpen,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
    },
    {
      label: t("dashboard.tasks"),
      value: (tasks.data as unknown[])?.length ?? 0,
      icon: CheckSquare,
      color: "text-green-400",
      bg: "bg-green-400/10",
    },
    {
      label: t("dashboard.tools"),
      value: (tools.data as unknown[])?.length ?? 0,
      icon: Wrench,
      color: "text-purple-400",
      bg: "bg-purple-400/10",
    },
    {
      label: t("dashboard.agentStatus"),
      value: agentStatus,
      icon: Bot,
      color: "text-yellow-400",
      bg: "bg-yellow-400/10",
    },
  ];

  return (
    <div className="p-3 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            {t("dashboard.subtitle")}
          </p>
        </div>
        <button className="btn-primary inline-flex items-center gap-2" onClick={() => setSetupModalOpen(true)}>
          <Sparkles className="w-4 h-4" />
          {t("setupWizard.openButton")}
        </button>
      </div>

      {/* Plugin widgets (enabled plugins with a dashboard widget) */}
      <PluginWidgets placement="dashboard" />

      {/* Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="card">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${bg}`}>
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
              <div>
                <p className="text-xs text-gray-400">{label}</p>
                <p className="text-xl font-bold capitalize">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Connection Status */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold">{t("dashboard.systemStatus")}</h2>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">{t("dashboard.websocket")}</span>
            <span className={connected ? "text-green-400" : "text-red-400"}>
              {connected ? t("layout.connected") : t("layout.disconnected")}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">{t("dashboard.agent")}</span>
            <span className="capitalize text-white">{agentStatus}</span>
          </div>
        </div>
      </div>

      {/* Agent Control - Chat & Conversations Preview */}
      <div className="space-y-4">
        {/* Messages Preview */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-blue-400" />
              <h2 className="font-semibold">{t("dashboard.agentChat") || "Agent Chat"}</h2>
              <span className="text-xs text-gray-400 ml-1">({messages.length})</span>
            </div>
            <button
              onClick={() => navigate("/chat")}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-md transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t("common.goToChat") || "Go to Chat"}
            </button>
          </div>

          {/* Messages List */}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {recentMessages.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">
                {t("chat.noMessages") || "No messages yet. Start a conversation to see them here."}
              </p>
            ) : (
              recentMessages.map((msg, idx) => (
                <div
                  key={msg.id || idx}
                  className={`p-2 rounded-md text-sm ${
                    msg.role === "user"
                      ? "bg-blue-500/10 border border-blue-500/20"
                      : msg.role === "assistant"
                      ? "bg-purple-500/10 border border-purple-500/20"
                      : msg.role === "event"
                      ? "bg-gray-500/10 border border-gray-500/20 text-gray-300"
                      : "bg-gray-500/10 border border-gray-500/20"
                  }`}
                >
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className={`text-xs font-semibold ${
                      msg.role === "user" ? "text-blue-400" :
                      msg.role === "assistant" ? "text-purple-400" :
                      msg.role === "event" ? "text-gray-400" :
                      "text-gray-400"
                    }`}>
                      {msg.role === "event" ? `[${msg.eventType || "event"}]` : msg.role}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-gray-300 line-clamp-2">{msg.content}</p>
                </div>
              ))
            )}
            {isLoading && (
              <div className="p-2 text-sm text-gray-400 italic">
                {t("chat.loading") || "Loading..."}
              </div>
            )}
          </div>
        </div>

        {/* Recent Conversations */}
        <div className="card">
          <h2 className="font-semibold mb-3">{t("chat.chats") || "Chats"}</h2>
          <div className="space-y-2">
            {conversations.isLoading ? (
              <p className="text-sm text-gray-400 py-2 text-center">
                {t("chat.loading") || "Loading..."}
              </p>
            ) : (conversations.data?.items?.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-400 py-2 text-center">
                {t("chat.noSaved") || "No saved chats yet."}
              </p>
            ) : (
              conversations.data?.items.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    setConversationId(conv.id);
                    navigate("/chat");
                  }}
                  className="w-full text-left p-2.5 rounded-md bg-gray-500/10 hover:bg-gray-500/20 border border-gray-500/20 hover:border-gray-500/40 transition-all group"
                >
                  <p className="text-sm font-medium text-gray-200 group-hover:text-gray-100 line-clamp-1">
                    {conv.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {new Date(conv.updatedAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Recent Tasks */}
      <div>
        <h2 className="font-semibold mb-3 text-sm text-gray-300">{t("dashboard.recentTasks") || "Recent Tasks"}</h2>
        <div className="space-y-2">
          {(tasks.data as Array<{ id: number; title: string; status: string; priority: string }> | undefined)?.slice(0, 5).map((task) => (
            <div key={task.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-sm">{task.title}</span>
                <div className="flex shrink-0 gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    task.status === "completed" ? "bg-green-500/20 text-green-400" :
                    task.status === "running" ? "bg-blue-500/20 text-blue-400" :
                    task.status === "failed" ? "bg-red-500/20 text-red-400" :
                    "bg-gray-500/20 text-gray-400"
                  }`}>
                    {task.status}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    task.priority === "high" || task.priority === "critical"
                      ? "bg-red-500/20 text-red-400"
                      : "bg-gray-500/20 text-gray-400"
                  }`}>
                    {task.priority}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
