import { Router, type IRouter } from "express";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createApiResponse, createApiError } from "@ducki/shared";
import type { ToolExecutor } from "@ducki/shared";
import { loadPlugins, setPluginEnabled, pluginsRoot, parsePluginManifest, type LoadedPluginInfo } from "@ducki/agent";
import { getPluginSettings, setPluginSetting } from "@ducki/database";

/** Minimal shape of the PluginManager we read off app.locals (avoids a hard type import). */
interface PluginManagerLike {
  requestReload(): { applied: boolean; deferred: boolean };
  getPlugins(): LoadedPluginInfo[];
  getTools(): ToolExecutor[];
}

function pluginManager(req: import("express").Request): PluginManagerLike | undefined {
  return req.app.locals["pluginManager"] as PluginManagerLike | undefined;
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

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /api/plugins - list all plugins with their resolved tools/skills/status. */
pluginsRouter.get("/", async (req, res, next) => {
  try {
    res.json(createApiResponse(await currentPlugins(req)));
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
    res.json(createApiResponse({ name, saved: Object.keys(values), reload }));
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
): Promise<void> {
  const name = String(req.params.name ?? "");
  if (!SAFE_NAME.test(name)) { res.status(400).json(createApiError("Invalid plugin name")); return; }
  const info = (await currentPlugins(req)).find((p) => p.name === name);
  const pageRel =
    page === "settings" ? info?.settingsPage
    : page === "frontend" ? info?.frontendPage
    : page === "overlay" ? info?.overlayPage
    : info?.widgetPage;
  if (!pageRel) { res.status(404).json(createApiError(`Plugin has no ${page} page`)); return; }

  const pageAbs = resolve(pluginsRoot(), name, pageRel);
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
  // erlaubt daher 'self' + jede localhost/127.0.0.1-Origin (jeder Port). DUCKI_FRAME_ANCESTORS
  // ergänzt Prod-Origins (z.B. die gehostete Cloud-UI). X-Frame-Options (kann nur SAMEORIGIN)
  // entfernen, sonst blockt es das erlaubte Cross-Origin-Framing.
  const extra = process.env["DUCKI_FRAME_ANCESTORS"] ? ` ${process.env["DUCKI_FRAME_ANCESTORS"]}` : "";
  res.setHeader("Content-Security-Policy", `frame-ancestors 'self' http://localhost:* http://127.0.0.1:*${extra}`);
  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Plugin pages are edited in place and served straight from disk; never let the browser/iframe
  // hold a stale copy (that would hide fresh UI like new buttons after a plugin update).
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.send(readFileSync(target));
}

function isPageKind(value: string): value is "settings" | "frontend" | "widget" | "overlay" {
  return value === "settings" || value === "frontend" || value === "widget" || value === "overlay";
}

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
