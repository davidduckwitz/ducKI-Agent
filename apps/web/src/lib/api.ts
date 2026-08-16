import { getApiBaseUrl } from "./backendUrl";

/** @deprecated Use getApiBaseUrl from ./backendUrl - kept as a named re-export so
 *  existing importers keep working. */
export const getBaseUrl = getApiBaseUrl;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // No localhost fallback: it used to retry every failed request against
  // http://localhost:3001, which silently queried the wrong machine in remote mode and
  // doubled the request count whenever the backend was down.
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const error = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }

  const response = (await res.json()) as { success?: boolean; data: T } | { data: T };
  return response.data;
}

export interface PluginReload {
  applied: boolean;
  deferred: boolean;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  enabled: boolean;
  hasStorage: boolean;
  toolNames: string[];
  skillDirs: string[];
  mappings: Array<{ alias: string; tool: string }>;
  settings: Array<{ key: string; default?: string | number | boolean; type?: string; description?: string }>;
  /** Relative path to a pure settings page, if the plugin ships one. */
  settingsPage?: string;
  /** Relative path to a frontend (mini-app) page shown as a sidebar link. */
  frontendPage?: string;
  /** Relative path to a widget tile rendered in sidebar/dashboard. */
  widgetPage?: string;
  /** Widget placement: "sidebar" | "dashboard" | "both". */
  widgetPlacement?: string;
  /** Relative path to a full-window overlay page mounted globally by the host. */
  overlayPage?: string;
  /** Declarative pet definitions the plugin ships (rendered by the host pet runtime). */
  pets?: Array<{
    id: string;
    name: string;
    emoji: string;
    description?: string;
    locomotion: "ground" | "air";
    kind: "svg" | "matrix";
    art?: string;
    palette?: { primary?: string; secondary?: string; accent?: string; eye?: string };
  }>;
  /** Emoji/short icon for UI + sidebar. */
  icon?: string;
  /** Sidebar category for a frontend page. */
  category?: string;
  error?: string;
}

