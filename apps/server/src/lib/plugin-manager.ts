import type { ToolExecutor } from "@ducki/shared";
import { loadPlugins, type LoadedPluginInfo } from "@ducki/agent";
import { getRootLogger } from "@ducki/logger";
import { agentRegistry } from "./agent-registry.js";

/**
 * Holds the current set of plugin tools and reloads them on enable/disable/install.
 *
 * SAFETY CONTRACT: a reload NEVER interrupts a running agent. Per-request agents capture
 * their tool set at creation time, so swapping this.tools only affects agents created
 * AFTERWARDS. Additionally, a reload is only APPLIED when no agent is active
 * (agentRegistry.runningCount === 0); if agents are busy, it is deferred and applied the
 * moment the system next goes idle (via the agentRegistry subscription).
 */
export class PluginManager {
  private tools: ToolExecutor[] = [];
  private plugins: LoadedPluginInfo[] = [];
  private pending = false;
  private readonly logger = getRootLogger().child("PluginManager");

  private constructor() {
    // Apply any deferred reload as soon as the last active agent finishes.
    agentRegistry.subscribe((snap) => {
      if (this.pending && snap.runningCount === 0) void this.apply("idle");
    });
  }

  /** Async factory - loadPlugins is async (module tools import ESM, settings read from disk). */
  static async create(): Promise<PluginManager> {
    const mgr = new PluginManager();
    const loaded = await loadPlugins();
    mgr.tools = loaded.tools;
    mgr.plugins = loaded.plugins;
    return mgr;
  }

  /** Current unwrapped plugin tools; the agent factory wraps + registers these per request. */
  getTools(): ToolExecutor[] {
    return this.tools;
  }

  getPlugins(): LoadedPluginInfo[] {
    return this.plugins;
  }

  /**
   * Request a reload. Applies immediately if idle, otherwise defers until no agent is
   * active. Returns whether it applied now or was deferred.
   */
  requestReload(): { applied: boolean; deferred: boolean } {
    if (agentRegistry.snapshot().runningCount === 0) {
      void this.apply("request");
      return { applied: true, deferred: false };
    }
    this.pending = true;
    this.logger.info("Plugin reload deferred until agents are idle", {
      runningAgents: agentRegistry.snapshot().runningCount,
    });
    return { applied: false, deferred: true };
  }

  /** Whether a reload is queued (agents currently busy). */
  isReloadPending(): boolean {
    return this.pending;
  }

  private async apply(reason: string): Promise<void> {
    const loaded = await loadPlugins();
    this.tools = loaded.tools;
    this.plugins = loaded.plugins;
    this.pending = false;
    this.logger.info("Plugins reloaded", { reason, tools: this.tools.length, plugins: this.plugins.length });
  }
}
