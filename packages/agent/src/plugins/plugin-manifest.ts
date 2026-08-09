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
  // `secret` values are encrypted at rest and never returned in clear text by the API.
  type: z.enum(["string", "number", "boolean", "select", "secret"]).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  /** Allowed values for a `select` setting. */
  options: z.array(z.string()).optional(),
});

const ProvidesSchema = z.object({
  /** Relative paths to declarative *.datasource.json configs. */
  dataSourceTools: z.array(z.string()).optional(),
  /** Relative paths to script-tool JSON files ({ name, description, parameters, script }). */
  scriptTools: z.array(z.string()).optional(),
  /**
   * Relative paths to ESM module tools (.js/.mjs) that run in the full Node scope with the
   * enriched tool context (settings, secrets, guarded fetch, logger). Require trust: "node".
   */
  moduleTools: z.array(z.string()).optional(),
  /** Relative paths to skill directories (each containing a SKILL.md). */
  skills: z.array(z.string()).optional(),
  /** Tool name aliases the agent should resolve to a real tool. */
  toolMappings: z.array(ToolMappingSchema).optional(),
  /** Settings keys the plugin introduces (surfaced on the plugin page). */
  settings: z.array(SettingSpecSchema).optional(),
  /** Relative paths to declarative OAuth2 connector configs (*.oauth.json). */
  oauth: z.array(z.string()).optional(),
  /** Relative path to a PURE settings page (config only), shown on the plugin's detail card. */
  settingsPage: z.string().optional(),
  /** Relative path to a FRONTEND page (a full mini-app). Enabled plugins with a frontend page
   *  get a sidebar entry (name + icon) under their category that opens the page in the content area. */
  frontendPage: z.string().optional(),
  /** Relative path to a WIDGET page (a small HTML tile) rendered inline in the sidebar and/or
   *  on the dashboard for enabled plugins. */
  widgetPage: z.string().optional(),
  /** Where the widget is rendered. Default "dashboard". */
  widgetPlacement: z.enum(["sidebar", "dashboard", "both"]).optional(),
}).default({});

export const PluginManifestSchema = z.object({
  // Lowercase kebab, must match the directory name (agentskills.io convention).
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be lowercase-kebab").max(64),
  version: z.string().min(1),
  description: z.string().min(1).max(1024),
  author: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  /** Emoji (or short string) shown next to the plugin in the UI and sidebar. */
  icon: z.string().max(16).optional(),
  /** Sidebar category a frontend page is grouped under. */
  category: z.enum(["overview", "workspace", "automation", "knowledge", "system"]).optional(),
  provides: ProvidesSchema,
  /** Opt-in per-plugin SQLite database (separate file, own connection). */
  storage: z.object({ sqlite: z.boolean().optional() }).optional(),
  /**
   * Trust level. "sandboxed" (default) only permits declarative data-source tools and
   * vm-sandboxed sync script tools. "node" additionally permits moduleTools (and, in later
   * phases, routes/workers) which run in the full Node scope.
   */
  trust: z.enum(["sandboxed", "node"]).default("sandboxed"),
  /** Optional fetch host allowlist for the plugin's runtime (empty/absent = any host). */
  allowedHosts: z.array(z.string()).optional(),
  /** Manifest default enabled state; a user override in .state.json wins. */
  enabled: z.boolean().default(true),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginToolMapping = z.infer<typeof ToolMappingSchema>;
export type PluginSettingSpec = z.infer<typeof SettingSpecSchema>;

/**
 * A declarative OAuth2 connector config (a *.oauth.json file a plugin ships). The core OAuth
 * route uses this to run the authorization-code flow and store the resulting token as one of
 * the plugin's own secrets - so an authenticated data-source/module tool just reads
 * `secrets.<storeTokenAs>`.
 */
export const OAuthConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "oauth id must be lowercase-kebab"),
  authUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()).default([]),
  /** Plugin setting key holding the OAuth client id (plain). */
  clientIdSetting: z.string().min(1),
  /** Plugin setting key holding the OAuth client secret (secret-typed). */
  clientSecretSetting: z.string().min(1),
  /** Plugin secret key the access token is stored under after the flow. */
  storeTokenAs: z.string().min(1),
  /** Optional plugin secret key for a refresh token, when the provider returns one. */
  storeRefreshTokenAs: z.string().optional(),
  /** Extra query params for the authorize URL (e.g. Google's access_type/prompt). */
  authParams: z.record(z.string()).optional(),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

/** Parse + validate an *.oauth.json string. Never throws. */
export function parseOAuthConfig(raw: string): { ok: boolean; config?: OAuthConfig; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, error: `oauth config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = OAuthConfigSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, config: parsed.data };
}

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
