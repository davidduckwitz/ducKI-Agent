import { useQuery } from "@tanstack/react-query";
import { FolderOpen, CheckSquare, Wrench, Bot, Activity, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";

export function Dashboard() {
  const { t } = useI18n();
  const { agentStatus, connected, setSetupModalOpen } = useAppStore();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list() });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks.list() });
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api.tools.list() });

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
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">
            {t("dashboard.subtitle")}
          </p>
        </div>
        <button className="btn-primary inline-flex items-center gap-2" onClick={() => setSetupModalOpen(true)}>
          <Sparkles className="w-4 h-4" />
          Setup Assistent
        </button>
      </div>

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

      {/* Recent Tasks */}
      {(tasks.data as Array<{ id: number; title: string; status: string; priority: string }> | undefined)?.slice(0, 5).map((task) => (
        <div key={task.id} className="card">
          <div className="flex items-center justify-between">
            <span className="text-sm">{task.title}</span>
            <div className="flex gap-2">
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
  );
}
