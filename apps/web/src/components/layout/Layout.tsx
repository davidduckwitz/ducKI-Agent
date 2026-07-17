import { Outlet, NavLink } from "react-router-dom";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import { useAppStore } from "../../lib/store";
import { api } from "../../lib/api";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/projects", icon: FolderOpen, label: "Projekte" },
  { to: "/tasks", icon: CheckSquare, label: "Aufgaben" },
  { to: "/tools", icon: Wrench, label: "Tools" },
  { to: "/skills", icon: BookOpen, label: "Skills" },
  { to: "/shared", icon: Share2, label: "Shared" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/gateway", icon: Send, label: "Gateway" },
  { to: "/workflow", icon: GitBranch, label: "Workflow" },
  { to: "/logs", icon: ScrollText, label: "Logs" },
  { to: "/settings", icon: Settings, label: "Einstellungen" },
];

export function Layout() {
  const { initSocket, disconnectSocket, connected, agentStatus, globalRunningAgents } = useAppStore();
  const liveAgents = useQuery({
    queryKey: ["agents", "live", "sidebar"],
    queryFn: () => api.agents.live(),
    refetchInterval: 1500,
  });
  const runningCount = liveAgents.data?.runningCount ?? globalRunningAgents;
  const discordGateway = liveAgents.data?.gateway?.discord;
  const discordGatewayActive = Boolean(discordGateway?.active);

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
              <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">Verbunden</span></>
            ) : (
              <><WifiOff className="w-3 h-3 text-red-400" /><span className="text-red-400">Getrennt</span></>
            )}
            <span className="ml-2 capitalize">{agentStatus}</span>
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
              <span className="text-xs text-gray-300">Live Agenten</span>
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Activity className="w-3.5 h-3.5" />
                {runningCount}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-gray-400">Discord Gateway</span>
              <span className={`inline-flex items-center gap-1 ${discordGatewayActive ? "text-green-300" : "text-red-300"}`}>
                <span className={`h-2 w-2 rounded-full ${discordGatewayActive ? "bg-green-400" : "bg-red-400"}`} />
                {discordGatewayActive ? "Aktiv" : "Inaktiv"}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Klick fuer aktive Agenten-Chats</p>
          </NavLink>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
