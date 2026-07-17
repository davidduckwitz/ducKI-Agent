import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./components/dashboard/Dashboard";
import { ChatContainer } from "./components/chat/ChatContainer";
import { ProjectManager } from "./components/projects/ProjectManager";
import { TaskManager } from "./components/tasks/TaskManager";

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

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="p-6 text-sm text-gray-400">Seite wird geladen...</div>}>{children}</Suspense>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="chat" element={<ChatContainer />} />
          <Route path="projects" element={<ProjectManager />} />
          <Route path="tasks" element={<TaskManager />} />
          <Route path="tools" element={<LazyRoute><ToolRegistry /></LazyRoute>} />
          <Route path="skills" element={<LazyRoute><SkillManager /></LazyRoute>} />
          <Route path="shared" element={<LazyRoute><SharedWorkspace /></LazyRoute>} />
          <Route
            path="memory"
            element={
              <Suspense fallback={<div className="p-6 text-sm text-gray-400">Memory wird geladen...</div>}>
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
