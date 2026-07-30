// Determine base URL: use configurable backend or default
function getBaseUrl(): string {
  // Check if running in Tauri or Electron (desktop apps need absolute URLs)
  const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;
  const isElectron = typeof window !== 'undefined' && (window as any).electron;
  const isDesktop = isTauri || isElectron;

  // Try to get configured backend URL from localStorage
  try {
    const config = localStorage.getItem('backend-config');
    if (config) {
      const parsed = JSON.parse(config);
      if (parsed.type === 'remote' && parsed.url) {
        return parsed.url.replace(/\/$/, ''); // Remove trailing slash
      }
      if (parsed.type === 'local' && parsed.port && isDesktop) {
        return `http://localhost:${parsed.port}`;
      }
    }
  } catch {
    // Fall through to defaults
  }

  // Default behavior: desktop apps need absolute localhost URLs
  if (isDesktop) {
    return 'http://localhost:3001';
  }

  // In browser, use relative /api path (proxy will handle it)
  return '/api';
}

let BASE_URL = getBaseUrl();

// Refresh BASE_URL when storage changes
if (typeof window !== 'undefined') {
  window.addEventListener('storage', () => {
    BASE_URL = getBaseUrl();
  });
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;

  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    // If /api fails, try localhost fallback
    if (!BASE_URL.includes('localhost')) {
      try {
        res = await fetch(`http://localhost:3001${path}`, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
      } catch {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!res.ok) {
    const error = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }

  const data = (await res.json()) as { data: T };
  return data.data;
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
    delete: (id: number) => request<unknown>(`/projects/${id}`, { method: "DELETE" }),
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
      action: "add" | "replace" | "remove" | "batch" | "pending_list" | "approve";
      type?: string;
      target?: "memory" | "user";
      conversationId?: number;
      content?: string;
      oldText?: string;
      operations?: Array<{ action: "add" | "replace" | "remove"; content?: string; oldText?: string }>;
      pendingId?: string;
      approved?: boolean;
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
    downloadUrl: (path: string) => `${BASE_URL}/shared/download?path=${encodeURIComponent(path)}`,
    viewUrl: (path: string) => `${BASE_URL}/shared/view?path=${encodeURIComponent(path)}`,
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
};