export const api = {
  chat: {
    listConversations: (projectId?: number) =>
      request<unknown[]>(`/chat/conversations${projectId ? `?projectId=${projectId}` : ""}`),
    listConversationsPage: (args?: { projectId?: number; limit?: number; beforeId?: number }) => {
      const params = new URLSearchParams();
      if (args?.projectId !== undefined) params.set("projectId", String(args.projectId));
      if (args?.limit !== undefined) params.set("limit", String(args.limit));
      if (args?.beforeId !== undefined) params.set("beforeId", String(args.beforeId));
      const query = params.toString();
      return request<{ items: unknown[]; hasMore: boolean; nextBeforeId?: number }>(`/chat/conversations/page${query ? `?${query}` : ""}`);
    },
    getMessages: (conversationId: number) => request<unknown[]>(`/chat/conversations/${conversationId}/messages`),
    getMessagesPage: (conversationId: number, args?: { limit?: number; beforeId?: number }) => {
      const params = new URLSearchParams();
      if (args?.limit !== undefined) params.set("limit", String(args.limit));
      if (args?.beforeId !== undefined) params.set("beforeId", String(args.beforeId));
      const query = params.toString();
      return request<{ items: unknown[]; hasMore: boolean; nextBeforeId?: number }>(`/chat/conversations/${conversationId}/messages/page${query ? `?${query}` : ""}`);
    },
    search: (query: string, limit = 20) =>
      request<
        Array<{
          conversationId: number;
          conversationName: string;
          messageId: number;
          role: string;
          content: string;
          createdAt: string;
        }>
      >(`/chat/search?query=${encodeURIComponent(query)}&limit=${limit}`),
    createConversation: (data: { name?: string; projectId?: number }) =>
      request<{ conversationId: number }>("/chat/conversation", { method: "POST", body: JSON.stringify(data) }),
    updateConversation: (conversationId: number, data: { projectId?: number; name?: string }) =>
      request<unknown>(`/chat/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify(data) }),
    deleteConversation: (conversationId: number) =>
      request<{ deleted: boolean; id: number }>(`/chat/conversations/${conversationId}`, { method: "DELETE" }),
    clearMessages: (conversationId: number) =>
      request<{ cleared: boolean; conversationId: number }>(`/chat/conversations/${conversationId}/messages`, { method: "DELETE" }),
  },

  workflows: {
    list: () => request<unknown[]>("/workflows"),
    get: (id: string) => request<unknown>(`/workflows/${id}`),
    create: (data: Record<string, unknown>) => request<unknown>("/workflows", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<unknown>(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    run: (id: string) => request<unknown>(`/workflows/${id}/run`, { method: "POST" }),
    resume: (id: string) => request<unknown>(`/workflows/${id}/resume`, { method: "POST" }),
    delete: (id: string) => request<unknown>(`/workflows/${id}`, { method: "DELETE" }),
  },

  projects: {
    list: () => request<unknown[]>("/projects"),
    get: (id: number) => request<unknown>(`/projects/${id}`),
    create: (data: { name: string; description?: string; folder?: string }) =>
      request<unknown>("/projects", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Record<string, unknown>) =>
      request<unknown>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    getDependencies: (id: number) =>
      request<{
        codingFolder?: boolean;
        conversationCount: number;
        taskCount: number;
        workflowCount: number;
      }>(`/projects/${id}/dependencies`),
    delete: (id: number, options?: { deleteCodingFolder?: boolean; deleteConversations?: boolean; deleteTasks?: boolean; deleteWorkflows?: boolean }) =>
      request<unknown>(`/projects/${id}`, { method: "DELETE", body: JSON.stringify(options || {}) }),
  },

  tasks: {
    list: (projectId?: number) => request<unknown[]>(`/tasks${projectId ? `?projectId=${projectId}` : ""}`),
    get: (id: number) => request<unknown>(`/tasks/${id}`),
    create: (data: { title: string; description?: string; priority?: string; projectId?: number }) =>
      request<unknown>("/tasks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Record<string, unknown>) =>
      request<unknown>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    run: (id: number) => request<unknown>(`/tasks/${id}/run`, { method: "POST" }),
    delete: (id: number) => request<unknown>(`/tasks/${id}`, { method: "DELETE" }),
    split: (
      id: number,
      data: { dryRun?: boolean; subtasks?: Array<{ title: string; description: string; estimatedMinutes?: number }> }
    ) =>
      request<{
        parent: unknown;
        complexity?: number;
        subtasks: Array<{ title: string; description: string; estimatedMinutes?: number }>;
      }>(`/tasks/${id}/split`, { method: "POST", body: JSON.stringify(data) }),
  },

  cronjobs: {
    list: () => request<unknown[]>("/cronjobs"),
    get: (id: number) => request<unknown>(`/cronjobs/${id}`),
    create: (data: {
      name: string;
      schedule: string;
      targetType: "task" | "prompt" | "tool" | "skill";
      targetRef?: string;
      payload?: Record<string, unknown>;
      enabled?: boolean;
    }) => request<unknown>("/cronjobs", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Record<string, unknown>) =>
      request<unknown>(`/cronjobs/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    run: (id: number) => request<unknown>(`/cronjobs/${id}/run`, { method: "POST" }),
    delete: (id: number) => request<unknown>(`/cronjobs/${id}`, { method: "DELETE" }),
  },

  mcp: {
    servers: () =>
      request<{
        configured: Array<{ id: string; name: string; url: string; enabled: boolean }>;
        runtime: Array<{ id: string; name: string; url: string; enabled: boolean; connected: boolean; reconnectAttempts: number; tools: number }>;
      }>("/mcp/servers"),
    saveServers: (servers: Array<{ id: string; name: string; url: string; enabled: boolean }>) =>
      request<{
        saved: boolean;
        servers: Array<{ id: string; name: string; url: string; enabled: boolean; connected: boolean; reconnectAttempts: number; tools: number }>;
      }>("/mcp/servers", { method: "PUT", body: JSON.stringify({ servers }) }),
    reloadServers: () =>
      request<{
        reloaded: boolean;
        servers: Array<{ id: string; name: string; url: string; enabled: boolean; connected: boolean; reconnectAttempts: number; tools: number }>;
      }>("/mcp/servers/reload", { method: "POST" }),
    tools: () =>
      request<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; serverId: string }>>("/mcp/tools"),
    callTool: (payload: { toolName: string; input?: Record<string, unknown>; serverId?: string }) =>
      request<unknown>("/mcp/tools/call", { method: "POST", body: JSON.stringify(payload) }),
  },

  tools: {
    list: () =>
      request<
        Array<{
          name: string;
          description: string;
          parameters?: Record<string, unknown>;
          core: boolean;
          enabled: boolean;
          subagent: boolean;
        }>
      >("/tools"),
    execute: (toolName: string, input: Record<string, unknown>, conversationId?: number) =>
      request<{ success: boolean; data: unknown; error?: string; toolName: string }>("/tools/execute", {
        method: "POST",
        body: JSON.stringify({ toolName, input, conversationId }),
      }),
  },

  plans: {
    list: (conversationId?: number, projectId?: number) => {
      const params = new URLSearchParams();
      if (conversationId) params.set("conversationId", String(conversationId));
      if (projectId) params.set("projectId", String(projectId));
      const query = params.toString();
      return request<unknown[]>(`/plans${query ? `?${query}` : ""}`);
    },
    get: (id: number) => request<unknown>(`/plans/${id}`),
    create: (data: {
      conversationId?: number;
      projectId?: number;
      goal: string;
      title?: string;
      complexity?: number;
      steps: Array<{ title: string; description: string; tools?: string[] }>;
      tools?: string[];
      markdown?: string;
    }) => request<unknown>("/plans", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: Record<string, unknown>) =>
      request<unknown>(`/plans/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: number) => request<{ deleted: boolean; id: number }>(`/plans/${id}`, { method: "DELETE" }),
    execute: (
      id: number | undefined,
      payload: {
        goal: string;
        steps: Array<{ title: string; description: string; tools?: string[] }>;
        markdown?: string;
        conversationId?: number;
        projectId?: number;
        projectSlug?: string;
      }
    ) =>
      request<{ message: string; planId: number | null; executionResult?: unknown }>(
        `/plans/${id ?? "draft"}/execute`,
        { method: "POST", body: JSON.stringify(payload) }
      ),
    importMarkdown: (markdown: string) =>
      request<unknown>("/plans/import/markdown", { method: "POST", body: JSON.stringify({ markdown }) }),
  },

  memory: {
    list: (conversationId?: number, type?: string) => {
      const params = new URLSearchParams();
      if (conversationId) params.set("conversationId", String(conversationId));
      if (type) params.set("type", type);
      const query = params.toString();
      return request<unknown[]>(`/memory${query ? `?${query}` : ""}`);
    },
    action: (payload: {
      action: "add" | "replace" | "remove" | "batch" | "pending_list" | "approve" | "prune_short_term" | "consolidate";
      type?: string;
      target?: "memory" | "user";
      conversationId?: number;
      content?: string;
      oldText?: string;
      operations?: Array<{ action: "add" | "replace" | "remove"; content?: string; oldText?: string }>;
      pendingId?: string;
      approved?: boolean;
      keep?: number;
      threshold?: number;
    }) => request<unknown>("/memory/actions", { method: "POST", body: JSON.stringify(payload) }),
    delete: (id: number) => request<{ deleted: boolean; id: number }>(`/memory/${id}`, { method: "DELETE" }),
    getProfile: () => request<{ systemPrompt: string; agentBehavior: string; humanInfo: string }>("/memory/profile"),
    saveProfile: (payload: { systemPrompt: string; agentBehavior: string; humanInfo: string }) =>
      request<{ saved: boolean; systemPrompt: string; agentBehavior: string; humanInfo: string }>("/memory/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
  },

  settings: {
    list: () => request<{ key: string; value: string }[]>("/settings"),
    get: (key: string) => request<{ key: string; value: string | null }>(`/settings/${key}`),
    set: (key: string, value: string) => request<unknown>(`/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
    testDatabase: (payload: {
      engine?: string;
      host?: string;
      port?: number | string;
      user?: string;
      password?: string;
      database?: string;
    }) => request<{
      ok: boolean;
      engine?: string;
      error?: string;
      message?: string;
      serverVersion?: string;
      latencyMs?: number;
      database?: string;
      totalTablesInDb?: number;
      tables?: { expected: number; present: string[]; missing: string[]; allPresent: boolean } | null;
    }>("/settings/database/test", { method: "POST", body: JSON.stringify(payload) }),
  },

  sync: {
    status: () => request<{ connected: boolean; baseUrl: string }>("/sync/status"),
    connect: (apiKey: string, baseUrl?: string) =>
      request<{ connected: boolean; baseUrl: string }>("/sync/connect", {
        method: "POST",
        body: JSON.stringify({ apiKey, baseUrl }),
      }),
    disconnect: () => request<{ connected: boolean }>("/sync/disconnect", { method: "POST" }),
    listBackups: () =>
      request<
        Array<{
          id: number;
          filename: string;
          device_name: string | null;
          size_bytes: number;
          checksum: string | null;
          manifest: Record<string, unknown> | null;
          created_at: string;
        }>
      >("/sync/backups"),
    createBackup: (deviceName?: string) =>
      request<{ backup: { id: number; filename: string; created_at: string; size_bytes: number } }>("/sync/backup", {
        method: "POST",
        body: JSON.stringify({ deviceName }),
      }),
    restore: (backupId?: number) =>
      request<{ backup: { id: number; filename: string; created_at: string }; restartRequired: true }>(
        "/sync/restore",
        { method: "POST", body: JSON.stringify({ backupId }) }
      ),
    getSchedule: () =>
      request<{ enabled: boolean; intervalHours: number; lastRunAt: string | null }>("/sync/schedule"),
    setSchedule: (payload: { enabled?: boolean; intervalHours?: number }) =>
      request<{ ok: boolean }>("/sync/schedule", { method: "PUT", body: JSON.stringify(payload) }),
    getControl: () => request<{ enabled: boolean; heartbeatIntervalMinutes: number }>("/sync/control"),
    setControl: (payload: { enabled?: boolean; heartbeatIntervalMinutes?: number }) =>
      request<{ ok: boolean }>("/sync/control", { method: "PUT", body: JSON.stringify(payload) }),
  },

  plugins: {
    list: () => request<PluginInfo[]>("/plugins"),
    get: (name: string) => request<PluginInfo & { manifest: unknown }>(`/plugins/${name}`),
    enable: (name: string) => request<{ name: string; enabled: boolean; reload: PluginReload }>(`/plugins/${name}/enable`, { method: "POST" }),
    disable: (name: string) => request<{ name: string; enabled: boolean; reload: PluginReload }>(`/plugins/${name}/disable`, { method: "POST" }),
    install: (payload: { url?: string; name?: string; files?: Array<{ path: string; content: string }> }) =>
      request<{ name: string; installed: boolean; files: number; reload: PluginReload }>("/plugins/install", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },

  coding: {
    status: () => request<{ enabled: boolean; root: string }>("/coding/status"),
    listProjects: () => request<Array<{ slug: string; name: string }>>("/coding/projects"),
    createProject: (name: string) =>
      request<{ created: boolean; slug: string; path: string }>("/coding/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    listFiles: (project: string) =>
      request<{ project: string; files: Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> }>(
        `/coding/projects/${encodeURIComponent(project)}/files`
      ),
    readFile: (project: string, path: string) =>
      request<{ project: string; path: string; size: number; isText: boolean; content?: string; contentBase64?: string }>(
        `/coding/projects/${encodeURIComponent(project)}/read?path=${encodeURIComponent(path)}`
      ),
    writeFile: (project: string, path: string, content: string) =>
      request<{ written: boolean; project: string; path: string }>(`/coding/projects/${encodeURIComponent(project)}/write`, {
        method: "POST",
        body: JSON.stringify({ path, content }),
      }),
    moveFile: (project: string, fromPath: string, toPath: string) =>
      request<{ moved: boolean; project: string; fromPath: string; toPath: string }>(`/coding/projects/${encodeURIComponent(project)}/move`, {
        method: "POST",
        body: JSON.stringify({ fromPath, toPath }),
      }),
    deleteFile: (project: string, path: string) =>
      request<{ deleted: boolean; project: string; path: string }>(
        `/coding/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      ),
    uploadFile: (project: string, data: { fileName: string; contentBase64: string; folder?: string }) =>
      request<{ uploaded: boolean; project: string; path: string; size: number }>(`/coding/projects/${encodeURIComponent(project)}/upload`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },

  skills: {
    list: () => request<{ slug: string; name: string; description?: string }[]>("/skills"),
    get: (slug: string) => request<{ slug: string; name: string; description?: string; content: string }>(`/skills/${slug}`),
    create: (data: { name?: string; slug?: string; description?: string; content?: string }) =>
      request<{ slug: string; created: boolean }>("/skills", { method: "POST", body: JSON.stringify(data) }),
    import: (data: { url: string; name?: string; slug?: string }) =>
      request<{ slug: string; imported: boolean; sourceUrl: string }>("/skills/import", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (slug: string, content: string) =>
      request<{ slug: string; updated: boolean }>(`/skills/${slug}`, { method: "PUT", body: JSON.stringify({ content }) }),
    patch: (slug: string, oldString: string, newString: string) =>
      request<{ slug: string; patched: boolean }>(`/skills/${slug}`, {
        method: "PATCH",
        body: JSON.stringify({ oldString, newString }),
      }),
    execute: (slug: string, payload?: { scriptFile?: string; input?: unknown; context?: unknown }) =>
      request<{ slug: string; executed: boolean; source: string; logs: string[]; result: unknown }>(`/skills/${slug}/execute`, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      }),
    delete: (slug: string) => request<{ slug: string; deleted: boolean }>(`/skills/${slug}`, { method: "DELETE" }),
  },

  shared: {
    listFiles: () =>
      request<{ root: string; files: Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> }>("/shared/files"),
    readFile: (path: string) =>
      request<{ path: string; size: number; isText: boolean; content?: string; contentBase64?: string }>(`/shared/read?path=${encodeURIComponent(path)}`),
    downloadUrl: (path: string) => `${getBaseUrl()}/shared/download?path=${encodeURIComponent(path)}`,
    viewUrl: (path: string) => `${getBaseUrl()}/shared/view?path=${encodeURIComponent(path)}`,
    writeFile: (path: string, content: string) =>
      request<{ written: boolean; path: string }>("/shared/write", {
        method: "POST",
        body: JSON.stringify({ path, content }),
      }),
    uploadFile: (data: { fileName: string; contentBase64: string; folder?: string }) =>
      request<{ uploaded: boolean; path: string; size: number }>("/shared/upload", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    moveFile: (fromPath: string, toPath: string) =>
      request<{ moved: boolean; fromPath: string; toPath: string }>("/shared/move", {
        method: "POST",
        body: JSON.stringify({ fromPath, toPath }),
      }),
    deleteFile: (path: string) =>
      request<{ deleted: boolean; path: string }>(`/shared/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  },

  logs: {
    list: (level?: string, limit?: number) => {
      const params = new URLSearchParams();
      if (level) params.set("level", level);
      if (limit) params.set("limit", String(limit));
      const query = params.toString();
      return request<unknown[]>(`/logs${query ? `?${query}` : ""}`);
    },
  },

  wiki: {
    status: () =>
      request<{ enabled: boolean; config: { autoMemory: boolean; autoApprove: boolean; maxFileSizeKb: number; intervalMs: number; chunkSizeChars: number; chunkOverlapChars: number }; stats: { scannedFiles: number; processedFiles: number; skippedFiles: number; memoriesCreated: number; updatedAt: string; lastError?: string } | null }>("/wiki/status"),
    entries: (limit?: number, status?: string) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (status) params.set("status", status);
      const query = params.toString();
      return request<Array<{ id: number; sourcePath: string; title: string; status: string; learnedAt: string; updatedAt: string }>>(`/wiki/entries${query ? `?${query}` : ""}`);
    },
    search: (query: string, limit?: number, includeCandidates?: boolean) => {
      const params = new URLSearchParams();
      params.set("query", query);
      if (limit) params.set("limit", String(limit));
      if (includeCandidates !== undefined) params.set("includeCandidates", String(includeCandidates));
      return request<Array<{ id: number; sourcePath: string; title: string; status: string; score: number; contentPreview: string; updatedAt: string }>>(`/wiki/search?${params.toString()}`);
    },
    reindex: () => request<{ reindexed: boolean; stats: unknown }>("/wiki/reindex", { method: "POST" }),
    approveEntry: (id: number) => request<{ approved: boolean; id: number; status: string }>(`/wiki/entries/${id}/approve`, { method: "POST" }),
    rejectEntry: (id: number) => request<{ rejected: boolean; id: number; status: string }>(`/wiki/entries/${id}/reject`, { method: "POST" }),
    saveConfig: (payload: { enabled?: boolean; autoMemory?: boolean; autoApprove?: boolean; maxFileSizeKb?: number; intervalMs?: number; chunkSizeChars?: number; chunkOverlapChars?: number }) =>
      request<{ saved: boolean }>("/wiki/config", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
  },

  updates: {
    status: () =>
      request<{
        enabled: boolean;
        configured: boolean;
        repoUrl?: string;
        branch?: string;
        workdir?: string;
        intervalMinutes?: number;
        requireCleanWorktree?: boolean;
        checking: boolean;
        updating: boolean;
        updateAvailable: boolean;
        currentCommit?: string;
        remoteCommit?: string;
        lastCheckedAt?: string;
        lastCheckError?: string;
        lastUpdatedAt?: string;
        lastUpdateError?: string;
        lastUpdateOutput: string[];
      }>("/updates/status"),
    check: () =>
      request<{
        enabled: boolean;
        configured: boolean;
        checking: boolean;
        updating: boolean;
        updateAvailable: boolean;
        currentCommit?: string;
        remoteCommit?: string;
        lastCheckedAt?: string;
        lastCheckError?: string;
        lastUpdatedAt?: string;
        lastUpdateError?: string;
        lastUpdateOutput: string[];
      }>("/updates/check", { method: "POST" }),
    start: () =>
      request<{
        enabled: boolean;
        configured: boolean;
        checking: boolean;
        updating: boolean;
        updateAvailable: boolean;
        currentCommit?: string;
        remoteCommit?: string;
        lastCheckedAt?: string;
        lastCheckError?: string;
        lastUpdatedAt?: string;
        lastUpdateError?: string;
        lastUpdateOutput: string[];
      }>("/updates/start", { method: "POST" }),
  },

  agents: {
    live: () =>
      request<{
        runningCount: number;
        snapshotAt?: string;
        agents: Array<{
          id: string;
          source: "chat_http" | "chat_ws" | "task_run" | "workflow_run" | "gateway_inbound";
          startedAt: string;
          conversationId?: number;
          taskId?: number;
          socketId?: string;
          label?: string;
        }>;
        sourceMap?: {
          chat_http: number;
          chat_ws: number;
          task_run: number;
          workflow_run: number;
          gateway_inbound: number;
        };
        summary?: {
          chats: number;
          tasks: number;
          workflows: number;
          gateway: number;
        };
        gateway?: {
          discord?: {
            enabled: boolean;
            configured: boolean;
            active: boolean;
            connectedAt?: string;
            lastError?: string;
            updatedAt: string;
          };
        };
      }>("/agents/live"),
  },

  gateway: {
    list: () =>
      request<{
        configs: Array<{
          id: string;
          portal: string;
          name: string;
          enabled: boolean;
          channelHint?: string;
          inboundLabel?: string;
          guildId?: string;
          userId?: string;
          appId?: string;
          publicKey?: string;
          metadata?: string;
          authToken?: string;
          webhookSecret?: string;
        }>;
        endpoints: Array<{
          id: string;
          portal: string;
          webhookUrl: string;
        }>;
        conversations: Array<{
          id: number;
          name: string;
          projectId?: number;
          createdAt: string;
          updatedAt: string;
        }>;
      }>("/gateway"),
    save: (configs: Array<Record<string, unknown>>) =>
      request<{ saved: boolean; configs: Array<Record<string, unknown>> }>("/gateway", {
        method: "PUT",
        body: JSON.stringify({ configs }),
      }),
    inbound: (payload: {
      portal: string;
      externalConversationId: string;
      sourceMessageId?: string;
      message: string;
      text?: string;
      channelName?: string;
      userName?: string;
      projectId?: number;
      configId?: string;
      mode?: "text" | "voice" | "file";
      voiceTranscript?: string;
      voiceLanguage?: string;
      voiceDurationMs?: number;
      attachments?: Array<{
        name: string;
        mimeType?: string;
        contentBase64?: string;
        url?: string;
        text?: string;
      }>;
      reactions?: Array<{ emoji: string; userName?: string }>;
      agentEmoji?: string;
    }) =>
      request<{ conversationId: number; replyText: string; result: unknown; portal: string; configId: string; reaction: string }>("/gateway/inbound", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },

  bitcoinPuzzle: {
    list: () =>
      request<{
        puzzles: Array<{
          id: string;
          name: string;
          targetAddress: string;
          infoUrl?: string;
          createdAt: string;
          status: string;
          generatedAddresses: number;
          found: boolean;
        }>;
      }>("/bitcoin-puzzle"),
    create: (data: { targetAddress: string; startMnemonic?: string; name?: string; infoUrl?: string }) =>
      request<{ success: boolean; id: string; status: string; target: string; startedAt: string }>("/bitcoin-puzzle", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    get: (puzzleId: string) =>
      request<{
        id: string;
        name: string;
        targetAddress: string;
        infoUrl?: string;
        createdAt: string;
        status: string;
        generatedAddresses: number;
        triedCombinationsCount: number;
        currentCombinationMode: string;
        elapsedSeconds: number;
        addressesPerSecond: number;
        isRunning: boolean;
        foundAddress: string | null;
        foundMnemonic: string | null;
        error: string | null;
        lastUpdate: string;
        recentAttempts: Array<{ mnemonic: string; address: string }>;
      }>(`/bitcoin-puzzle/${puzzleId}`),
    pause: (puzzleId: string) =>
      request<{ success: boolean; status: string }>(`/bitcoin-puzzle/${puzzleId}/pause`, {
        method: "POST",
      }),
    resume: (puzzleId: string) =>
      request<{ success: boolean; status: string }>(`/bitcoin-puzzle/${puzzleId}/resume`, {
        method: "POST",
      }),
    stop: (puzzleId: string) =>
      request<{ success: boolean; status: string; generatedAddresses?: number }>(`/bitcoin-puzzle/${puzzleId}/stop`, {
        method: "POST",
      }),
    update: (puzzleId: string, data: { name?: string; infoUrl?: string }) =>
      request<{ success: boolean; metadata: { id: string; name: string; targetAddress: string; infoUrl?: string } }>(`/bitcoin-puzzle/${puzzleId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    search: (puzzleId: string, query: string) =>
      request<{
        puzzleId: string;
        query: string;
        matchCount: number;
        matches: Array<{ mnemonic: string; address: string }>;
      }>(`/bitcoin-puzzle/${puzzleId}/search`, {
        method: "POST",
        body: JSON.stringify({ query }),
      }),
    searchAll: (query: string) =>
      request<{
        query: string;
        resultCount: number;
        totalMatches: number;
        results: Array<{
          puzzleId: string;
          puzzleName: string;
          targetAddress: string;
          matches: Array<{ mnemonic: string; address: string }>;
        }>;
      }>(`/bitcoin-puzzle/search/all`, {
        method: "POST",
        body: JSON.stringify({ query }),
      }),
    checkPhrase: (phrase: string) =>
      request<{
        phrase: string;
        exists: boolean;
        puzzleId: string | null;
      }>(`/bitcoin-puzzle/check-phrase`, {
        method: "POST",
        body: JSON.stringify({ phrase }),
      }),
    markPhrase: (puzzleId: string, phrase: string, address: string = "") =>
      request<{
        success: boolean;
        message: string;
        generatedCount: number;
        isPartial: boolean;
      }>(`/bitcoin-puzzle/${puzzleId}/mark-phrase`, {
        method: "POST",
        body: JSON.stringify({ phrase, address }),
      }),
    delete: (puzzleId: string) =>
      request<{ success: boolean; message: string }>(`/bitcoin-puzzle/${puzzleId}`, {
        method: "DELETE",
      }),
  },

  providerModels: {
    listProviders: () =>
      request<
        Array<{
          id: string;
          name: string;
        }>
      >("/provider-models"),
    getModels: (provider: string) =>
      request<
        {
          success: boolean;
          provider: string;
          models?: Array<{
            id: string;
            name: string;
          }>;
          error?: string;
          timestamp: string;
        }
      >(`/provider-models/${provider}`),
  },
};
