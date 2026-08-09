import { Router, type IRouter } from "express";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createApiResponse, createApiError } from "@ducki/shared";
import { loadPlugins, setPluginEnabled, pluginsRoot, parsePluginManifest } from "@ducki/agent";

/** Minimal shape of the PluginManager we read off app.locals (avoids a hard type import). */
interface PluginManagerLike {
  requestReload(): { applied: boolean; deferred: boolean };
}

function reloadPlugins(req: import("express").Request): { applied: boolean; deferred: boolean } {
  const mgr = req.app.locals["pluginManager"] as PluginManagerLike | undefined;
  return mgr?.requestReload() ?? { applied: false, deferred: false };
}

/**
 * Plugin management API. File-first: everything is read from the plugins/ directory; the
 * only writes are user enable/disable overrides into plugins/.state.json. No DB rows.
 */
export const pluginsRouter: IRouter = Router();

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /api/plugins - list all plugins with their resolved tools/skills/status. */
pluginsRouter.get("/", async (_req, res, next) => {
  try {
    const loaded = loadPlugins();
    res.json(createApiResponse(loaded.plugins));
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
    const info = loadPlugins().plugins.find((p) => p.name === name);
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
      const exists = loadPlugins().plugins.some((p) => p.name === name);
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
