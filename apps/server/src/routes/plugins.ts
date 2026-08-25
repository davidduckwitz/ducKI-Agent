import { Router, type IRouter } from "express";
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApiResponse, createApiError } from "@ducki/shared";
import type { ToolExecutor } from "@ducki/shared";
import { loadPlugins, setPluginEnabled, pluginsRoot, parsePluginManifest, validatePluginDir, type LoadedPluginInfo } from "@ducki/agent";
import type { CodingAgent, AgentEventEmitter } from "@ducki/agent";
import { isAbortError } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { getPluginSettings, setPluginSetting } from "@ducki/database";
import { agentRegistry } from "../lib/agent-registry.js";
import { registerCodingRun, unregisterCodingRun } from "../lib/coding-run-registry.js";
import {
  PluginBuilderSpecSchema,
  createPluginScaffold,
  describePluginScaffold,
  validateScaffoldIntegrity,
  type PluginBuilderSpec,
  type PluginScaffoldResult,
} from "../lib/plugin-builder.js";

/** Minimal shape of the PluginManager we read off app.locals (avoids a hard type import). */
interface PluginManagerLike {
  requestReload(): { applied: boolean; deferred: boolean };
  getPlugins(): LoadedPluginInfo[];
  getTools(): ToolExecutor[];
}

function pluginManager(req: import("express").Request): PluginManagerLike | undefined {
  return req.app.locals["pluginManager"] as PluginManagerLike | undefined;
}

/** Minimal shape of ConnectorRegistry (apps/server/src/lib/connector-registry.ts) we need here. */
interface ConnectorRegistryLike {
  hasConnector(portal: string): boolean;
  reconnectPortal(portal: string): Promise<{ configured: boolean; active: boolean; lastError?: string }>;
}

function connectorRegistry(req: import("express").Request): ConnectorRegistryLike | undefined {
  return req.app.locals["connectorRegistry"] as ConnectorRegistryLike | undefined;
}

/**
 * Read the CURRENT plugin set. Prefers the cached PluginManager (loaded once, refreshed only on
 * enable/disable/install) so ordinary page/settings/invoke requests don't re-scan every manifest,
 * open plugin DBs and decrypt settings on each call. Falls back to a fresh load only if the
 * manager isn't wired up yet (e.g. very early in startup).
 */
async function currentPlugins(req: import("express").Request): Promise<LoadedPluginInfo[]> {
  const mgr = pluginManager(req);
  return mgr ? mgr.getPlugins() : (await loadPlugins()).plugins;
}

function reloadPlugins(req: import("express").Request): { applied: boolean; deferred: boolean } {
  return pluginManager(req)?.requestReload() ?? { applied: false, deferred: false };
}

/**
 * Plugin management API. File-first: everything is read from the plugins/ directory; the
 * only writes are user enable/disable overrides into plugins/.state.json. No DB rows.
 */
export const pluginsRouter: IRouter = Router();

type PluginBuilderRunStatus = { runId: string; name: string; status: "running" | "completed" | "failed" | "stopped"; error?: string; conversationId?: number; updatedAt: string };
const pluginBuilderRuns = new Map<string, PluginBuilderRunStatus>();

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

pluginsRouter.post("/builder/preview", async (req, res, next) => {
  try {
    const parsed = PluginBuilderSpecSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(createApiError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
      return;
    }
    const scaffold = describePluginScaffold(parsed.data);
    if (scaffold.spec.archetype === "llm-provider") {
      const providerId = scaffold.spec.name.replace(/-provider$/, "");
      const collision = (await currentPlugins(req)).find((plugin) =>
        plugin.llmProviders.some((provider) => provider.id === providerId) && plugin.name !== scaffold.spec.name
      );
      if (collision) {
        res.status(409).json(createApiError(`LLM provider id '${providerId}' is already provided by plugin '${collision.name}'`));
        return;
      }
    }
    res.json(createApiResponse({ spec: scaffold.spec, files: scaffold.files }));
  } catch (error) {
    next(error);
  }
});

pluginsRouter.get("/builder/runs/:runId", (req, res) => {
  const run = pluginBuilderRuns.get(String(req.params.runId ?? ""));
  if (!run) { res.status(404).json(createApiError("Plugin builder run not found")); return; }
  res.json(createApiResponse(run));
});

