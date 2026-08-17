import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useSettings, readFlag } from "./lib/useSettings";
import { useAppStore } from "./lib/store";
import { startConnectionGate } from "./lib/useServerQuery";
import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./components/dashboard/Dashboard";
import { ChatContainer } from "./components/chat/ChatContainer";
import { ProjectManager } from "./components/projects/ProjectManager";
import { TaskManager } from "./components/tasks/TaskManager";
import { ToastDisplay } from "./components/ui/toast-display";
import { ToolActivityLogger } from "./components/chat/ToolActivityLogger";
import { LiveBrowserWindowsLayer } from "./components/chat/LiveBrowserWindow";
import { useI18n } from "./lib/i18n";
import { initializeCharacterSystem } from "./components/chat/characters";

const ToolRegistry = lazy(async () => {
  const module = await import("./components/tools/ToolRegistry");
  return { default: module.ToolRegistry };
});

const SkillManager = lazy(async () => {
  const module = await import("./components/skills/SkillManager");
  return { default: module.SkillManager };
});

const SharedWorkspace = lazy(async () => {
  const module = await import("./components/shared/SharedWorkspace");
  return { default: module.SharedWorkspace };
});

const WorkflowGraphEditor = lazy(async () => {
  const module = await import("./components/workflow/WorkflowGraphEditor");
  return { default: module.WorkflowGraphEditor };
});

const LogViewer = lazy(async () => {
  const module = await import("./components/logs/LogViewer");
  return { default: module.LogViewer };
});

const Settings = lazy(async () => {
  const module = await import("./components/settings/Settings");
  return { default: module.Settings };
});

const MemoryBrowser = lazy(async () => {
  const module = await import("./components/memory/MemoryBrowser");
  return { default: module.MemoryBrowser };
});

const PluginsPage = lazy(async () => {
  const module = await import("./components/plugins/PluginsPage");
  return { default: module.PluginsPage };
});

const PluginFrontendView = lazy(async () => {
  const module = await import("./components/plugins/PluginFrontendView");
  return { default: module.PluginFrontendView };
});

const AgentsLiveView = lazy(async () => {
  const module = await import("./components/agents/AgentsLiveView");
  return { default: module.AgentsLiveView };
});
const MessagingGateway = lazy(async () => {
  const module = await import("./components/gateway/MessagingGateway");
  return { default: module.MessagingGateway };
});

const CronjobManager = lazy(async () => {
  const module = await import("./components/cronjobs/CronjobManager");
  return { default: module.CronjobManager };
});

const McpManager = lazy(async () => {
  const module = await import("./components/mcp/McpManager");
  return { default: module.McpManager };
});

const CodingWorkspace = lazy(async () => {
  const module = await import("./components/coding/CodingWorkspace");
  return { default: module.CodingWorkspace };
});

const CryptoPaymentPage = lazy(async () => {
  const module = await import("./pages/crypto/PaymentPage");
  return { default: module.CryptoPaymentPage };
});

function LazyRoute({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <Suspense fallback={<div className="p-6 text-sm text-gray-400">{t("app.loadingPage")}</div>}>{children}</Suspense>;
}

function CodingGate() {
  const { t } = useI18n();
  // Shares the one cached settings query instead of running a fourth 5s poll.
  const settingsQuery = useSettings();

  if (settingsQuery.isLoading || !settingsQuery.data) {
    return <div className="p-6 text-sm text-muted-foreground">{t("app.loadingPage")}</div>;
  }

  if (!readFlag(settingsQuery.data, "CODING_ENABLED")) {
    return <Navigate to="/dashboard" replace />;
  }

  return <LazyRoute><CodingWorkspace /></LazyRoute>;
}

function AppContent() {
  const { t } = useI18n();
  const { toolCalls, removeToolCall } = useAppStore();

  // Initialize character system on app startup
  useEffect(() => {
    initializeCharacterSystem();
  }, []);

  // Ties React Query's online state to the handshake, so every query in the app pauses
  // while the server is unreachable and resumes on reconnect - without each component
  // having to opt in.
  useEffect(() => startConnectionGate(), []);

  return (
    <>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="chat" element={<ChatContainer />} />
          <Route path="coding" element={<CodingGate />} />
          <Route path="projects" element={<ProjectManager />} />
          <Route path="tasks" element={<TaskManager />} />
          <Route path="cronjobs" element={<LazyRoute><CronjobManager /></LazyRoute>} />
          <Route path="mcp" element={<LazyRoute><McpManager /></LazyRoute>} />
          <Route path="tools" element={<LazyRoute><ToolRegistry /></LazyRoute>} />
          <Route path="skills" element={<LazyRoute><SkillManager /></LazyRoute>} />
          <Route path="plugins" element={<LazyRoute><PluginsPage /></LazyRoute>} />
          <Route path="plugin/:name" element={<LazyRoute><PluginFrontendView /></LazyRoute>} />
          <Route path="shared" element={<LazyRoute><SharedWorkspace /></LazyRoute>} />
          <Route
            path="memory"
            element={
              <Suspense fallback={<div className="p-6 text-sm text-gray-400">{t("app.loadingMemory")}</div>}>
                <MemoryBrowser />
              </Suspense>
            }
          />
          <Route path="gateway" element={<LazyRoute><MessagingGateway /></LazyRoute>} />
          <Route path="workflow" element={<LazyRoute><WorkflowGraphEditor /></LazyRoute>} />
          <Route path="agents" element={<LazyRoute><AgentsLiveView /></LazyRoute>} />
          <Route path="logs" element={<LazyRoute><LogViewer /></LazyRoute>} />
          <Route path="crypto" element={<LazyRoute><CryptoPaymentPage /></LazyRoute>} />
          <Route path="settings" element={<LazyRoute><Settings /></LazyRoute>} />
          {/* Unknown paths (incl. a direct /index.html hit under a sub-path deploy) -> dashboard */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
      <ToastDisplay />
      <ToolActivityLogger toolCalls={toolCalls} onRemoveCall={removeToolCall} />
      <LiveBrowserWindowsLayer />
    </>
  );
}

// Honour Vite's base (e.g. "/web/") so routing works under a sub-path deploy.
// React Router wants a basename without a trailing slash; "/" means root.
const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

export default function App() {
  return (
    <BrowserRouter basename={routerBasename}>
      <AppContent />
    </BrowserRouter>
  );
}
