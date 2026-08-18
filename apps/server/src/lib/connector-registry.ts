import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getRootLogger, type Logger } from "@ducki/logger";
import { openPluginDb, getPluginRuntimeConfig } from "@ducki/database";
import {
  parsePluginManifest,
  pluginsRoot,
  readDisabledState,
  type ConnectorAdapter,
  type ConnectorContext,
  type ConnectorModuleExports,
  type ConnectorStatus,
  type ConnectorCapabilities,
  type ConnectorTarget,
  type OutboundMessage,
  type InboundMessage,
  type ConnectorWebhookRequest,
  type ConnectorWebhookResponse,
} from "@ducki/agent";

/** The generic, portal-neutral address field every connector must normalize onto
 *  (plan section 10.4 - the agent.ts alias normalizer resolves channel/to/target -> channelId). */
const EXPECTED_TARGET_FIELD_NAME = "channelId";

interface LoadedConnector {
  portal: string;
  pluginName: string;
  adapter: ConnectorAdapter;
  connected: boolean;
  /** Retained so reconnectPortal() can rebuild the adapter + context without a full rescan. */
  dir: string;
  connectorDecl: { module: string; portal: string };
  settingsSpecs: Array<{ key: string; type?: string; default?: unknown }>;
  allowedHosts: string[] | undefined;
}

