import { Outlet } from "react-router-dom";
import { useEffect, useRef, type ComponentType } from "react";
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
  Send,
  GitBranch,
  CalendarClock,
  PlugZap,
  Puzzle,
  Code2,
  Wallet,
} from "lucide-react";
import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";
import { useSettings, readFlag } from "../../lib/useSettings";
import { usePlugins, frontendPlugins } from "../../lib/usePlugins";
import { useSettingsChangeListener } from "../../lib/useServerQuery";
import { SetupWizardModal } from "../setup/SetupWizardModal";
import { PetLayer } from "../pet/PetLayer";
import { Sidebar } from "./Sidebar";
import { UpdateStatusBar } from "./UpdateStatusBar";
import type { NavGroup } from "./MoreNavSection";

/** Stable emoji-as-icon components keyed by emoji, so plugin nav items match the NavItem shape. */
const emojiIconCache = new Map<string, ComponentType<{ className?: string }>>();
function emojiIcon(emoji: string): ComponentType<{ className?: string }> {
  let Cached = emojiIconCache.get(emoji);
  if (!Cached) {
    Cached = ({ className }: { className?: string }) => (
      <span className={className} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{emoji}</span>
    );
    emojiIconCache.set(emoji, Cached);
  }
  return Cached;
}

export function Layout() {
  const { t } = useI18n();
  const {
    initSocket,
    disconnectSocket,
    connected,
    agentStatus,
    globalRunningAgents,
    setupModalOpen,
    setSetupModalOpen,
    runningTools,
    gatewayStatus,
    agentMetrics,
  } = useAppStore();
  const firstRunCheckDone = useRef(false);

  // Invalidate the shared settings cache when the server announces a change.
  useSettingsChangeListener();

  // Agent metrics arrive via socket push (agent:metrics). This used to be a 1.5s poll
  // of /agents/live on every single page - 40 requests a minute on its own.
  const runningCount = globalRunningAgents;
  const gatewayActive = Boolean((gatewayStatus as { discord?: { active?: boolean } } | undefined)?.discord?.active);
  const bitcoinPuzzles = Number(
    (agentMetrics as { bitcoinPuzzles?: number } | undefined)?.bitcoinPuzzles ?? 0
  );

  const settingsQuery = useSettings();
  const codingEnabled = readFlag(settingsQuery.data, "CODING_ENABLED");
  const pluginsQuery = usePlugins();

  useEffect(() => {
    if (firstRunCheckDone.current) return;
    if (!settingsQuery.data) return;
    if (!readFlag(settingsQuery.data, "SETUP_COMPLETED")) setSetupModalOpen(true);
    firstRunCheckDone.current = true;
  }, [setSetupModalOpen, settingsQuery.data]);

  useEffect(() => {
    initSocket();
    return () => disconnectSocket();
  }, []);

  const navGroups: NavGroup[] = [
    {
      title: t("nav.groups.overview"),
      items: [
        { to: "/dashboard", icon: LayoutDashboard, label: t("nav.dashboard") },
        { to: "/chat", icon: MessageSquare, label: t("nav.chat") },
        ...(codingEnabled ? [{ to: "/coding", icon: Code2, label: "Agent Control" }] : []),
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
        { to: "/plugins", icon: Puzzle, label: t("nav.plugins") },
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
        { to: "/crypto", icon: Wallet, label: "Crypto Payment" },
        { to: "/settings", icon: Settings, label: t("nav.settings") },
      ],
    },
  ];

  // Enabled plugins with a frontend page get a sidebar link under their category, opening the
  // page in the content area (route /plugin/:name). Category falls back to "system".
  const categoryTitle: Record<string, string> = {
    overview: t("nav.groups.overview"),
    workspace: t("nav.groups.workspace"),
    automation: t("nav.groups.automation"),
    knowledge: t("nav.groups.knowledge"),
    system: t("nav.groups.system"),
  };
  for (const plugin of frontendPlugins(pluginsQuery.data)) {
    const title = categoryTitle[plugin.category ?? "system"] ?? t("nav.groups.system");
    const item = { to: `/plugin/${plugin.name}`, icon: emojiIcon(plugin.icon ?? "🧩"), label: plugin.name };
    const group = navGroups.find((g) => g.title === title);
    if (group) group.items.push(item);
    else navGroups.push({ title, items: [item] });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        navGroups={navGroups}
        codingEnabled={codingEnabled}
        runningCount={runningCount}
        runningTools={runningTools}
        gatewayActive={gatewayActive}
        bitcoinPuzzles={bitcoinPuzzles}
        connected={connected}
        agentStatus={agentStatus}
      />

      {/* min-w-0 keeps wide children (editor, tables) from stretching the shell. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <UpdateStatusBar />
      </div>

      <SetupWizardModal
        open={setupModalOpen}
        onClose={() => setSetupModalOpen(false)}
        settings={(settingsQuery.data ?? []) as Array<{ key: string; value: string }>}
      />

      {/* Free-roaming desk pet on top of the whole window (opt-out in settings). */}
      <PetLayer />
    </div>
  );
}
