import { Outlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState, type ComponentType } from "react";
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
  Code2,
  Monitor,
  Sun,
  Moon,
  LayoutGrid,
} from "lucide-react";
import { useAppStore } from "../../lib/store";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { SetupWizardModal } from "../setup/SetupWizardModal";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_MODES, type ThemeMode } from "../../lib/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { CodingSidebarPanel } from "../coding/CodingSidebarPanel";

interface NavItem {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const THEME_MODE_ICONS: Record<ThemeMode, ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

function ThemeModeSwitcher() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const ActiveIcon = THEME_MODE_ICONS[mode];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("themeSettings.modeTitle")}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition"
        >
          <ActiveIcon className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_MODES.map((value) => {
          const Icon = THEME_MODE_ICONS[value];
          return (
            <DropdownMenuItem key={value} onClick={() => setMode(value)} className="gap-2">
              <Icon className="w-4 h-4" />
              {t(`themeSettings.mode.${value}`)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarModeSwitcher({ active, onSelect }: { active: "standard" | "coding"; onSelect: (mode: "standard" | "coding") => void }) {
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background/60 p-1">
      <button
        type="button"
        onClick={() => onSelect("standard")}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
          active === "standard" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
        }`}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        {t("layout.sidebarModeStandard")}
      </button>
      <button
        type="button"
        onClick={() => onSelect("coding")}
        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
          active === "coding" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
        }`}
      >
        <Code2 className="w-3.5 h-3.5" />
        {t("layout.sidebarModeCoding")}
      </button>
    </div>
  );
}

export function Layout() {
  const { t, language, setLanguage, languages } = useI18n();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const isCodingRoute = location.pathname.startsWith("/coding");
  const { initSocket, disconnectSocket, connected, agentStatus, globalRunningAgents, setupModalOpen, setSetupModalOpen } = useAppStore();
  const firstRunCheckDone = useRef(false);
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

  const settingsQuery = useQuery({
    queryKey: ["settings", "layout-nav"],
    queryFn: () => api.settings.list() as Promise<Array<{ key: string; value: string }>>,
    refetchInterval: 5000,
  });
  const codingEnabled = String(settingsQuery.data?.find((s) => s.key === "CODING_ENABLED")?.value ?? "false").trim().toLowerCase() === "true";

  useEffect(() => {
    if (firstRunCheckDone.current) return;
    if (!settingsQuery.data) return;
    const setupCompleted = String(settingsQuery.data.find((s) => s.key === "SETUP_COMPLETED")?.value ?? "false").trim().toLowerCase() === "true";
    if (!setupCompleted) {
      setSetupModalOpen(true);
    }
    firstRunCheckDone.current = true;
  }, [setSetupModalOpen, settingsQuery.data]);

  const navGroups: NavGroup[] = [
    {
      title: t("nav.groups.overview"),
      items: [
        { to: "/dashboard", icon: LayoutDashboard, label: t("nav.dashboard") },
        { to: "/chat", icon: MessageSquare, label: t("nav.chat") },
      ],
    },
    {
      title: t("nav.groups.workspace"),
      items: [
        { to: "/projects", icon: FolderOpen, label: t("nav.projects") },
        { to: "/tasks", icon: CheckSquare, label: t("nav.tasks") },
        { to: "/workflow", icon: GitBranch, label: t("nav.workflow") },
      ],
    },
    {
      title: t("nav.groups.shared"),
      items: [{ to: "/shared", icon: Share2, label: t("nav.shared") }],
    },
    {
      title: t("nav.groups.automation"),
      items: [
        { to: "/cronjobs", icon: CalendarClock, label: t("nav.cronjobs") },
        { to: "/gateway", icon: Send, label: t("nav.gateway") },
        { to: "/mcp", icon: PlugZap, label: t("nav.mcp") },
        { to: "/tools", icon: Wrench, label: t("nav.tools") },
        { to: "/skills", icon: BookOpen, label: t("nav.skills") },
      ],
    },
    {
      title: t("nav.groups.knowledge"),
      items: [{ to: "/memory", icon: Brain, label: t("nav.memory") }],
    },
    {
      title: t("nav.groups.system"),
      items: [
        { to: "/logs", icon: ScrollText, label: t("nav.logs") },
        { to: "/settings", icon: Settings, label: t("nav.settings") },
      ],
    },
  ];

  useEffect(() => {
    initSocket();
    return () => disconnectSocket();
  }, []);

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-card border-r border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="w-6 h-6 text-primary" />
              <span className="font-bold text-lg">DucKI</span>
            </div>
            <ThemeModeSwitcher />
          </div>
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            {connected ? (
              <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">{t("layout.connected")}</span></>
            ) : (
              <><WifiOff className="w-3 h-3 text-red-400" /><span className="text-red-400">{t("layout.disconnected")}</span></>
            )}
            <span className="ml-2 capitalize">{agentStatus}</span>
          </div>

          <div className="mt-3 rounded-lg border border-border bg-background/60 p-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{t("language.title")}</div>
            <div className="flex items-center gap-2">
              {languages.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  onClick={() => setLanguage(entry.code)}
                  className={`px-2 py-1 rounded-md text-xs border transition ${language === entry.code ? "border-primary bg-primary/20 text-primary" : "border-border text-muted-foreground hover:border-foreground/40"}`}
                  title={entry.label}
                >
                  <img src={entry.flagSrc} alt={entry.label} className="inline-block w-4 h-3 mr-1 rounded-[2px] align-middle" />
                  {entry.code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {codingEnabled && (
          <div className="px-2 pt-2">
            <SidebarModeSwitcher
              active={isCodingRoute ? "coding" : "standard"}
              onSelect={(mode) => navigate(mode === "coding" ? "/coding" : "/dashboard")}
            />
          </div>
        )}

        {isCodingRoute ? (
          <CodingSidebarPanel />
        ) : (
          <nav className="flex-1 p-2 space-y-3 overflow-y-auto">
            {navGroups.map((group) => (
              <div key={group.title}>
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {group.title}
                </div>
                <div className="space-y-0.5">
                  {group.items.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent"
                        }`
                      }
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        )}

        <div className="p-2 border-t border-border">
          <NavLink
            to="/agents"
            className={({ isActive }) =>
              `block rounded-lg border px-3 py-2 transition ${
                isActive
                  ? "border-emerald-500/60 bg-emerald-500/20"
                  : "border-border bg-accent/60 hover:border-foreground/30"
              }`
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t("nav.agents")}</span>
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                <Activity className="w-3.5 h-3.5" />
                {runningCount}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{t("layout.gateway")}</span>
              <span className={`inline-flex items-center gap-1 ${discordGatewayActive ? "text-green-300" : "text-red-300"}`}>
                <span className={`h-2 w-2 rounded-full ${discordGatewayActive ? "bg-green-400" : "bg-red-400"}`} />
                {discordGatewayActive ? t("common.active") : t("common.inactive")}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-1">{t("layout.clickForLiveChats")}</p>
          </NavLink>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-7">
        <Outlet />
      </main>

      <div className="fixed bottom-0 left-56 right-0 h-7 bg-card/95 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between px-3 z-40">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate">Update: {updateAvailable ? t("layout.updateAvailable") : t("layout.updateCurrent")}</span>
          <span className="text-muted-foreground/70">{currentCommitShort}{" -> "}{remoteCommitShort}</span>
          {checking && <span className="text-blue-300">{t("layout.checking")}</span>}
          {updating && <span className="text-amber-300">{t("layout.updating")}</span>}
          {updateError && <span className="text-red-300 truncate max-w-[42rem]">{updateError}</span>}
        </div>
        <button
          onClick={() => setUpdateModalOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:border-foreground/40 hover:bg-accent"
        >
          <Download className="w-3 h-3" />
          {t("layout.updateButton")}
        </button>
      </div>

      {updateModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-3 md:p-6">
          <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">{t("layout.repositoryUpdate")}</h3>
              <button
                onClick={() => setUpdateModalOpen(false)}
                className="p-1 rounded hover:bg-accent"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 space-y-3 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-border p-2 bg-background/60">
                  <div className="text-muted-foreground">{t("layout.repo")}</div>
                  <div className="text-foreground break-all">{updateStatus.data?.repoUrl ?? "-"}</div>
                </div>
                <div className="rounded border border-border p-2 bg-background/60">
                  <div className="text-muted-foreground">{t("layout.branch")}</div>
                  <div className="text-foreground">{updateStatus.data?.branch ?? "-"}</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-2 py-0.5 rounded border ${updateAvailable ? "border-amber-500/50 text-amber-300" : "border-green-500/50 text-green-300"}`}>
                  {updateAvailable ? t("layout.newCommitAvailable") : t("layout.upToDate")}
                </span>
                <span className="text-muted-foreground">{t("layout.local")}: {currentCommitShort}</span>
                <span className="text-muted-foreground">{t("layout.remote")}: {remoteCommitShort}</span>
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

              <div className="rounded border border-border bg-black/40 p-2">
                <div className="text-xs text-muted-foreground mb-1">{t("layout.liveOutput")}</div>
                <pre className="text-[11px] leading-4 text-foreground max-h-44 overflow-auto whitespace-pre-wrap">
{(updateStatus.data?.lastUpdateOutput?.length ?? 0) > 0
  ? updateStatus.data?.lastUpdateOutput?.join("\n")
  : t("layout.noUpdateOutput")}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      <SetupWizardModal
        open={setupModalOpen}
        onClose={() => setSetupModalOpen(false)}
        settings={(settingsQuery.data ?? []) as Array<{ key: string; value: string }>}
      />
    </div>
  );
}
