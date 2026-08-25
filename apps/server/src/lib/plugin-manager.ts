import type { ToolExecutor } from "@ducki/shared";
import { loadPlugins, createAgentCapabilities, type LoadedPluginInfo, type AgentCapabilities, type LoadedPluginLLMProvider } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { browserTool, browserFrameEvents } from "@ducki/tools";
import { agentRegistry } from "./agent-registry.js";
import { loadProviderFromSettings, setPluginLLMProviders } from "./provider-settings.js";

type BrowserFrame = NonNullable<AgentCapabilities["browser"]> extends infer B
  ? B extends { getFrame(...args: any[]): Promise<infer F> } ? F : never
  : never;
type BrowserSessionInfo = NonNullable<AgentCapabilities["browser"]> extends infer B
  ? B extends { listSessions(): Promise<Array<infer S>> } ? S : never
  : never;

function unwrapBrowserData(result: Awaited<ReturnType<typeof browserTool.execute>>): Record<string, unknown> {
  if (!result.success) throw new Error(result.error ?? "Browser operation failed");
  return (result.data ?? {}) as Record<string, unknown>;
}

function wireBrowserCapabilities(capabilities: AgentCapabilities): void {
  capabilities.browser = {
    async listSessions(): Promise<BrowserSessionInfo[]> {
      const data = unwrapBrowserData(await browserTool.execute({ action: "list_sessions" }));
      const rows = Array.isArray(data["sessions"]) ? data["sessions"] : [];
      return rows.map((entry) => {
        const row = entry as Record<string, unknown>;
        return {
          sessionId: String(row["sessionId"] ?? row["tabId"] ?? ""),
          url: row["url"] ? String(row["url"]) : undefined,
          title: row["title"] ? String(row["title"]) : undefined,
          launchedAt: row["launchedAt"] ? String(row["launchedAt"]) : undefined,
          isDefault: row["isDefault"] === true,
        };
      }).filter((entry) => entry.sessionId.length > 0) as BrowserSessionInfo[];
    },

    async getFrame(sessionId?: string): Promise<BrowserFrame> {
      const data = unwrapBrowserData(await browserTool.execute({
        action: "screenshot",
        ...(sessionId ? { sessionId } : {}),
        preferLive: true,
        screenshotFormat: "jpeg",
        screenshotQuality: 70,
      }));
      const metadata = (data["metadata"] ?? {}) as Record<string, unknown>;
      const resolvedSessionId = String(data["sessionId"] ?? sessionId ?? "");
      const screenshot = String(data["screenshot"] ?? "");
      if (!resolvedSessionId || !screenshot) throw new Error("Browser returned no frame");
      return {
        sessionId: resolvedSessionId,
        data: screenshot,
        format: String(metadata["format"] ?? "jpeg"),
        timestamp: String(metadata["timestamp"] ?? new Date().toISOString()),
        width: Number(metadata["width"] ?? 0) || undefined,
        height: Number(metadata["height"] ?? 0) || undefined,
      } as BrowserFrame;
    },

    async startStream(sessionId?: string): Promise<string> {
      const data = unwrapBrowserData(await browserTool.execute({ action: "stream_start", ...(sessionId ? { sessionId } : {}) }));
      const resolved = String(data["sessionId"] ?? sessionId ?? "");
      if (!resolved) throw new Error("No browser session available for stream_start");
      return resolved;
    },

    async stopStream(sessionId: string): Promise<void> {
      unwrapBrowserData(await browserTool.execute({ action: "stream_stop", sessionId }));
    },

    subscribeFrames(sessionId: string, handler: (frame: BrowserFrame) => void): () => void {
      const listener = (payload: unknown) => {
        const frame = payload as Record<string, unknown>;
        if (String(frame["sessionId"] ?? "") !== sessionId) return;
        handler({
          sessionId,
          data: String(frame["data"] ?? ""),
          format: String(frame["format"] ?? "jpeg"),
          timestamp: String(frame["timestamp"] ?? new Date().toISOString()),
          width: Number(frame["width"] ?? 0) || undefined,
          height: Number(frame["height"] ?? 0) || undefined,
        } as BrowserFrame);
      };
      browserFrameEvents.on("frame", listener);
      return () => browserFrameEvents.off("frame", listener);
    },
  };
}

export class PluginManager {
  private tools: ToolExecutor[] = [];
  private plugins: LoadedPluginInfo[] = [];
  private llmProviders: LoadedPluginLLMProvider[] = [];
  private pending = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly debounceMs = Number.parseInt(process.env["PLUGIN_RELOAD_DEBOUNCE_MS"] ?? "300", 10);
  private readonly logger = getRootLogger().child("PluginManager");
  private readonly capabilities: AgentCapabilities;

  private constructor(db: DatabaseService) {
    this.capabilities = createAgentCapabilities(db, this.logger, async () => (await loadProviderFromSettings(db)).provider);
    wireBrowserCapabilities(this.capabilities);
    agentRegistry.subscribe((snap) => {
      if (this.pending && snap.runningCount === 0) void this.apply("idle");
    });
  }

  static async create(db: DatabaseService): Promise<PluginManager> {
    const mgr = new PluginManager(db);
    const loaded = await loadPlugins(undefined, mgr.capabilities);
    mgr.tools = loaded.tools;
    mgr.plugins = loaded.plugins;
    mgr.llmProviders = loaded.llmProviders;
    setPluginLLMProviders(mgr.llmProviders);
    return mgr;
  }

  getTools(): ToolExecutor[] { return this.tools; }
  getPlugins(): LoadedPluginInfo[] { return this.plugins; }
  getLLMProviders(): LoadedPluginLLMProvider[] { return this.llmProviders; }

  requestReload(): { applied: boolean; deferred: boolean } {
    if (agentRegistry.snapshot().runningCount === 0) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        if (agentRegistry.snapshot().runningCount === 0) void this.apply("request");
        else this.pending = true;
      }, this.debounceMs);
      return { applied: true, deferred: false };
    }
    this.pending = true;
    this.logger.info("Plugin reload deferred until agents are idle", { runningAgents: agentRegistry.snapshot().runningCount });
    return { applied: false, deferred: true };
  }

  isReloadPending(): boolean { return this.pending; }

  private async apply(reason: string): Promise<void> {
    const loaded = await loadPlugins(undefined, this.capabilities);
    this.tools = loaded.tools;
    this.plugins = loaded.plugins;
    this.llmProviders = loaded.llmProviders;
    setPluginLLMProviders(this.llmProviders);
    this.pending = false;
    this.logger.info("Plugins reloaded", { reason, tools: this.tools.length, plugins: this.plugins.length });
  }
}
