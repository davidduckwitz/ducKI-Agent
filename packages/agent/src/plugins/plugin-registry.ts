import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { createDataSourceTool, hostAllowed, type DataSourceToolConfig } from "@ducki/tools";
import { runScriptInSandbox } from "@ducki/tools";
import { openPluginDb, getPluginRuntimeConfig, type PluginStorage, type PluginRuntimeConfig } from "@ducki/database";
import { getRootLogger, type Logger } from "@ducki/logger";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePluginManifest, parseOAuthConfig, type PluginManifest, type PluginToolMapping, type PluginSettingSpec, type OAuthConfig } from "./plugin-manifest.js";

/**
 * Runtime context handed to a plugin's async script tools and module tools. Sandboxed sync
 * script tools deliberately do NOT receive this (no secrets, no fetch) - they stay locked to
 * the vm surface. `settings`/`secrets` come from the plugin's own settings store; `fetch` is
 * host-guarded by the manifest's allowedHosts; `logger` is namespaced to the plugin.
 */
export interface PluginToolContext {
  pluginName: string;
  storage?: PluginStorage;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  fetch: typeof fetch;
  logger: Logger;
}

/** Wrap global fetch so a plugin can only reach hosts on its manifest allowlist. */
function guardedFetch(allowedHosts?: string[]): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!hostAllowed(url, allowedHosts)) {
      return Promise.reject(new Error(`Host '${(() => { try { return new URL(url).hostname; } catch { return url; } })()}' not in the plugin's allowedHosts`));
    }
    return fetch(input, init);
  }) as typeof fetch;
}

/** A declarative pet definition a plugin ships (provides.pets), rendered by the host pet runtime. */
export interface PluginPet {
  id: string;
  name: string;
  emoji: string;
  description?: string;
  locomotion: "ground" | "air";
  kind: "svg" | "matrix";
  /** Inline SVG inner markup for kind "svg" (drawn in a 0 0 64 64 box, floor at y=58). */
  art?: string;
  palette?: { primary?: string; secondary?: string; accent?: string; eye?: string };
}

/** One loaded plugin's public info (for the management page / diagnostics). */
export interface LoadedPluginInfo {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  enabled: boolean;
  hasStorage: boolean;
  toolNames: string[];
  skillDirs: string[];
  mappings: PluginToolMapping[];
  settings: PluginSettingSpec[];
  /** Parsed OAuth connector configs (from provides.oauth). */
  oauth: OAuthConfig[];
  /** Relative path to a pure settings page, if the plugin ships one. */
  settingsPage?: string;
  /** Relative path to a frontend (mini-app) page, if the plugin ships one. */
  frontendPage?: string;
  /** Relative path to a widget (small tile) page, if the plugin ships one. */
  widgetPage?: string;
  /** Widget placement ("sidebar" | "dashboard" | "both"). */
  widgetPlacement?: string;
  /** Relative path to an overlay (full-window layer) page, if the plugin ships one. */
  overlayPage?: string;
  /** Declarative pet definitions the plugin ships (provides.pets), rendered by the host pet runtime. */
  pets?: PluginPet[];
  /** Emoji/short icon for UI + sidebar. */
  icon?: string;
  /** Sidebar category ("overview" | "workspace" | "automation" | "knowledge" | "system"). */
  category?: string;
  /** Trust level ("sandboxed" | "node"). */
  trust: string;
  error?: string;
}

