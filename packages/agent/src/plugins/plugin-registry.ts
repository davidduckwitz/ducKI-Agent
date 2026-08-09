import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { createDataSourceTool, type DataSourceToolConfig } from "@ducki/tools";
import { runScriptInSandbox } from "@ducki/tools";
import { openPluginDb, type PluginStorage } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePluginManifest, type PluginManifest, type PluginToolMapping, type PluginSettingSpec } from "./plugin-manifest.js";

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
 *  run in an AsyncFunction and receive `toolContext.storage` (the plugin's own SQLite DB);
 *  sync tools reuse the shared vm sandbox, matching dynamic (tool_factory) tools. */
function buildScriptTool(
  pluginName: string,
  cfg: { name: string; description: string; parameters?: Record<string, unknown>; script: string; async?: boolean },
  storage: PluginStorage | undefined,
): ToolExecutor {
  return {
    name: cfg.name,
    description: cfg.description,
    definition: { name: cfg.name, description: cfg.description, parameters: cfg.parameters ?? { type: "object", properties: {} } },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (cfg.async) {
          const fn = new AsyncFunction("toolInput", "toolContext", cfg.script);
          const result = await fn(input, { pluginName, storage });
          return { success: true, data: { result: result ?? null } };
        }
        const executed = runScriptInSandbox(cfg.script, { input, context: { pluginName } }, { inputVar: "toolInput", contextVar: "toolContext" });
        return { success: true, data: { result: executed.result ?? null, logs: executed.logs } };
      } catch (error) {
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

type LoadedPluginInternal = LoadedPluginInfo & { tools: ToolExecutor[] };

/** Load one plugin directory into tools/skills/mappings/settings. Never throws. */
function loadOnePlugin(root: string, name: string, enabled: boolean): LoadedPluginInternal {
  const dir = join(root, name);
  const info: LoadedPluginInternal = {
    name, version: "?", description: "", enabled,
    hasStorage: false, toolNames: [], skillDirs: [], mappings: [], settings: [], tools: [],
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

  if (name !== manifest.name) {
    info.error = `manifest name '${manifest.name}' must match directory '${name}'`;
    return info;
  }

  try {
    const storage = manifest.storage?.sqlite ? openPluginDb(manifest.name) : undefined;
    for (const rel of manifest.provides.dataSourceTools ?? []) {
      const cfg = readJsonFile(join(dir, rel)) as DataSourceToolConfig;
      const tool = createDataSourceTool(cfg);
      info.tools.push(tool); info.toolNames.push(tool.name);
    }
    for (const rel of manifest.provides.scriptTools ?? []) {
      const cfg = readJsonFile(join(dir, rel)) as { name: string; description: string; parameters?: Record<string, unknown>; script: string; async?: boolean };
      const tool = buildScriptTool(manifest.name, cfg, storage);
      info.tools.push(tool); info.toolNames.push(tool.name);
    }
    for (const rel of manifest.provides.skills ?? []) {
      const skillDir = join(dir, rel);
      if (existsSync(join(skillDir, "SKILL.md"))) info.skillDirs.push(skillDir);
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
export function loadPlugins(root = pluginsRoot()): PluginLoadResult {
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
    const { tools, ...info } = loadOnePlugin(root, name, enabled);
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
