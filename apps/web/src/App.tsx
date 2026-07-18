import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./components/dashboard/Dashboard";
import { ChatContainer } from "./components/chat/ChatContainer";
import { ProjectManager } from "./components/projects/ProjectManager";
import { TaskManager } from "./components/tasks/TaskManager";
import { useI18n } from "./lib/i18n";
import { api } from "./lib/api";

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

function LazyRoute({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <Suspense fallback={<div className="p-6 text-sm text-gray-400">{t("app.loadingPage")}</div>}>{children}</Suspense>;
}

function CodingGate() {
  const { t } = useI18n();
  const settingsQuery = useQuery({
    queryKey: ["settings", "coding-gate"],
    queryFn: () => api.settings.list() as Promise<Array<{ key: string; value: string }>>,
    refetchInterval: 5000,
  });

  if (settingsQuery.isLoading || !settingsQuery.data) {
    return <div className="p-6 text-sm text-gray-400">{t("app.loadingPage")}</div>;
  }

  const rawValue = settingsQuery.data.find((s) => s.key === "CODING_ENABLED")?.value;
  const codingEnabled = String(rawValue ?? "false").trim().toLowerCase() === "true";

  if (!codingEnabled) {
    return <Navigate to="/dashboard" replace />;
  }

  return <LazyRoute><CodingWorkspace /></LazyRoute>;
}

export default function App() {
  const { t } = useI18n();

  return (
    <BrowserRouter>
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
          <Route path="settings" element={<LazyRoute><Settings /></LazyRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
