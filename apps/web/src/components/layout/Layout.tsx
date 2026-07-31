import { Outlet } from "react-router-dom";
import { useEffect, useRef } from "react";
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
  Code2,
  Wallet,
} from "lucide-react";
import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";
import { useSettings, readFlag } from "../../lib/useSettings";
import { useSettingsChangeListener } from "../../lib/useServerQuery";
import { SetupWizardModal } from "../setup/SetupWizardModal";
import { PetLayer } from "../pet/PetLayer";
import { Sidebar } from "./Sidebar";
import { UpdateStatusBar } from "./UpdateStatusBar";
import type { NavGroup } from "./MoreNavSection";

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
