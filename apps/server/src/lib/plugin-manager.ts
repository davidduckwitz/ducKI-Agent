import type { ToolExecutor } from "@ducki/shared";
import { loadPlugins, createAgentCapabilities, type LoadedPluginInfo, type AgentCapabilities } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { agentRegistry } from "./agent-registry.js";
import { loadProviderFromSettings } from "./provider-settings.js";

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
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly debounceMs = Number.parseInt(process.env["PLUGIN_RELOAD_DEBOUNCE_MS"] ?? "300", 10);
  private readonly logger = getRootLogger().child("PluginManager");
  private readonly capabilities: AgentCapabilities;

  private constructor(db: DatabaseService) {
    // Lazy, no-cache provider lookup: every capability call re-resolves the CURRENTLY
    // configured provider (see provider-settings.ts) instead of pinning it at construction
    // time, so a settings change takes effect on a plugin's very next capability call without
    // needing a plugin reload.
    this.capabilities = createAgentCapabilities(db, this.logger, async () => (await loadProviderFromSettings(db)).provider);
    // Apply any deferred reload as soon as the last active agent finishes.
    agentRegistry.subscribe((snap) => {
      if (this.pending && snap.runningCount === 0) void this.apply("idle");
    });
  }

  /** Async factory - loadPlugins is async (module tools import ESM, settings read from disk). */
  static async create(db: DatabaseService): Promise<PluginManager> {
    const mgr = new PluginManager(db);
    const loaded = await loadPlugins(undefined, mgr.capabilities);
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
   * Request a reload. Rapid successive requests (enable/disable/settings-save bursts) are
   * COALESCED via a short debounce so we run at most one loadPlugins() per burst instead of one
   * per call. If agents are busy the reload is deferred until the system next goes idle.
   * Returns whether it applied now or was deferred.
   */
  requestReload(): { applied: boolean; deferred: boolean } {
    if (agentRegistry.snapshot().runningCount === 0) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        // Re-check at fire time: never swap the tool set out from under a run that just started.
        if (agentRegistry.snapshot().runningCount === 0) void this.apply("request");
        else this.pending = true;
      }, this.debounceMs);
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
    const loaded = await loadPlugins(undefined, this.capabilities);
    this.tools = loaded.tools;
    this.plugins = loaded.plugins;
    this.pending = false;
    this.logger.info("Plugins reloaded", { reason, tools: this.tools.length, plugins: this.plugins.length });
  }
}
