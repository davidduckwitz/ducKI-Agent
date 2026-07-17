import { Outlet, NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  CheckSquare,
  Wrench,
  BookOpen,
  Share2,
  Brain,
  ScrollText,
  Settings,
  Bot,
  Send,
  Wifi,
  WifiOff,
  GitBranch,
  Activity,
  CalendarClock,
  RefreshCw,
  Download,
  X,
  PlugZap,
} from "lucide-react";
import { useAppStore } from "../../lib/store";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

export function Layout() {
  const { t, language, setLanguage, languages } = useI18n();
  const qc = useQueryClient();
  const { initSocket, disconnectSocket, connected, agentStatus, globalRunningAgents } = useAppStore();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const liveAgents = useQuery({
    queryKey: ["agents", "live", "sidebar"],
    queryFn: () => api.agents.live(),
    refetchInterval: 1500,
  });
  const runningCount = liveAgents.data?.runningCount ?? globalRunningAgents;
  const discordGateway = liveAgents.data?.gateway?.discord;
  const discordGatewayActive = Boolean(discordGateway?.active);

  const updateStatus = useQuery({
    queryKey: ["updates", "status"],
    queryFn: () => api.updates.status(),
    refetchInterval: (query) => query.state.data?.updating ? 1000 : 5000,
  });

  const checkUpdates = useMutation({
    mutationFn: () => api.updates.check(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["updates", "status"] });
    },
  });

  const startUpdate = useMutation({
    mutationFn: () => api.updates.start(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["updates", "status"] });
    },
  });

  const updateAvailable = Boolean(updateStatus.data?.updateAvailable);
  const updating = Boolean(updateStatus.data?.updating);
  const checking = Boolean(updateStatus.data?.checking);
  const currentCommitShort = updateStatus.data?.currentCommit?.slice(0, 8) ?? "-";
  const remoteCommitShort = updateStatus.data?.remoteCommit?.slice(0, 8) ?? "-";
  const updateError = updateStatus.data?.lastUpdateError ?? updateStatus.data?.lastCheckError;

  const navItems = [
    { to: "/dashboard", icon: LayoutDashboard, label: t("nav.dashboard") },
    { to: "/chat", icon: MessageSquare, label: t("nav.chat") },
    { to: "/projects", icon: FolderOpen, label: t("nav.projects") },
    { to: "/tasks", icon: CheckSquare, label: t("nav.tasks") },
    { to: "/cronjobs", icon: CalendarClock, label: t("nav.cronjobs") },
    { to: "/mcp", icon: PlugZap, label: t("nav.mcp") },
    { to: "/tools", icon: Wrench, label: t("nav.tools") },
    { to: "/skills", icon: BookOpen, label: t("nav.skills") },
    { to: "/shared", icon: Share2, label: t("nav.shared") },
    { to: "/memory", icon: Brain, label: t("nav.memory") },
    { to: "/gateway", icon: Send, label: t("nav.gateway") },
    { to: "/workflow", icon: GitBranch, label: t("nav.workflow") },
    { to: "/logs", icon: ScrollText, label: t("nav.logs") },
    { to: "/settings", icon: Settings, label: t("nav.settings") },
  ];

  useEffect(() => {
    initSocket();
    return () => disconnectSocket();
  }, []);

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-400" />
            <span className="font-bold text-lg">DucKI</span>
          </div>
          <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
            {connected ? (
              <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">{t("layout.connected")}</span></>
            ) : (
              <><WifiOff className="w-3 h-3 text-red-400" /><span className="text-red-400">{t("layout.disconnected")}</span></>
            )}
            <span className="ml-2 capitalize">{agentStatus}</span>
          </div>

          <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/80 p-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">{t("language.title")}</div>
            <div className="flex items-center gap-2">
              {languages.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  onClick={() => setLanguage(entry.code)}
                  className={`px-2 py-1 rounded-md text-xs border transition ${language === entry.code ? "border-blue-500 bg-blue-600/20 text-blue-200" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}
                  title={entry.label}
                >
                  <img src={entry.flagSrc} alt={entry.label} className="inline-block w-4 h-3 mr-1 rounded-[2px] align-middle" />
                  {entry.code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-2 border-t border-gray-800">
          <NavLink
            to="/agents"
            className={({ isActive }) =>
              `block rounded-lg border px-3 py-2 transition ${
                isActive
                  ? "border-emerald-500/60 bg-emerald-500/20"
                  : "border-gray-700 bg-gray-800/70 hover:border-gray-600"
              }`
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-300">{t("nav.agents")}</span>
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Activity className="w-3.5 h-3.5" />
                {runningCount}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-gray-400">{t("layout.gateway")}</span>
              <span className={`inline-flex items-center gap-1 ${discordGatewayActive ? "text-green-300" : "text-red-300"}`}>
                <span className={`h-2 w-2 rounded-full ${discordGatewayActive ? "bg-green-400" : "bg-red-400"}`} />
                {discordGatewayActive ? t("common.active") : t("common.inactive")}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">{t("layout.clickForLiveChats")}</p>
          </NavLink>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-7">
        <Outlet />
      </main>

      <div className="fixed bottom-0 left-56 right-0 h-7 bg-gray-900/95 border-t border-gray-800 text-[11px] text-gray-300 flex items-center justify-between px-3 z-40">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate">Update: {updateAvailable ? t("layout.updateAvailable") : t("layout.updateCurrent")}</span>
          <span className="text-gray-500">{currentCommitShort}{" -> "}{remoteCommitShort}</span>
          {checking && <span className="text-blue-300">{t("layout.checking")}</span>}
          {updating && <span className="text-amber-300">{t("layout.updating")}</span>}
          {updateError && <span className="text-red-300 truncate max-w-[42rem]">{updateError}</span>}
        </div>
        <button
          onClick={() => setUpdateModalOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-700 hover:border-gray-500 hover:bg-gray-800"
        >
          <Download className="w-3 h-3" />
          {t("layout.updateButton")}
        </button>
      </div>

      {updateModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-3 md:p-6">
          <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold">{t("layout.repositoryUpdate")}</h3>
              <button
                onClick={() => setUpdateModalOpen(false)}
                className="p-1 rounded hover:bg-gray-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 space-y-3 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-gray-800 p-2 bg-gray-950/60">
                  <div className="text-gray-400">{t("layout.repo")}</div>
                  <div className="text-gray-200 break-all">{updateStatus.data?.repoUrl ?? "-"}</div>
                </div>
                <div className="rounded border border-gray-800 p-2 bg-gray-950/60">
                  <div className="text-gray-400">{t("layout.branch")}</div>
                  <div className="text-gray-200">{updateStatus.data?.branch ?? "-"}</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-2 py-0.5 rounded border ${updateAvailable ? "border-amber-500/50 text-amber-300" : "border-green-500/50 text-green-300"}`}>
                  {updateAvailable ? t("layout.newCommitAvailable") : t("layout.upToDate")}
                </span>
                <span className="text-gray-400">{t("layout.local")}: {currentCommitShort}</span>
                <span className="text-gray-400">{t("layout.remote")}: {remoteCommitShort}</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => checkUpdates.mutate()}
                  disabled={checking || updating || checkUpdates.isPending}
                  className="btn-secondary inline-flex items-center gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${checking ? "animate-spin" : ""}`} />
                  {t("layout.checkNow")}
                </button>
                <button
                  onClick={() => startUpdate.mutate()}
                  disabled={updating || startUpdate.isPending || checking || !updateAvailable}
                  className="btn-primary inline-flex items-center gap-2"
                >
                  <Download className={`w-4 h-4 ${updating ? "animate-bounce" : ""}`} />
                  {t("layout.startUpdate")}
                </button>
              </div>

              <div className="rounded border border-gray-800 bg-black/40 p-2">
                <div className="text-xs text-gray-400 mb-1">{t("layout.liveOutput")}</div>
                <pre className="text-[11px] leading-4 text-gray-200 max-h-44 overflow-auto whitespace-pre-wrap">
{(updateStatus.data?.lastUpdateOutput?.length ?? 0) > 0
  ? updateStatus.data?.lastUpdateOutput?.join("\n")
  : t("layout.noUpdateOutput")}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