/**
 * Loads every plugin declaring `provides.connector`, connects the ones that are enabled and
 * configured, and owns their lifecycle (boot connect, graceful shutdown disconnect). Generic
 * counterpart to the old Discord-only bootstrapDiscordGatewayBridge() in index.ts.
 *
 * Inbound dispatch: `ctx.onInboundMessage(msg)` is a caller-supplied callback (see index.ts) -
 * this registry is transport-agnostic about how a message reaches the core agent pipeline from
 * there. index.ts wires it to the SAME HTTP loopback POST to /api/gateway/inbound the old
 * Discord-only bootstrap used, rather than a fully in-process call straight into the agent-run
 * pipeline - a deliberate deviation from the plan's suggestion (see index.ts's connector-registry
 * wiring comment and the implementation report's "open risk decisions" section for the reasoning).
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, LoadedConnector>();
  private readonly logger: Logger;

  private constructor(
    private readonly onInboundMessage: (msg: InboundMessage) => Promise<void>,
  ) {
    this.logger = getRootLogger().child("ConnectorRegistry");
  }

  static async create(onInboundMessage: (msg: InboundMessage) => Promise<void>): Promise<ConnectorRegistry> {
    const registry = new ConnectorRegistry(onInboundMessage);
    await registry.loadAndConnectAll();
    return registry;
  }

  /** Scan plugins/, connect every enabled + configured connector plugin. Never throws - a
   *  single broken connector is logged and skipped so it cannot take the whole server down. */
  private async loadAndConnectAll(): Promise<void> {
    const root = pluginsRoot();
    if (!existsSync(root)) return;
    const disabled = readDisabledState(root);

    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (error) {
      this.logger.warn("Could not read plugins directory", { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    for (const name of entries) {
      if (disabled.has(name)) continue;
      const dir = join(root, name);
      const manifestPath = join(dir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        const parsed = parsePluginManifest(readFileSync(manifestPath, "utf8"));
        if (!parsed.ok || !parsed.manifest || parsed.manifest.name !== name) continue;
        manifest = parsed.manifest;
      } catch {
        continue;
      }
      const connectorDecl = manifest.provides.connector;
      if (!connectorDecl) continue;

      if (manifest.trust !== "node") {
        this.logger.warn("Connector plugin skipped: requires trust: \"node\"", { plugin: name, trust: manifest.trust });
        continue;
      }

      try {
        await this.loadOne(dir, name, connectorDecl, manifest.provides.settings ?? [], manifest.allowedHosts);
      } catch (error) {
        this.logger.warn("Connector plugin failed to load", {
          plugin: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async loadOne(
    dir: string,
    pluginName: string,
    connectorDecl: { module: string; portal: string },
    settingsSpecs: Array<{ key: string; type?: string; default?: unknown }>,
    allowedHosts: string[] | undefined,
  ): Promise<void> {
    const modulePath = join(dir, connectorDecl.module);
    const url = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
    const mod = (await import(url)) as ConnectorModuleExports & { default?: ConnectorModuleExports };
    const exports = (mod.default && typeof mod.default.createConnector === "function" ? mod.default : mod) as ConnectorModuleExports;
    if (typeof exports.createConnector !== "function") {
      throw new Error(`connector module '${connectorDecl.module}' must export createConnector()`);
    }

    const adapter = exports.createConnector({ portal: connectorDecl.portal, pluginName });
    const ctx = await this.buildContext(dir, pluginName, connectorDecl, settingsSpecs, allowedHosts);

    const entry: LoadedConnector = {
      portal: connectorDecl.portal, pluginName, adapter, connected: false,
      dir, connectorDecl, settingsSpecs, allowedHosts,
    };
    this.connectors.set(connectorDecl.portal, entry);

    // Boot validation (plan section 10.5): warn (never throw) if the connector's declared
    // target field doesn't match the core alias-normalizer's expected field.
    const capabilities = adapter.getCapabilities?.();
    if (capabilities && capabilities.targetFieldName !== EXPECTED_TARGET_FIELD_NAME) {
      this.logger.warn(
        `Connector '${connectorDecl.portal}' declares unknown target field '${capabilities.targetFieldName}' - expected '${EXPECTED_TARGET_FIELD_NAME}'. The agent's generic field-aliasing only normalizes onto '${EXPECTED_TARGET_FIELD_NAME}'.`,
        { plugin: pluginName, portal: connectorDecl.portal }
      );
    }

    // connect() itself decides whether it has enough settings/secrets to actually open a
    // connection (and sets getStatus().configured accordingly) - it must always be called so
    // ctx (secrets/settings/onInboundMessage) is captured for later send()/handleWebhook() calls
    // even when the live WS/polling connection doesn't start yet.
    try {
      await adapter.connect(ctx);
      entry.connected = true;
      this.logger.info("Connector loaded", {
        plugin: pluginName,
        portal: connectorDecl.portal,
        configured: adapter.getStatus().configured,
      });
    } catch (error) {
      this.logger.warn("Connector connect() failed", {
        plugin: pluginName,
        portal: connectorDecl.portal,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Rebuilds a fresh ConnectorContext (re-reads settings/secrets from the plugin's store). */
  private async buildContext(
    dir: string,
    pluginName: string,
    connectorDecl: { module: string; portal: string },
    settingsSpecs: Array<{ key: string; type?: string; default?: unknown }>,
    allowedHosts: string[] | undefined,
  ): Promise<ConnectorContext> {
    void dir;
    const storage = openPluginDb(pluginName);
    const runtime = settingsSpecs.length > 0
      ? await getPluginRuntimeConfig(pluginName, settingsSpecs as Parameters<typeof getPluginRuntimeConfig>[1])
      : { settings: {}, secrets: {} };

    const guardedFetch: typeof fetch = (async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (allowedHosts && allowedHosts.length > 0) {
        let host: string;
        try { host = new URL(rawUrl).hostname; } catch { host = rawUrl; }
        if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
          throw new Error(`Host '${host}' not in the plugin's allowedHosts`);
        }
      }
      return fetch(input, init);
    }) as typeof fetch;

    return {
      pluginName,
      storage,
      settings: runtime.settings,
      secrets: runtime.secrets,
      fetch: guardedFetch,
      logger: getRootLogger().child(`Connector:${pluginName}`),
      portal: connectorDecl.portal,
      onInboundMessage: this.onInboundMessage,
    };
  }

  /**
   * Re-reads settings and reconnects one portal's connector in place (disconnect the current
   * adapter instance, create a fresh one, connect with freshly-read settings/secrets). Used by
   * the settings-save flow and the `POST /api/plugins/:name/connector/test` endpoint (plan
   * section 8b) so a saved token takes effect without a full server restart.
   */
  async reconnectPortal(portal: string): Promise<ConnectorStatus> {
    const entry = this.connectors.get(portal);
    if (!entry) throw new Error(`No connector registered for portal '${portal}'`);

    if (entry.connected) {
      try { await entry.adapter.disconnect(); } catch { /* best-effort */ }
    }

    const modulePath = join(entry.dir, entry.connectorDecl.module);
    const url = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
    const mod = (await import(url)) as ConnectorModuleExports & { default?: ConnectorModuleExports };
    const exports = (mod.default && typeof mod.default.createConnector === "function" ? mod.default : mod) as ConnectorModuleExports;
    const adapter = exports.createConnector({ portal: entry.connectorDecl.portal, pluginName: entry.pluginName });
    const ctx = await this.buildContext(entry.dir, entry.pluginName, entry.connectorDecl, entry.settingsSpecs, entry.allowedHosts);

    entry.adapter = adapter;
    await adapter.connect(ctx);
    entry.connected = true;
    return adapter.getStatus();
  }

  /** Graceful shutdown: disconnect every connected connector. Never throws. */
  async disconnectAll(): Promise<void> {
    for (const entry of this.connectors.values()) {
      if (!entry.connected) continue;
      try {
        await entry.adapter.disconnect();
      } catch (error) {
        this.logger.warn("Connector disconnect() failed", {
          plugin: entry.pluginName,
          portal: entry.portal,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  getAdapter(portal: string): ConnectorAdapter | undefined {
    return this.connectors.get(portal)?.adapter;
  }

  hasConnector(portal: string): boolean {
    return this.connectors.has(portal);
  }

  /** All portal statuses, e.g. for app.locals["connectorStatuses"]. */
  getStatuses(): Record<string, ConnectorStatus> {
    const out: Record<string, ConnectorStatus> = {};
    for (const [portal, entry] of this.connectors) {
      out[portal] = entry.adapter.getStatus();
    }
    return out;
  }

  getCapabilities(portal: string): ConnectorCapabilities | undefined {
    return this.connectors.get(portal)?.adapter.getCapabilities?.();
  }

  /** List every loaded connector (for the `gateway` tool's list_configs and the UI). */
  list(): Array<{ portal: string; pluginName: string; status: ConnectorStatus; capabilities?: ConnectorCapabilities }> {
    return [...this.connectors.values()].map((entry) => ({
      portal: entry.portal,
      pluginName: entry.pluginName,
      status: entry.adapter.getStatus(),
      capabilities: entry.adapter.getCapabilities?.(),
    }));
  }

  async send(portal: string, target: ConnectorTarget, message: OutboundMessage): Promise<void> {
    const adapter = this.getAdapter(portal);
    if (!adapter) throw new Error(`No connector registered for portal '${portal}'`);
    await adapter.send(target, message);
  }

  async reactToMessage(portal: string, target: ConnectorTarget, messageId: string, emoji: string): Promise<void> {
    const adapter = this.getAdapter(portal);
    if (!adapter?.reactToMessage) return;
    await adapter.reactToMessage(target, messageId, emoji);
  }

  async handleWebhook(portal: string, req: ConnectorWebhookRequest): Promise<ConnectorWebhookResponse | undefined> {
    const adapter = this.getAdapter(portal);
    if (!adapter?.handleWebhook) return undefined;
    return adapter.handleWebhook(req);
  }
}