/** Aggregate result of loading every plugin, ready to wire into the agent + server. */
export interface PluginLoadResult {
  tools: ToolExecutor[];
  /** Absolute skill directories to merge into the skill registry (progressive disclosure). */
  skillDirs: string[];
  mappings: PluginToolMapping[];
  settings: PluginSettingSpec[];
  plugins: LoadedPluginInfo[];
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

export function pluginsRoot(): string {
  return process.env["DUCKI_PLUGINS_DIR"] ?? resolve(process.cwd(), "plugins");
}

interface DisabledState { disabled?: string[] }

/** Read plugins/.state.json (user enable/disable overrides). Missing/broken => no overrides. */
export function readDisabledState(root = pluginsRoot()): Set<string> {
  const file = join(root, ".state.json");
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DisabledState;
    return new Set(parsed.disabled ?? []);
  } catch {
    return new Set();
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

/**
 * Lightweight scan that returns only the ENABLED plugins' skill directories - without
 * building tools or opening plugin databases. Used by the agent's per-run skill-manifest
 * load so plugin skills join progressive disclosure cheaply and with hot-reload.
 */
export function listPluginSkillDirs(root = pluginsRoot()): string[] {
  if (!existsSync(root)) return [];
  const disabled = readDisabledState(root);
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (disabled.has(name)) continue;
    const manifestPath = join(root, name, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = parsePluginManifest(readFileSync(manifestPath, "utf8"));
      if (!parsed.ok || !parsed.manifest || parsed.manifest.name !== name) continue;
      for (const rel of parsed.manifest.provides.skills ?? []) {
        const skillDir = join(root, name, rel);
        if (existsSync(join(skillDir, "SKILL.md"))) dirs.push(skillDir);
      }
    } catch {
      // skip broken manifest
    }
  }
  return dirs;
}

/** Build a ToolExecutor from a plugin script-tool config. Async tools (with `async:true`)
 *  run in an AsyncFunction and receive the enriched `toolContext` (storage, settings, secrets,
 *  guarded fetch, logger); sync tools reuse the shared vm sandbox with only `{ pluginName }` -
 *  no secrets, no fetch - matching dynamic (tool_factory) tools. */
function buildScriptTool(
  cfg: { name: string; description: string; parameters?: Record<string, unknown>; script: string; async?: boolean },
  ctx: PluginToolContext,
): ToolExecutor {
  return {
    name: cfg.name,
    description: cfg.description,
    definition: { name: cfg.name, description: cfg.description, parameters: cfg.parameters ?? { type: "object", properties: {} } },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (cfg.async) {
          const fn = new AsyncFunction("toolInput", "toolContext", cfg.script);
          const result = await fn(input, ctx);
          return { success: true, data: { result: result ?? null } };
        }
        const executed = runScriptInSandbox(cfg.script, { input, context: { pluginName: ctx.pluginName } }, { inputVar: "toolInput", contextVar: "toolContext" });
        return { success: true, data: { result: executed.result ?? null, logs: executed.logs } };
      } catch (error) {
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Shape a module tool must export. */
interface ModuleToolExports {
  definition?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: PluginToolContext) => Promise<unknown> | unknown;
}

/**
 * Load an ESM module tool (.js/.mjs) from `absPath`. The module runs in the full Node scope
 * and gets the enriched context. Only reached for trust: "node" plugins. Import is cache-busted
 * with a query so a hot-reload picks up edited files.
 */
async function buildModuleTool(absPath: string, ctx: PluginToolContext): Promise<ToolExecutor> {
  const url = `${pathToFileURL(absPath).href}?v=${Date.now()}`;
  const mod = (await import(url)) as ModuleToolExports & { default?: ModuleToolExports };
  const exports = (mod.default && typeof mod.default.execute === "function" ? mod.default : mod) as ModuleToolExports;
  if (typeof exports.execute !== "function") {
    throw new Error(`module tool '${absPath}' must export an execute() function`);
  }
  const name = exports.definition?.name ?? exports.name;
  const description = exports.definition?.description ?? exports.description ?? "";
  if (!name) throw new Error(`module tool '${absPath}' must export a name (via definition.name or name)`);
  const parameters = exports.definition?.parameters ?? exports.parameters ?? { type: "object", properties: {} };

  return {
    name,
    description,
    definition: { name, description, parameters },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await exports.execute(input, ctx);
        return { success: true, data: { result: result ?? null } };
      } catch (error) {
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Auto-generated storage tool for any plugin that opts into `storage.sqlite`. It gives the
 * AGENT a first-class way to read/write the plugin's OWN private database (the same isolated
 * file plugin-storage manages) without the plugin author hand-writing a tool. Scoped strictly
 * to that one plugin's DB - it cannot reach the main database or another plugin's data.
 */
function buildStorageTool(pluginName: string, storage: PluginStorage): ToolExecutor {
  const toolName = `${pluginName.replace(/-/g, "_")}_storage`;
  return {
    name: toolName,
    description:
      `Direktzugriff auf die private SQLite-Datenbank des Plugins '${pluginName}'. ` +
      `actions: query (SELECT, gibt Zeilen), exec (INSERT/UPDATE/DELETE/DDL), ` +
      `kv_get/kv_set/kv_list (einfacher Key-Value-Speicher). 'params' bindet ?-Platzhalter.`,
    definition: {
      name: toolName,
      description: `Private SQLite-DB des Plugins '${pluginName}' lesen/schreiben.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["query", "exec", "kv_get", "kv_set", "kv_list"] },
          sql: { type: "string", description: "SQL für action=query/exec" },
          params: { type: "array", description: "Werte für ?-Platzhalter im SQL" },
          key: { type: "string", description: "Schlüssel für kv_get/kv_set" },
          value: { type: "string", description: "Wert für kv_set" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        const action = String(input["action"] ?? "");
        const params = Array.isArray(input["params"]) ? (input["params"] as unknown[]) : [];
        if (action === "query") {
          const sql = String(input["sql"] ?? "").trim();
          if (!/^\s*select\b/i.test(sql)) return { success: false, data: null, error: "query erlaubt nur SELECT (für Schreibzugriffe action=exec verwenden)" };
          const rows = await storage.query(sql, params);
          return { success: true, data: { result: { count: rows.length, rows } } };
        }
        if (action === "exec") {
          const sql = String(input["sql"] ?? "").trim();
          if (!sql) return { success: false, data: null, error: "sql ist erforderlich für action=exec" };
          await storage.exec(sql, params);
          return { success: true, data: { result: { ok: true } } };
        }
        if (action === "kv_get") {
          const value = await storage.get(String(input["key"] ?? ""));
          return { success: true, data: { result: { value: value ?? null } } };
        }
        if (action === "kv_set") {
          await storage.set(String(input["key"] ?? ""), String(input["value"] ?? ""));
          return { success: true, data: { result: { ok: true } } };
        }
        if (action === "kv_list") {
          const rows = await storage.query("SELECT key, value FROM kv ORDER BY key");
          return { success: true, data: { result: { count: rows.length, entries: rows } } };
        }
        return { success: false, data: null, error: `Unbekannte action: ${action}` };
      } catch (error) {
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

type LoadedPluginInternal = LoadedPluginInfo & { tools: ToolExecutor[] };

/** Load one plugin directory into tools/skills/mappings/settings. Never throws. */
async function loadOnePlugin(root: string, name: string, enabled: boolean): Promise<LoadedPluginInternal> {
  const dir = join(root, name);
  const info: LoadedPluginInternal = {
    name, version: "?", description: "", enabled,
    hasStorage: false, toolNames: [], skillDirs: [], mappings: [], settings: [],
    oauth: [], trust: "sandboxed", tools: [],
  };

  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    info.error = "missing plugin.json";
    return info;
  }
  let manifest: PluginManifest;
  try {
    const parsed = parsePluginManifest(readFileSync(manifestPath, "utf8"));
    if (!parsed.ok || !parsed.manifest) { info.error = parsed.error; return info; }
    manifest = parsed.manifest;
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
    return info;
  }

  info.version = manifest.version;
  info.description = manifest.description;
  info.author = manifest.author;
  info.license = manifest.license;
  info.hasStorage = manifest.storage?.sqlite === true;
  info.mappings = manifest.provides.toolMappings ?? [];
  info.settings = manifest.provides.settings ?? [];
  info.settingsPage = manifest.provides.settingsPage;
  info.frontendPage = manifest.provides.frontendPage;
  info.widgetPage = manifest.provides.widgetPage;
  info.widgetPlacement = manifest.provides.widgetPlacement;
  info.overlayPage = manifest.provides.overlayPage;
  info.icon = manifest.icon;
  info.category = manifest.category;
  info.trust = manifest.trust;

  if (name !== manifest.name) {
    info.error = `manifest name '${manifest.name}' must match directory '${name}'`;
    return info;
  }

  try {
    const storage = manifest.storage?.sqlite ? openPluginDb(manifest.name) : undefined;
    // Decrypted settings/secrets for the runtime context (falls back to defaults). Only read
    // when the plugin declares settings, so a settings-less plugin never gets a data/ folder.
    const runtime: PluginRuntimeConfig = info.settings.length > 0
      ? await getPluginRuntimeConfig(manifest.name, info.settings)
      : { settings: {}, secrets: {} };
    const ctx: PluginToolContext = {
      pluginName: manifest.name,
      storage,
      settings: runtime.settings,
      secrets: runtime.secrets,
      fetch: guardedFetch(manifest.allowedHosts),
      logger: getRootLogger().child(`Plugin:${manifest.name}`),
    };

    // Every plugin with its own DB gets an auto storage tool the agent can call directly.
    if (storage) {
      const dbTool = buildStorageTool(manifest.name, storage);
      info.tools.push(dbTool); info.toolNames.push(dbTool.name);
    }
    for (const rel of manifest.provides.dataSourceTools ?? []) {
      const cfg = readJsonFile(join(dir, rel)) as DataSourceToolConfig;
      const tool = createDataSourceTool(cfg, { settings: runtime.settings, secrets: runtime.secrets });
      info.tools.push(tool); info.toolNames.push(tool.name);
    }
    for (const rel of manifest.provides.scriptTools ?? []) {
      const cfg = readJsonFile(join(dir, rel)) as { name: string; description: string; parameters?: Record<string, unknown>; script: string; async?: boolean };
      const tool = buildScriptTool(cfg, ctx);
      info.tools.push(tool); info.toolNames.push(tool.name);
    }
    const moduleTools = manifest.provides.moduleTools ?? [];
    if (moduleTools.length > 0 && manifest.trust !== "node") {
      throw new Error(`moduleTools require trust: "node" (plugin '${manifest.name}' is '${manifest.trust}')`);
    }
    for (const rel of moduleTools) {
      const tool = await buildModuleTool(join(dir, rel), ctx);
      info.tools.push(tool); info.toolNames.push(tool.name);
    }
    for (const rel of manifest.provides.oauth ?? []) {
      const parsed = parseOAuthConfig(readFileSync(join(dir, rel), "utf8"));
      if (!parsed.ok || !parsed.config) throw new Error(`invalid oauth config '${rel}': ${parsed.error}`);
      info.oauth.push(parsed.config);
    }
    for (const rel of manifest.provides.skills ?? []) {
      const skillDir = join(dir, rel);
      if (existsSync(join(skillDir, "SKILL.md"))) info.skillDirs.push(skillDir);
    }
    if (manifest.provides.pets) {
      const parsed = readJsonFile(join(dir, manifest.provides.pets)) as { pets?: PluginPet[] };
      info.pets = Array.isArray(parsed?.pets) ? parsed.pets : [];
    }
  } catch (error) {
    info.error = `failed to resolve provides: ${error instanceof Error ? error.message : String(error)}`;
  }

  return info;
}

/**
 * Scan the plugins/ directory and load every ENABLED plugin. File-first: the manifest is
 * the source of truth, plugins/.state.json only carries user disable overrides. Returns the
 * combined tools, skill dirs, mappings and settings for the caller to wire in.
 */
export async function loadPlugins(root = pluginsRoot()): Promise<PluginLoadResult> {
  const logger = getRootLogger().child("Plugins");
  const result: PluginLoadResult = { tools: [], skillDirs: [], mappings: [], settings: [], plugins: [] };

  if (!existsSync(root)) return result;
  const disabled = readDisabledState(root);

  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error) {
    logger.warn("Could not read plugins directory", { error: error instanceof Error ? error.message : String(error) });
    return result;
  }

  for (const name of entries) {
    const enabled = !disabled.has(name);
    const { tools, ...info } = await loadOnePlugin(root, name, enabled);
    result.plugins.push(info);
    if (info.error) {
      logger.warn("Plugin skipped", { name, error: info.error });
      continue;
    }
    if (!enabled) continue;
    result.tools.push(...tools);
    result.skillDirs.push(...info.skillDirs);
    result.mappings.push(...info.mappings);
    result.settings.push(...info.settings);
  }

  logger.info("Plugins loaded", {
    total: result.plugins.length,
    enabled: result.plugins.filter((p) => p.enabled && !p.error).length,
    tools: result.tools.length,
    skills: result.skillDirs.length,
  });
  return result;
}
