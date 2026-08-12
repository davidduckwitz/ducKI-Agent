import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Code2, FilePlus2, FolderPlus, LayoutGrid, MessageSquarePlus, Plus, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { useUiStore, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../../lib/uiStore";
import { useIsMobile } from "../../lib/useMediaQuery";
import { useCodingSession } from "../../lib/codingSessionStore";
import { SplitHandle } from "../ui/split-handle";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { CodingSidebarPanel } from "../coding/CodingSidebarPanel";
import { SidebarHeader } from "./SidebarHeader";
import { RecentChatsSection } from "./RecentChatsSection";
import { MoreNavSection, type NavGroup } from "./MoreNavSection";
import { PluginWidgets } from "../plugins/PluginWidgets";
import { LiveAgentsFooter } from "./LiveAgentsFooter";

function ModeSwitcher({ active, onSelect }: { active: "standard" | "coding"; onSelect: (mode: "standard" | "coding") => void }) {
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background/60 p-1">
      {(
        [
          { key: "standard" as const, icon: LayoutGrid, label: t("layout.sidebarModeStandard") },
          { key: "coding" as const, icon: Code2, label: t("layout.sidebarModeCoding") },
        ]
      ).map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            active === key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  navGroups,
  codingEnabled,
  runningCount,
  runningTools,
  gatewayActive,
  bitcoinPuzzles,
  connected,
  agentStatus,
}: {
  navGroups: NavGroup[];
  codingEnabled: boolean;
  runningCount: number;
  runningTools: Set<string>;
  gatewayActive: boolean;
  bitcoinPuzzles: number;
  connected: boolean;
  agentStatus: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const isCodingRoute = location.pathname.startsWith("/coding");
  const { setConversationId } = useAppStore();
  const { sidebarCollapsed, toggleSidebar, sidebarWidth, setSidebarWidth, mobileNavOpen, setMobileNavOpen } =
    useUiStore();
  const isMobile = useIsMobile();
  const runCodingCommand = useCodingSession((s) => s.runCommand);
  const busy = runningCount > 0 || runningTools.size > 0;

  const startNewChat = () => {
    // Clear chat state and reset for a fresh conversation
    useAppStore.getState().clearChat();
    setConversationId(undefined);
    navigate("/chat");
  };

  // On mobile the sidebar is a drawer over the content: no rail mode, no resize handle,
  // and it closes as soon as the user picks something.
  if (isMobile) {
    return (
      <>
        {mobileNavOpen && (
          <button
            type="button"
            aria-label={t("layout.sidebar.closeNav")}
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          />
        )}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col border-r border-border bg-card shadow-2xl transition-transform duration-200 ease-out md:hidden ${
            mobileNavOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          aria-hidden={!mobileNavOpen}
          onClick={(event) => {
            // Any nav link / action inside dismisses the drawer, so the content is visible again.
            if ((event.target as HTMLElement).closest("a,button")) setMobileNavOpen(false);
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">{t("layout.sidebar.navigation")}</span>
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              aria-label={t("layout.sidebar.closeNav")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <SidebarHeader
            connected={connected}
            agentStatus={agentStatus}
            busy={busy}
            collapsed={false}
            onToggleCollapsed={toggleSidebar}
            hideCollapseToggle
          />

          <div className="space-y-2 p-2">
            {codingEnabled && (
              <ModeSwitcher
                active={isCodingRoute ? "coding" : "standard"}
                onSelect={(mode) => navigate(mode === "coding" ? "/coding" : "/dashboard")}
              />
            )}
            <button
              type="button"
              onClick={startNewChat}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              {t("layout.sidebar.newChat")}
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2">
            {isCodingRoute && codingEnabled && <CodingSidebarPanel />}
            <PluginWidgets placement="sidebar" />
            <RecentChatsSection />
            <MoreNavSection groups={navGroups} />
          </div>

          <LiveAgentsFooter
            runningCount={runningCount}
            runningTools={runningTools}
            gatewayActive={gatewayActive}
            bitcoinPuzzles={bitcoinPuzzles}
          />
        </aside>
      </>
    );
  }

  if (sidebarCollapsed) {
    const railItems = navGroups.flatMap((group) => group.items);
    return (
      <aside className="flex w-14 shrink-0 flex-col border-r border-border bg-card">
        <SidebarHeader
          connected={connected}
          agentStatus={agentStatus}
          busy={busy}
          collapsed
          onToggleCollapsed={toggleSidebar}
        />
        <div className="flex flex-col items-center gap-1 p-2">
          <button
            type="button"
            onClick={startNewChat}
            title={t("layout.sidebar.newChat")}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto p-2">
          {railItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) => `rail-item ${isActive ? "bg-primary text-primary-foreground" : ""}`}
            >
              <Icon className="h-4 w-4" />
            </NavLink>
          ))}
        </nav>
        <LiveAgentsFooter
          collapsed
          runningCount={runningCount}
          runningTools={runningTools}
          gatewayActive={gatewayActive}
          bitcoinPuzzles={bitcoinPuzzles}
        />
      </aside>
    );
  }

  return (
    <>
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-card"
      style={{ width: `${sidebarWidth}px`, minWidth: `${SIDEBAR_MIN_WIDTH}px`, maxWidth: `${SIDEBAR_MAX_WIDTH}px` }}
    >
      <SidebarHeader
        connected={connected}
        agentStatus={agentStatus}
        busy={busy}
        collapsed={false}
        onToggleCollapsed={toggleSidebar}
      />

      <div className="space-y-2 p-2">
        {codingEnabled && (
          <ModeSwitcher
            active={isCodingRoute ? "coding" : "standard"}
            onSelect={(mode) => navigate(mode === "coding" ? "/coding" : "/dashboard")}
          />
        )}

        <div className="flex gap-1">
          <button
            type="button"
            onClick={startNewChat}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t("layout.sidebar.new")}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={t("layout.sidebar.newActions")}
                className="flex w-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={startNewChat} className="gap-2">
                <MessageSquarePlus className="h-4 w-4" />
                {t("layout.sidebar.newChat")}
              </DropdownMenuItem>
              {codingEnabled && (
                <>
                  <DropdownMenuItem
                    onClick={() => {
                      if (!isCodingRoute) navigate("/coding");
                      runCodingCommand("new-file");
                    }}
                    className="gap-2"
                  >
                    <FilePlus2 className="h-4 w-4" />
                    {t("layout.sidebar.newFile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      if (!isCodingRoute) navigate("/coding");
                      runCodingCommand("new-project");
                    }}
                    className="gap-2"
                  >
                    <FolderPlus className="h-4 w-4" />
                    {t("layout.sidebar.newProject")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* One scroll container for files + chats + "Mehr"; header and footer stay put. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2">
        {isCodingRoute && codingEnabled && <CodingSidebarPanel />}
        <PluginWidgets placement="sidebar" />
        <RecentChatsSection />
        <MoreNavSection groups={navGroups} />
      </div>

      <LiveAgentsFooter
        runningCount={runningCount}
        runningTools={runningTools}
        gatewayActive={gatewayActive}
        bitcoinPuzzles={bitcoinPuzzles}
      />
    </aside>

    {/* Dragging right widens the sidebar; double click restores the default. */}
    <SplitHandle
      value={sidebarWidth}
      onChange={setSidebarWidth}
      direction="right"
      resetValue={SIDEBAR_DEFAULT_WIDTH}
      ariaLabel={t("layout.sidebar.resize")}
    />
    </>
  );
}