/** GET /api/plugins - list all plugins with their resolved tools/skills/status. */
pluginsRouter.get("/", async (req, res, next) => {
  try {
    res.json(createApiResponse(await currentPlugins(req)));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plugins/reload - manually re-scan the plugins/ directory. The cached PluginManager
 * (see currentPlugins() above) is only ever refreshed automatically on enable/disable/install
 * through this API, so a plugin folder added directly on disk (e.g. during development, or by
 * an out-of-band deploy step) stays invisible until either a server restart or this endpoint is
 * called. Same hot-reload path as those mutations: applied immediately if no agent is currently
 * running, otherwise deferred until the system goes idle.
 */
pluginsRouter.post("/reload", async (req, res, next) => {
  try {
    const reload = reloadPlugins(req);
    res.json(createApiResponse({ reload }));
  } catch (error) {
    next(error);
  }
});

/** GET /api/plugins/:name - one plugin's info plus its raw manifest. */
pluginsRouter.get("/:name", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) {
      res.status(400).json(createApiError("Invalid plugin name"));
      return;
    }
    const info = (await currentPlugins(req)).find((p) => p.name === name);
    if (!info) {
      res.status(404).json(createApiError("Plugin not found"));
      return;
    }
    const manifestPath = join(pluginsRoot(), name, "plugin.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
    res.json(createApiResponse({ ...info, manifest }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/plugins/:name/enable | /disable - write the override to .state.json. */
function setEnabledRoute(enabled: boolean) {
  return async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    try {
      const name = String(req.params.name ?? "");
      if (!SAFE_NAME.test(name)) {
        res.status(400).json(createApiError("Invalid plugin name"));
        return;
      }
      const exists = (await currentPlugins(req)).some((p) => p.name === name);
      if (!exists) {
        res.status(404).json(createApiError("Plugin not found"));
        return;
      }
      setPluginEnabled(name, enabled);
      // Hot-reload the tool set - applied now if idle, else deferred until no agent is active.
      const reload = reloadPlugins(req);
      res.json(createApiResponse({ name, enabled, reload }));
    } catch (error) {
      next(error);
    }
  };
}
pluginsRouter.post("/:name/enable", setEnabledRoute(true));
pluginsRouter.post("/:name/disable", setEnabledRoute(false));

/**
 * GET /api/plugins/:name/settings - masked settings view (declared keys only; secrets that are
 * set appear as "***", never their value). Drives a plugin's own settings UI.
 */
pluginsRouter.get("/:name/settings", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) {
      res.status(400).json(createApiError("Invalid plugin name"));
      return;
    }
    const info = (await currentPlugins(req)).find((p) => p.name === name);
    if (!info) {
      res.status(404).json(createApiError("Plugin not found"));
      return;
    }
    const values = await getPluginSettings(name, info.settings);
    res.json(createApiResponse({ name, specs: info.settings, values }));
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/plugins/:name/settings - persist one or more declared settings. Secret keys are
 * encrypted at rest; a masked value ("***") is ignored so it never overwrites a stored secret.
 * Applies a hot-reload so the new config reaches the NEXT agent's tools.
 */
pluginsRouter.put("/:name/settings", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) {
      res.status(400).json(createApiError("Invalid plugin name"));
      return;
    }
    const info = (await currentPlugins(req)).find((p) => p.name === name);
    if (!info) {
      res.status(404).json(createApiError("Plugin not found"));
      return;
    }
    const body = (req.body ?? {}) as { values?: Record<string, unknown> };
    const values = body.values ?? {};
    const allowed = new Set(info.settings.map((s) => s.key));
    const unknown = Object.keys(values).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      res.status(400).json(createApiError(`Unknown setting keys: ${unknown.join(", ")}`));
      return;
    }
    for (const [key, value] of Object.entries(values)) {
      await setPluginSetting(name, key, value, info.settings);
    }
    const reload = reloadPlugins(req);

    // Connector plugins (provides.connector): reconnect immediately with the fresh settings so
    // a saved token takes effect without a full server restart.
    let connectorStatus: unknown;
    const portal = info.connector?.portal;
    const registry = connectorRegistry(req);
    if (portal && registry?.hasConnector(portal)) {
      try {
        connectorStatus = await registry.reconnectPortal(portal);
      } catch (error) {
        connectorStatus = { configured: false, active: false, lastError: error instanceof Error ? error.message : String(error) };
      }
    }

    res.json(createApiResponse({ name, saved: Object.keys(values), reload, connectorStatus }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plugins/:name/connector/test - connectivity test for a connector plugin (plan
 * section 8b, the setup-wizard's pendant to hermes' check_<platform>_requirements()). Reconnects
 * the portal with the currently-saved settings and reports whether it came up configured/active.
 */
pluginsRouter.post("/:name/connector/test", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const info = (await currentPlugins(req)).find((p) => p.name === name);
    if (!info) { res.status(404).json(createApiError("Plugin not found")); return; }
    const portal = info.connector?.portal;
    if (!portal) { res.status(400).json(createApiError(`Plugin '${name}' has no provides.connector`)); return; }
    const registry = connectorRegistry(req);
    if (!registry?.hasConnector(portal)) {
      res.status(409).json(createApiError(`Connector '${portal}' is not loaded (plugin disabled or trust != "node"?)`));
      return;
    }
    const status = await registry.reconnectPortal(portal);
    if (!status.configured) {
      res.json(createApiResponse({ ok: false, portal, status, error: "Not configured (missing required settings, e.g. bot token)." }));
      return;
    }
    res.json(createApiResponse({ ok: true, portal, status }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plugins/:name/invoke - run one of a plugin's OWN tools by name and return its
 * result. This gives a plugin's iframe settings UI a data channel to its plugin data (e.g. the
 * notes CRUD page), reusing the exact tool the agent uses. Only tools that belong to the named
 * enabled plugin can be invoked - never another plugin's tool.
 */
pluginsRouter.post("/:name/invoke", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const mgr = pluginManager(req);
    const plugins = mgr ? mgr.getPlugins() : (await loadPlugins()).plugins;
    const info = plugins.find((p) => p.name === name);
    if (!info) { res.status(404).json(createApiError("Plugin not found")); return; }
    if (!info.enabled) { res.status(409).json(createApiError("Plugin is disabled")); return; }

    const body = (req.body ?? {}) as { tool?: string; input?: Record<string, unknown> };
    const toolName = String(body.tool ?? "");
    if (!info.toolNames.includes(toolName)) {
      res.status(400).json(createApiError(`Tool '${toolName}' does not belong to plugin '${name}'`));
      return;
    }
    const tools = mgr ? mgr.getTools() : (await loadPlugins()).tools;
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) { res.status(404).json(createApiError("Tool not available")); return; }

    const exec = await tool.execute(body.input ?? {});
    if (!exec.success) { res.status(400).json(createApiError(exec.error ?? "Tool execution failed")); return; }
    res.json(createApiResponse(exec.data));
  } catch (error) {
    next(error);
  }
});

const UI_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serve a plugin's typed iframe page (Phase 3). `page` is either "settings" (a pure config
 * page, provides.settingsPage) or "frontend" (a mini-app, provides.frontendPage). Serving is
 * confined to that page's own directory with the installer's resolve+relative traversal guard,
 * so nothing outside the page folder - manifest, data/, secrets - can be read. An empty rest
 * path serves the page's index file itself.
 */
async function servePluginPage(
  req: import("express").Request,
  res: import("express").Response,
  page: "settings" | "frontend" | "widget" | "overlay",
  rel: string,
  overridePageRel?: string,
): Promise<void> {
  const name = String(req.params.name ?? "");
  if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
  const info = (await currentPlugins(req)).find((p) => p.name === name);
  const pageRel = overridePageRel ?? (
    page === "settings" ? info?.settingsPage
    : page === "frontend" ? info?.frontendPage
    : page === "overlay" ? info?.overlayPage
    : info?.widgetPage);
  if (!pageRel) { res.status(404).json(createApiError(`Plugin has no ${page} page`)); return; }

  const pluginRoot = resolve(pluginsRoot(), name);
  const pageAbs = resolve(pluginRoot, pageRel);
  const pageWithinPlugin = relative(pluginRoot, pageAbs);
  if (pageWithinPlugin.startsWith("..") || isAbsolute(pageWithinPlugin)) {
    res.status(400).json(createApiError("Plugin page escapes the plugin folder"));
    return;
  }
  const uiRoot = dirname(pageAbs);
  const target = rel ? resolve(uiRoot, rel) : pageAbs;

  const within = relative(uiRoot, target);
  if (within.startsWith("..") || isAbsolute(within)) {
    res.status(400).json(createApiError("Path escapes the UI folder"));
    return;
  }
  if (!existsSync(target)) { res.status(404).json(createApiError("Not found")); return; }

  const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
  res.setHeader("Content-Type", UI_CONTENT_TYPES[ext] ?? "application/octet-stream");
  // Framing: Plugin-UIs müssen von der Web-UI einbettbar sein — same-origin (selfhosted mit
  // Vite-Proxy) UND cross-origin (lokale Setups wie Web-UI auf :8000 -> Agent :3001). Default
  // erlaubt daher 'self' + jede localhost/127.0.0.1-Origin (jeder Port). Zusätzlich die EIGENE
  // Request-Origin (Host-Header) — nötig, wenn der Agent hinter einem HTTPS-Proxy wie Tailscale
  // Serve läuft (die Web-UI liegt dann auf derselben ts.net-Domain, aber 'self' greift durch den
  // Proxy nicht zuverlässig). Ausserdem die Desktop-App (Tauri-WebView): sie framt die Plugin-UI
  // von tauri://localhost (macOS/Linux) bzw. http(s)://tauri.localhost (Windows) aus — diese
  // Origins deckt localhost:* NICHT ab. Ausserdem die gehostete ducki.cloud-Web-UI: BYO-Nutzer
  // verbinden dort ihren lokalen Agenten (http://localhost:3001) — als fester Trusted-Origin
  // hinterlegt, damit das ohne DUCKI_FRAME_ANCESTORS-Konfiguration pro Installation funktioniert.
  // DUCKI_FRAME_ANCESTORS ergänzt weitere Prod-Origins.
  // X-Frame-Options (kann nur SAMEORIGIN) entfernen, sonst blockt es das erlaubte Cross-Origin-Framing.
  const trustedOrigins = "tauri://localhost https://tauri.localhost http://tauri.localhost https://ducki.cloud";
  const selfHost = String(req.headers["host"] ?? "").trim();
  const hostOrigins = /^[a-z0-9.-]+(:\d+)?$/i.test(selfHost) ? ` https://${selfHost} http://${selfHost}` : "";
  const extra = process.env["DUCKI_FRAME_ANCESTORS"] ? ` ${process.env["DUCKI_FRAME_ANCESTORS"]}` : "";
  res.setHeader("Content-Security-Policy", `frame-ancestors 'self' http://localhost:* http://127.0.0.1:* ${trustedOrigins}${hostOrigins}${extra}`);
  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Plugin pages are edited in place and served straight from disk; never let the browser/iframe
  // hold a stale copy (that would hide fresh UI like new buttons after a plugin update).
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  // Stream statt komplettem readFileSync: UI-Dateien können groß sein (Bundles, Assets).
  createReadStream(target).on("error", (err) => {
    console.error(`Error streaming plugin UI file: ${err}`);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  }).pipe(res);
}

function isPageKind(value: string): value is "settings" | "frontend" | "widget" | "overlay" {
  return value === "settings" || value === "frontend" || value === "widget" || value === "overlay";
}

// These routes must precede /:name/ui/:page/*; otherwise Express interprets "widgets" as
// a page kind and the iframe receives the generic "Unknown page kind" JSON response.
pluginsRouter.get("/:name/ui/widgets/:widgetId", async (req, res, next) => {
  try { await servePluginWidget(req, res, ""); } catch (error) { next(error); }
});

pluginsRouter.get("/:name/ui/widgets/:widgetId/*", async (req, res, next) => {
  try { await servePluginWidget(req, res, String((req.params as Record<string, string>)[0] ?? "")); } catch (error) { next(error); }
});

/** GET /api/plugins/:name/ui/:page  - the page's index (settings|frontend). */
pluginsRouter.get("/:name/ui/:page", async (req, res, next) => {
  try {
    const page = String(req.params.page ?? "");
    if (!isPageKind(page)) { res.status(404).json(createApiError("Unknown page kind")); return; }
    await servePluginPage(req, res, page, "");
  } catch (error) { next(error); }
});

/** GET /api/plugins/:name/ui/:page/* - an asset relative to the page's folder. */
pluginsRouter.get("/:name/ui/:page/*", async (req, res, next) => {
  try {
    const page = String(req.params.page ?? "");
    if (!isPageKind(page)) { res.status(404).json(createApiError("Unknown page kind")); return; }
    await servePluginPage(req, res, page, String((req.params as Record<string, string>)[0] ?? ""));
  } catch (error) { next(error); }
});

/**
 * GET /api/plugins/:name/data/* - read-only byte stream of a file under a plugin's own
 * data/ folder, confined the same way servePluginPage() confines UI assets (resolve+relative
 * traversal guard). Plugins that store binary blobs (video, audio, large images) in their
 * plugin-owned storage had no way to get bytes into a <video>/<audio>/<img> tag other than
 * inlining them as base64 in a JSON tool response - fine for a thumbnail, unusable for a
 * multi-MB source video or a rendered export (no seeking/scrubbing, huge JSON payloads). This
 * is generic (not tied to any one plugin) so any plugin with storage.sqlite + a data/ folder
 * of files benefits, not just video-editor. Uses res.sendFile() specifically because it - unlike
 * the manual createReadStream() in servePluginPage() - handles Range requests out of the box,
 * which is what lets a browser <video> element seek/scrub instead of only playing linearly.
 */
pluginsRouter.get("/:name/data/*", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const info = (await currentPlugins(req)).find((p) => p.name === name);
    if (!info) { res.status(404).json(createApiError("Plugin not found")); return; }

    const dataRoot = resolve(pluginsRoot(), name, "data");
    const rel = String((req.params as Record<string, string>)[0] ?? "");
    const target = resolve(dataRoot, rel);
    const within = relative(dataRoot, target);
    if (!rel || within.startsWith("..") || isAbsolute(within)) {
      res.status(400).json(createApiError("Path escapes the plugin's data folder"));
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) { res.status(404).json(createApiError("Not found")); return; }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (error) { next(error); }
});

interface PluginBundle {
  name?: string;
  files?: Array<{ path?: string; content?: string }>;
}

/**
 * POST /api/plugins/install - write a plugin bundle into the plugins/ directory (file-first,
 * no DB). Accepts a bundle `{ name, files: [{ path, content }] }` directly, or `{ url }` to
 * fetch that same JSON shape from the catalog. Paths are strictly confined to the plugin's
 * own folder. After writing, the plugin's manifest must validate; then a hot-reload is
 * requested (applied when idle).
 */
pluginsRouter.post("/install", async (req, res, next) => {
  try {
    const body = req.body as PluginBundle & { url?: string };
    let bundle: PluginBundle = body;
    if (body.url) {
      const fetched = await fetch(body.url);
      if (!fetched.ok) {
        res.status(400).json(createApiError(`Could not fetch bundle: HTTP ${fetched.status}`));
        return;
      }
      bundle = (await fetched.json()) as PluginBundle;
    }

    const name = String(bundle.name ?? "");
    if (!SAFE_NAME.test(name)) {
      res.status(400).json(createApiError("Bundle 'name' must be lowercase-kebab"));
      return;
    }
    if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
      res.status(400).json(createApiError("Bundle 'files' is required"));
      return;
    }

    const pluginDir = resolve(pluginsRoot(), name);
    for (const file of bundle.files) {
      const rel = String(file.path ?? "");
      if (!rel || isAbsolute(rel)) {
        res.status(400).json(createApiError(`Invalid file path: '${rel}'`));
        return;
      }
      const target = resolve(pluginDir, rel);
      const within = relative(pluginDir, target);
      if (within.startsWith("..") || isAbsolute(within)) {
        res.status(400).json(createApiError(`Path escapes plugin folder: '${rel}'`));
        return;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(file.content ?? ""), "utf8");
    }

    // The written manifest must validate, or the install is rejected (files stay for debugging).
    const manifestPath = join(pluginDir, "plugin.json");
    if (!existsSync(manifestPath)) {
      res.status(400).json(createApiError("Bundle did not contain a plugin.json"));
      return;
    }
    const parsed = parsePluginManifest(readFileSync(manifestPath, "utf8"));
    if (!parsed.ok || parsed.manifest?.name !== name) {
      res.status(400).json(createApiError(`Invalid manifest after install: ${parsed.error ?? "name mismatch"}`));
      return;
    }

    const reload = reloadPlugins(req);
    res.json(createApiResponse({ name, installed: true, files: bundle.files.length, reload }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/plugins/validate - validate a manifest string (used by the UI / catalog). */
pluginsRouter.post("/validate", async (req, res, next) => {
  try {
    const body = req.body as { manifest?: unknown };
    const raw = typeof body.manifest === "string" ? body.manifest : JSON.stringify(body.manifest ?? {});
    const result = parsePluginManifest(raw);
    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});

// --- Agent-authored plugin creation ---------------------------------------------------------
//
// Lets the coding agent author a brand-new plugin from a prompt + a few options, under hard
// server-side safety rules (see validatePluginDir / packages/agent/src/plugins/validate-cli.ts):
// no trust:"node", no moduleTools/connector, no oauth/settingsPage/frontendPage/widgetPage/
// overlayPage - backend tools + skills only. The created plugin is always left DISABLED; a
// human must review and enable it via the existing enable/disable endpoints above.

function parseBooleanSetting(value: string | undefined | null, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/** Absolute path to the compiled validate-cli.js, resolved via the @ducki/agent package
 *  resolution itself (workspace-symlink-proof) rather than a guessed relative repo path.
 *  @ducki/agent's package.json only declares an "import" export condition (ESM-only), so this
 *  must use import.meta.resolve - createRequire().resolve() uses CJS "require" resolution and
 *  fails with "No exports main defined" since no "require" condition exists. */
function resolveValidateCliPath(): string {
  const agentEntryUrl = import.meta.resolve("@ducki/agent");
  const agentEntryPath = fileURLToPath(agentEntryUrl);
  return join(dirname(agentEntryPath), "plugins", "validate-cli.js");
}

/**
 * Where an in-progress/failed agent-authored plugin lives WHILE it's being written - a sibling
 * of plugins/, never a subdirectory of it. loadPlugins() scans every directory directly under
 * plugins/ unconditionally (no dotdir/name filtering), so a half-written or rejected attempt
 * left there - as an earlier version of this endpoint did - shows up immediately in the general
 * plugin list with a raw ENOENT/schema error, before anyone reviewed it. Only a directory that
 * passes validatePluginDir gets moved (renameSync) into plugins/<name>/ at all.
 */
function pluginStagingRoot(): string {
  return join(dirname(pluginsRoot()), ".plugin-staging");
}

/** Best-effort cleanup of abandoned staging dirs (failed runs nobody looked at) older than a
 *  day, so repeated failed attempts don't accumulate on disk forever. Never throws. */
function cleanupStalePluginStaging(): void {
  try {
    const root = pluginStagingRoot();
    if (!existsSync(root)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort - one bad entry never blocks the rest.
      }
    }
  } catch {
    // Staging cleanup is opportunistic housekeeping, never a request-blocking concern.
  }
}

function buildPluginCreationGoal(spec: PluginBuilderSpec, scaffold: PluginScaffoldResult): string {
  return [
    `A valid ${spec.archetype} plugin scaffold named "${spec.name}" already exists in the current directory.`,
    `User request: ${spec.userRequest}`,
    spec.targetHint ? `Target API / data source hint: ${spec.targetHint}` : "",
    "",
    `You may edit ONLY these files:\n${scaffold.editableFiles.map((file) => `- ${file}`).join("\n")}`,
    `Never edit these system-owned files:\n${scaffold.lockedFiles.map((file) => `- ${file}`).join("\n")}`,
    "Do not create, rename, or delete files. Read the existing scaffold before editing it.",
    "Fill the TODO placeholders with a concise, working implementation that matches the user request.",
    "Run the provided verify command and fix only editable files when it reports an error.",
  ].filter(Boolean).join("\n");
}

async function servePluginWidget(req: import("express").Request, res: import("express").Response, rel: string): Promise<void> {
  const name = String(req.params.name ?? "");
  const widgetId = String(req.params.widgetId ?? "");
  const info = (await currentPlugins(req)).find((plugin) => plugin.name === name);
  const widget = info?.widgets.find((entry) => entry.id === widgetId);
  if (!widget) { res.status(404).json(createApiError("Plugin widget not found")); return; }
  await servePluginPage(req, res, "widget", rel, widget.page);
}

/** Update only presentation fields of existing widgets; ids and file paths remain manifest-owned. */
pluginsRouter.put("/:name/widgets", async (req, res, next) => {
  try {
    const name = String(req.params.name ?? "");
    if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
    const pluginDir = resolve(pluginsRoot(), name);
    const manifestPath = join(pluginDir, "plugin.json");
    if (!existsSync(manifestPath)) { res.status(404).json(createApiError("Plugin not found")); return; }

    const requested = Array.isArray(req.body?.widgets) ? req.body.widgets as Array<Record<string, unknown>> : null;
    if (!requested) { res.status(400).json(createApiError("widgets must be an array")); return; }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    const current = Array.isArray(manifest.provides?.widgets) ? manifest.provides.widgets as Array<Record<string, unknown>> : [];
    if (requested.length !== current.length) { res.status(400).json(createApiError("Widget count cannot be changed here")); return; }
    const requestedById = new Map(requested.map((widget) => [String(widget.id ?? ""), widget]));
    const editable = ["title", "placement", "align", "frame", "background", "height", "width"] as const;
    const updated = current.map((widget) => {
      const change = requestedById.get(String(widget.id ?? ""));
      if (!change) throw new Error(`Missing widget '${String(widget.id ?? "")}'`);
      const next = { ...widget };
      for (const key of editable) if (key in change) next[key] = change[key];
      return next;
    });
    manifest.provides = { ...manifest.provides, widgets: updated };
    const parsed = parsePluginManifest(JSON.stringify(manifest));
    if (!parsed.ok || !parsed.manifest) { res.status(400).json(createApiError(parsed.error ?? "Invalid plugin manifest")); return; }
    const validated = parsed.manifest;
    const tempPath = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    renameSync(tempPath, manifestPath);
    const reload = reloadPlugins(req);
    res.json(createApiResponse({ name, widgets: validated.provides.widgets ?? [], reload }));
  } catch (error) {
    if (error instanceof Error && (/Missing widget|Invalid plugin manifest/.test(error.message))) {
      res.status(400).json(createApiError(error.message));
      return;
    }
    next(error);
  }
});

pluginsRouter.post("/create-run", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const codingEnabled = parseBooleanSetting(await db.getSetting("CODING_ENABLED"), false);
    const creationEnabled = parseBooleanSetting(await db.getSetting("PLUGIN_CREATION_ENABLED"), false);
    if (!codingEnabled || !creationEnabled) {
      res.status(403).json(createApiError("Plugin creation is disabled"));
      return;
    }

    const createCodingAgent = req.app.locals["createCodingAgent"] as
      | ((options?: { sandboxRoot?: string; maxIterations?: number; eventEmitter?: AgentEventEmitter }) => CodingAgent)
      | undefined;
    if (!createCodingAgent) {
      res.status(500).json(createApiError("Coding agent factory is not configured"));
      return;
    }

    const parsedSpec = PluginBuilderSpecSchema.safeParse(req.body);
    if (!parsedSpec.success) {
      res.status(400).json(createApiError(parsedSpec.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
      return;
    }
    const spec = parsedSpec.data;
    const name = spec.name;
    if (spec.archetype === "llm-provider") {
      const providerId = name.replace(/-provider$/, "");
      const collision = (await currentPlugins(req)).find((plugin) =>
        plugin.llmProviders.some((provider) => provider.id === providerId) && plugin.name !== name
      );
      if (collision) {
        res.status(409).json(createApiError(`LLM provider id '${providerId}' is already provided by plugin '${collision.name}'`));
        return;
      }
    }
    const finalDir = resolve(pluginsRoot(), name);
    if (existsSync(finalDir)) {
      res.status(409).json(createApiError(`A plugin named '${name}' already exists`));
      return;
    }
    cleanupStalePluginStaging();
    const stagingRoot = pluginStagingRoot();
    const stagingDir = join(stagingRoot, name);
    if (existsSync(stagingDir)) {
      res.status(409).json(createApiError(`A previous creation attempt for '${name}' is still on disk (staging) - pick a different name or wait for it to be cleaned up`));
      return;
    }

    const runId = randomUUID();
    const scaffold = createPluginScaffold(stagingDir, spec);
    pluginBuilderRuns.set(runId, { runId, name, status: "running", updatedAt: new Date().toISOString() });
    res.json(createApiResponse({ runId }));

    const io = req.app.locals["io"];
    const emit = (event: string, data: Record<string, unknown>) => {
      if (io) io.emit(event, { runId, ...data });
    };

    void (async () => {
      // Set as soon as the CodingAgent's conversation exists (see onConversationStarted below),
      // so the finally block can always clean up registrations regardless of how the run ends.
      let runConversationId: number | undefined;
      let agentRegistryRunId: string | undefined;
      try {
        const eventEmitter: AgentEventEmitter = {
          emitChunk(chunk: string) {
            emit("plugin_create_chunk", { chunk });
          },
          emitEvent(event: any) {
            emit("plugin_create_event", { type: event.type, message: event.message, data: event.data, timestamp: event.timestamp });
          },
        };

        const codingAgent = createCodingAgent({ sandboxRoot: stagingDir, maxIterations: 40, eventEmitter });
        const goal = buildPluginCreationGoal(spec, scaffold);
        // Points validate-cli at the STAGING root, not pluginsRoot() - it resolves
        // join(pluginsRoot, name) internally, so passing stagingRoot here makes it check
        // stagingDir (= stagingRoot/name), matching where the agent is actually writing.
        const verifyCommand = `node "${resolveValidateCliPath()}" "${stagingRoot}" "${name}"${spec.archetype === "llm-provider" ? " --allow-builder-llm-provider" : ""}${spec.archetype === "widget" ? " --allow-builder-widgets" : ""}`;

        const runResult = await codingAgent.run(goal, {
          verifyCommand,
          maxAttempts: 3,
          timeoutMs: 5 * 60 * 1000,
          // Previously this run was invisible to BOTH the agent registry (so the "still
          // running" snapshot a reconnecting/navigating client gets never listed it - the
          // Stop button just vanished) and the chat:stop handler (so clicking it did nothing
          // anyway). Registering here, the moment the conversation exists, closes both gaps.
          onConversationStarted: (conversationId) => {
            runConversationId = conversationId;
            registerCodingRun(conversationId, codingAgent);
            agentRegistryRunId = agentRegistry.register({
              source: "chat_http",
              conversationId,
              label: `Plugin: ${name}`,
            });
            emit("plugin_create_started", { conversationId });
          },
        });

        // Authoritative re-check, in-process - never trust the agent's own reported "verified".
        const integrityErrors = validateScaffoldIntegrity(stagingDir, scaffold);
        const finalCheck = validatePluginDir(stagingRoot, name, {
          allowBuilderLLMProvider: spec.archetype === "llm-provider",
          allowBuilderWidgets: spec.archetype === "widget",
        });
        if (integrityErrors.length > 0) finalCheck.errors.push(...integrityErrors);
        finalCheck.ok = finalCheck.errors.length === 0;
        if (!finalCheck.ok) {
          // Left in staging (never moved into plugins/), so it's invisible to loadPlugins() -
          // nothing broken ever reaches the general plugin list. Stays on disk for manual
          // inspection until cleanupStalePluginStaging() reclaims it after 24h.
          const error = finalCheck.errors.join("; ");
          pluginBuilderRuns.set(runId, { runId, name, status: "failed", error, conversationId: runResult.conversationId, updatedAt: new Date().toISOString() });
          emit("plugin_create_complete", { success: false, name, error });
          return;
        }

        renameSync(stagingDir, finalDir);
        setPluginEnabled(name, false);
        const reload = reloadPlugins(req);

        // Tag the CodingAgent's own conversation as belonging to this plugin, so continuing
        // it later in the regular chat re-derives the same [CODING_CONTEXT] marker
        // CodingWorkspace uses (proper coding iteration budget + filesystem tool scoped to
        // this plugin's folder, see the sandbox fallback in websocket/index.ts) instead of
        // being misclassified as a tiny-budget lightweight/chatbot run.
        if (runResult.conversationId !== undefined) {
          await db.updateConversation(runResult.conversationId, { pluginContext: name });
        }

        pluginBuilderRuns.set(runId, { runId, name, status: "completed", conversationId: runResult.conversationId, updatedAt: new Date().toISOString() });
        emit("plugin_create_complete", { success: true, name, conversationId: runResult.conversationId, reload });
      } catch (error) {
        if (isAbortError(error)) {
          pluginBuilderRuns.set(runId, { runId, name, status: "stopped", error: "Vom Nutzer gestoppt", updatedAt: new Date().toISOString() });
          emit("plugin_create_complete", { success: false, stopped: true, name, error: "Vom Nutzer gestoppt" });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          pluginBuilderRuns.set(runId, { runId, name, status: "failed", error: message, updatedAt: new Date().toISOString() });
          emit("plugin_create_complete", { success: false, name, error: message });
        }
      } finally {
        if (runConversationId !== undefined) unregisterCodingRun(runConversationId);
        if (agentRegistryRunId !== undefined) agentRegistry.unregister(agentRegistryRunId);
      }
    })();
  } catch (error) {
    next(error);
  }
});
