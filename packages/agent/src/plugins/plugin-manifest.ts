import { z } from "zod";

/**
 * Plugin manifest (plugin.json). A plugin is a FILE-FIRST bundle in plugins/<name>/ that
 * packages data-source tools, script tools, skills, tool mappings and settings - no npm
 * package, no DB row required. The manifest is the single source of truth; enable/disable
 * overrides live in plugins/.state.json so the main database stays small.
 */

const ToolMappingSchema = z.object({
  alias: z.string().min(1),
  tool: z.string().min(1),
});

const SettingSpecSchema = z.object({
  key: z.string().min(1),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  type: z.enum(["string", "number", "boolean", "select"]).optional(),
  description: z.string().optional(),
});

const ProvidesSchema = z.object({
  /** Relative paths to declarative *.datasource.json configs. */
  dataSourceTools: z.array(z.string()).optional(),
  /** Relative paths to script-tool JSON files ({ name, description, parameters, script }). */
  scriptTools: z.array(z.string()).optional(),
  /** Relative paths to skill directories (each containing a SKILL.md). */
  skills: z.array(z.string()).optional(),
  /** Tool name aliases the agent should resolve to a real tool. */
  toolMappings: z.array(ToolMappingSchema).optional(),
  /** Settings keys the plugin introduces (surfaced on the plugin page). */
  settings: z.array(SettingSpecSchema).optional(),
}).default({});

export const PluginManifestSchema = z.object({
  // Lowercase kebab, must match the directory name (agentskills.io convention).
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be lowercase-kebab").max(64),
  version: z.string().min(1),
  description: z.string().min(1).max(1024),
  author: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  provides: ProvidesSchema,
  /** Opt-in per-plugin SQLite database (separate file, own connection). */
  storage: z.object({ sqlite: z.boolean().optional() }).optional(),
  /** Manifest default enabled state; a user override in .state.json wins. */
  enabled: z.boolean().default(true),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginToolMapping = z.infer<typeof ToolMappingSchema>;
export type PluginSettingSpec = z.infer<typeof SettingSpecSchema>;

export interface ParsedManifest {
  ok: boolean;
  manifest?: PluginManifest;
  error?: string;
}

/** Parse + validate a plugin.json string. Never throws - returns a typed result. */
export function parsePluginManifest(raw: string): ParsedManifest {
  let json: unknown;
  try {
    // Strip a UTF-8 BOM the same way the skill frontmatter parser does.
    json = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, error: `plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = PluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, manifest: parsed.data };
}
