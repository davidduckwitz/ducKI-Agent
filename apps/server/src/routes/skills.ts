import { Router, type IRouter } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, basename, relative, sep } from "node:path";
import { Script, createContext } from "node:vm";
import { createApiError, createApiResponse } from "@ducki/shared";
import { skillRegistry, parseFrontmatter, normalizeFrontmatter, validateSkillContent, listPluginSkillDirs, pluginsRoot as resolvePluginsRoot } from "@ducki/agent";
import { installSkillFromSource } from "../lib/skill-install.js";
import { runSkillCommand, SkillRunnerError } from "../lib/skill-runner.js";
import { SkillBuilderSpecSchema, createValidatedSkill, previewSkill } from "../lib/skill-builder.js";
import { skillsRoot as resolveConfiguredSkillsRoot } from "@ducki/shared";

export const skillsRouter: IRouter = Router();

type SkillSource = "builtin" | "plugin";

interface SkillSummary {
  slug: string;
  name: string;
  description?: string;
  source: SkillSource;
  pluginName?: string;
  internal?: boolean;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  script?: string;
  internal?: boolean;
}

interface SkillRuntimePayload {
  input?: unknown;
  context?: unknown;
}

const skillsRoot = resolveConfiguredSkillsRoot();

skillsRouter.post("/builder/preview", (req, res) => {
  const parsed = SkillBuilderSpecSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(createApiError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))); return; }
  res.json(createApiResponse(previewSkill(parsed.data)));
});

skillsRouter.post("/builder/create", async (req, res) => {
  try {
    const db = req.app.locals["db"] as { getSetting(key: string): Promise<string | null | undefined> } | undefined;
    const enabled = (await db?.getSetting("SKILL_CREATION_ENABLED"))?.trim().toLowerCase() === "true";
    if (!enabled) { res.status(403).json(createApiError("Skill creation is disabled")); return; }
    const parsed = SkillBuilderSpecSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(createApiError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))); return; }
    const result = createValidatedSkill(skillsRoot, parsed.data);
    res.status(201).json(createApiResponse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("already exists") ? 409 : 400).json(createApiError(message));
  }
});

function ensureSkillsRoot(): void {
  if (!existsSync(skillsRoot)) {
    mkdirSync(skillsRoot, { recursive: true });
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function safeRelativePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid relative path");
  }
  return normalized;
}

function buildSkillMarkdown(slug: string, title?: string, description?: string, body?: string): string {
  const safeTitle = title?.trim() || slug;
  const safeDescription = description?.trim() || "Skill instructions";
  const contentBody = body?.trim() || [
    `# ${safeTitle}`,
    "",
    "## Zweck",
    "Beschreibe hier klar, wann und wie der Agent diesen Skill verwenden soll.",
    "",
    "## Ablauf",
    "1. Kontext erfassen.",
    "2. Aufgabe in konkrete Schritte zerlegen.",
    "3. Ergebnisse verifizieren.",
  ].join("\n");

  return [
    "---",
    `name: ${slug}`,
    `description: "${safeDescription.replace(/"/g, '\\"')}"`,
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    contentBody,
    "",
  ].join("\n");
}

function readFrontmatter(content: string): SkillFrontmatter {
  const fm = normalizeFrontmatter(parseFrontmatter(content).data);
  return {
    name: fm.name,
    description: fm.description,
    script: fm.script,
    internal: fm.internal === true,
  };
}

function formatValidationError(errors: Array<{ field: string; message: string }>): string {
  const details = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
  return `Skill is not agentskills.io spec-conformant. ${details}`;
}

function extractInlineScript(content: string): string | undefined {
  const closedMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (closedMatch?.[1]?.trim()) return closedMatch[1].trim();

  const openMatch = content.match(/<script\b[^>]*>([\s\S]*)$/i);
  if (openMatch?.[1]?.trim()) return openMatch[1].trim();
  return undefined;
}

function loadSkillScript(skillDir: string, content: string, scriptFile?: string): { source: string; script: string } {
  if (scriptFile) {
    const rel = safeRelativePath(scriptFile);
    const absolute = resolve(skillDir, rel);
    if (!absolute.startsWith(resolve(skillDir))) {
      throw new Error("scriptFile escapes skill directory");
    }
    if (!existsSync(absolute)) {
      throw new Error(`scriptFile not found: ${rel}`);
    }
    return {
      source: rel,
      script: readFileSync(absolute, "utf8"),
    };
  }

  const frontmatter = readFrontmatter(content);
  if (frontmatter.script?.trim()) {
    const rel = safeRelativePath(frontmatter.script.trim());
    const absolute = resolve(skillDir, rel);
    if (!absolute.startsWith(resolve(skillDir))) {
      throw new Error("Frontmatter script path escapes skill directory");
    }
    if (!existsSync(absolute)) {
      throw new Error(`Configured script not found: ${rel}`);
    }
    return {
      source: rel,
      script: readFileSync(absolute, "utf8"),
    };
  }

  const defaultFile = resolve(skillDir, "script.js");
  if (existsSync(defaultFile)) {
    return {
      source: "script.js",
      script: readFileSync(defaultFile, "utf8"),
    };
  }

  const inlineScript = extractInlineScript(content);
  if (inlineScript) {
    return {
      source: "inline:<script>",
      script: inlineScript,
    };
  }

  throw new Error("No executable script found. Add <script>...</script>, set frontmatter 'script', or create script.js");
}

function sanitizeRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    throw new Error("Runtime payload is too deeply nested");
  }
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw new Error("Runtime payload array too large");
    }
    return value.map((item) => sanitizeRuntimeValue(item, depth + 1));
  }
  if (valueType === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length > 200) {
      throw new Error("Runtime payload object too large");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = sanitizeRuntimeValue(source[key], depth + 1);
    }
    return result;
  }

  throw new Error("Runtime payload contains unsupported value type");
}

function runSkillScript(script: string, runtime?: SkillRuntimePayload): { logs: string[]; result: unknown } {
  const logs: string[] = [];
  const logger = (...args: unknown[]) => {
    logs.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ")
    );
  };

  const context = createContext({
    console: {
      log: logger,
      info: logger,
      warn: logger,
      error: logger,
    },
    Date,
    Intl,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    URL,
    URLSearchParams,
    skillInput: sanitizeRuntimeValue(runtime?.input),
    skillContext: sanitizeRuntimeValue(runtime?.context),
  });

  const wrappedScript = `(function () {\n"use strict";\n${script}\n})();`;
  const vmScript = new Script(wrappedScript);
  const result = vmScript.runInContext(context, { timeout: 1500 });
  return { logs, result };
}

interface ResolvedSkillFile {
  skillDir: string;
  skillFile: string;
  source: SkillSource;
  pluginName?: string;
}

/** Same slug-collision rule as the agent's manifest loader: builtin skills win over plugin-bundled ones. */
function resolveSkillFile(slug: string): ResolvedSkillFile | null {
  const builtinDir = join(skillsRoot, slug);
  const builtinFile = join(builtinDir, "SKILL.md");
  if (existsSync(builtinFile)) {
    return { skillDir: builtinDir, skillFile: builtinFile, source: "builtin" };
  }

  const root = resolvePluginsRoot();
  for (const dir of listPluginSkillDirs(root)) {
    if (basename(dir) !== slug) continue;
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const pluginName = relative(root, dir).split(sep)[0];
    return { skillDir: dir, skillFile, source: "plugin", pluginName };
  }

  return null;
}

function listSkills(): SkillSummary[] {
  ensureSkillsRoot();
  const result: SkillSummary[] = [];
  const seen = new Set<string>();

  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const skillFile = join(skillsRoot, slug, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      const frontmatter = readFrontmatter(readFileSync(skillFile, "utf8"));
      result.push({
        slug,
        name: frontmatter.name ?? slug,
        description: frontmatter.description,
        source: "builtin",
        internal: frontmatter.internal === true,
      });
      seen.add(slug);
    }
  }

  const pluginsRootDir = resolvePluginsRoot();
  for (const dir of listPluginSkillDirs(pluginsRootDir)) {
    const slug = basename(dir);
    if (seen.has(slug)) continue; // builtin wins on collision, matches the agent's own manifest merge
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const frontmatter = readFrontmatter(readFileSync(skillFile, "utf8"));
    const pluginName = relative(pluginsRootDir, dir).split(sep)[0];
    result.push({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
      source: "plugin",
      pluginName,
      internal: frontmatter.internal === true,
    });
    seen.add(slug);
  }

  return result;
}

function normalizeSkillSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.includes("github.com") && trimmed.includes("/blob/")) {
    return trimmed.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
  }

  return trimmed;
}

skillsRouter.get("/", (_req, res) => {
  res.json(createApiResponse(listSkills()));
});

skillsRouter.post("/", (req, res) => {
  const body = req.body as { name?: string; slug?: string; description?: string; content?: string };
  const source = (body.slug ?? body.name ?? "").trim();
  if (!source) {
    res.status(400).json(createApiError("name or slug is required"));
    return;
  }

  const slug = slugify(source);
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill name"));
    return;
  }

  ensureSkillsRoot();
  const skillDir = join(skillsRoot, slug);
  const skillFile = join(skillDir, "SKILL.md");
  if (existsSync(skillFile)) {
    res.status(409).json(createApiError("Skill already exists"));
    return;
  }

  const content = body.content?.trim() || buildSkillMarkdown(slug, body.name, body.description);

  // Enforce agentskills.io spec conformance before persisting.
  const validation = validateSkillContent(content, slug);
  if (!validation.valid) {
    res.status(400).json(createApiError(formatValidationError(validation.errors)));
    return;
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, content, "utf8");

  res.status(201).json(createApiResponse({ slug, created: true, warnings: validation.warnings }));
});

skillsRouter.post("/import", async (req, res, next) => {
  try {
    const body = req.body as { url?: string; name?: string; slug?: string; source?: string; ref?: string; overwrite?: boolean };

    // New: folder-level import from a bundle source (catalog / GitHub / tarball URL).
    if (body.source?.trim()) {
      ensureSkillsRoot();
      try {
        const result = await installSkillFromSource({
          source: body.source.trim(),
          ref: body.ref,
          skillsRoot,
          slug: body.slug ? slugify(body.slug) : undefined,
          overwrite: body.overwrite === true,
        });
        res.status(201).json(createApiResponse({ ...result, imported: true }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message === "Skill already exists" ? 409 : 400;
        res.status(status).json(createApiError(message));
      }
      return;
    }

    const url = normalizeSkillSourceUrl(body.url ?? "");
    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json(createApiError("Valid url or source is required"));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "ducki-skills-importer" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      res.status(400).json(createApiError(`Could not download skill: HTTP ${response.status}`));
      return;
    }

    const content = await response.text();
    if (!content || content.trim().length < 20) {
      res.status(400).json(createApiError("Downloaded content is empty or invalid"));
      return;
    }

    const frontmatter = readFrontmatter(content);
    const source = (body.slug ?? body.name ?? frontmatter.name ?? "").trim();
    if (!source) {
      res.status(400).json(createApiError("Skill name could not be inferred from file. Provide name or slug."));
      return;
    }

    const slug = slugify(source);
    if (!slug) {
      res.status(400).json(createApiError("Invalid skill name"));
      return;
    }

    ensureSkillsRoot();
    const skillDir = join(skillsRoot, slug);
    const skillFile = join(skillDir, "SKILL.md");
    if (existsSync(skillFile)) {
      res.status(409).json(createApiError("Skill already exists"));
      return;
    }

    // Enforce agentskills.io spec conformance before persisting.
    const validation = validateSkillContent(content, slug);
    if (!validation.valid) {
      res.status(400).json(createApiError(formatValidationError(validation.errors)));
      return;
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, content, "utf8");

    res.status(201).json(createApiResponse({ slug, imported: true, sourceUrl: url, warnings: validation.warnings }));
  } catch (error) {
    next(error);
  }
});

// Hermes Pattern #2: New discovery/metadata endpoints
// Must be defined BEFORE /:slug routes to match correctly

// POST /api/skills/validate - Validate arbitrary SKILL.md content against the spec
skillsRouter.post("/validate", (req, res) => {
  const { content, slug } = (req.body ?? {}) as { content?: string; slug?: string };
  if (!content || typeof content !== "string") {
    res.status(400).json(createApiError("content is required"));
    return;
  }
  const dirName = slug ? slugify(slug) : undefined;
  const result = validateSkillContent(content, dirName);
  res.json(createApiResponse(result));
});

// --- Catalog proxy (ducki landing catalog) -------------------------------
function catalogApiUrl(): string {
  return (
    process.env["CATALOG_API_URL"]?.trim() ||
    "https://ducki.cloud/api/v1"
  );
}

const catalogCache = new Map<string, { at: number; data: unknown }>();
const CATALOG_TTL_MS = 15 * 60 * 1000;

async function fetchCatalog(action: string, params: Record<string, string>): Promise<unknown> {
  const base = catalogApiUrl();
  const qs = new URLSearchParams({ action, ...params });
  const url = `${base}${base.includes("?") ? "&" : "?"}${qs.toString()}`;

  const cached = catalogCache.get(url);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ducki-catalog-proxy", Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Catalog request failed: HTTP ${res.status}`);
    const json = await res.json();
    catalogCache.set(url, { at: Date.now(), data: json });
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/skills/catalog?q=&category= - Browse the remote skill catalog
skillsRouter.get("/catalog", async (req, res) => {
  try {
    const params: Record<string, string> = {};
    if (req.query.q) params.search = String(req.query.q);
    if (req.query.category) params.category = String(req.query.category);
    const data = await fetchCatalog("skills", params);
    res.json(createApiResponse(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json(createApiError(`Catalog unavailable: ${message}`));
  }
});

// GET /api/skills/catalog/:id - Fetch one catalog entry's detail
skillsRouter.get("/catalog/:id", async (req, res) => {
  try {
    const id = String(req.params["id"] ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      res.status(400).json(createApiError("Invalid catalog id"));
      return;
    }
    const data = await fetchCatalog("skill", { id });
    res.json(createApiResponse(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json(createApiError(`Catalog unavailable: ${message}`));
  }
});

// Endpoint 1: GET /api/skills/discover?category=X&tags=Y,Z - Filter by metadata
skillsRouter.get("/discover", (_req, res) => {
  const category = _req.query.category as string | undefined;
  const tagsParam = _req.query.tags as string | undefined;
  const tags = tagsParam ? tagsParam.split(",").map(t => t.trim()) : undefined;

  const filtered = skillRegistry.listAllSkills({ category, tags });
  res.json(createApiResponse(filtered));
});

// Endpoint 4: GET /api/skills/graph - Get complete dependency graph
skillsRouter.get("/graph", (_req, res) => {
  const graph = skillRegistry.getSkillDependencyGraph();

  // Convert Map to JSON-serializable format
  const skills = Array.from(graph.entries()).map(([slug, dependencies]) => ({
    slug,
    name: skillRegistry.getSkillMetadata(slug)?.name ?? slug,
    dependencies,
  }));

  res.json(createApiResponse({ skills }));
});

// Endpoint 6: GET /api/skills/manifest - Self-documentation manifest
skillsRouter.get("/manifest", (_req, res) => {
  const manifest = skillRegistry.generateSkillManifest();
  res.json(createApiResponse(manifest));
});

// Endpoint 5: POST /api/skills/validate-dependencies - Validate dependency set (batch)
skillsRouter.post("/validate-dependencies", (req, res) => {
  const { skillSlugs } = req.body as { skillSlugs?: string[] };

  if (!Array.isArray(skillSlugs)) {
    res.status(400).json(createApiError("skillSlugs array is required"));
    return;
  }

  const issues: Array<{ slug: string; missing: string[] }> = [];
  let isValid = true;

  for (const slug of skillSlugs) {
    const validation = skillRegistry.validateSkillDependencies(slug);
    if (!validation.valid) {
      isValid = false;
      issues.push({
        slug,
        missing: validation.missing ?? [],
      });
    }
  }

  res.json(createApiResponse({ valid: isValid, issues }));
});

skillsRouter.get("/:slug", (req, res) => {
  const slug = req.params["slug"] ?? "";
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const resolved = resolveSkillFile(slug);
  if (!resolved) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  const content = readFileSync(resolved.skillFile, "utf8");
  const frontmatter = readFrontmatter(content);
  res.json(
    createApiResponse({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
      content,
      source: resolved.source,
      pluginName: resolved.pluginName,
      internal: frontmatter.internal === true,
    })
  );
});

// Endpoint 2: GET /api/skills/:slug/metadata - Get full metadata
skillsRouter.get("/:slug/metadata", (req, res) => {
  const slug = req.params["slug"] ?? "";
  const skill = skillRegistry.getSkillMetadata(slug);

  if (!skill) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  res.json(createApiResponse(skill));
});

// Endpoint 3: GET /api/skills/:slug/dependencies - Get dependency chain
skillsRouter.get("/:slug/dependencies", (req, res) => {
  const slug = req.params["slug"] ?? "";
  const validation = skillRegistry.validateSkillDependencies(slug);

  if (!skillRegistry.getSkillMetadata(slug)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  res.json(createApiResponse(validation));
});

skillsRouter.put("/:slug", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const { content } = req.body as { content?: string };
  if (!content || typeof content !== "string") {
    res.status(400).json(createApiError("content is required"));
    return;
  }

  const resolved = resolveSkillFile(slug);
  if (!resolved) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }
  if (resolved.source === "plugin") {
    res.status(400).json(createApiError("Plugin-Skills werden über die Plugins-Seite verwaltet, nicht hier."));
    return;
  }

  writeFileSync(resolved.skillFile, content, "utf8");
  res.json(createApiResponse({ slug, updated: true }));
});

skillsRouter.patch("/:slug", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const { oldString, newString } = req.body as { oldString?: string; newString?: string };
  if (!oldString || typeof oldString !== "string") {
    res.status(400).json(createApiError("oldString is required"));
    return;
  }

  const resolved = resolveSkillFile(slug);
  if (!resolved) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }
  if (resolved.source === "plugin") {
    res.status(400).json(createApiError("Plugin-Skills werden über die Plugins-Seite verwaltet, nicht hier."));
    return;
  }

  const content = readFileSync(resolved.skillFile, "utf8");
  if (!content.includes(oldString)) {
    res.status(400).json(createApiError("oldString not found"));
    return;
  }

  writeFileSync(resolved.skillFile, content.replace(oldString, newString ?? ""), "utf8");
  res.json(createApiResponse({ slug, patched: true }));
});

skillsRouter.delete("/:slug", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const resolved = resolveSkillFile(slug);
  if (!resolved) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }
  if (resolved.source === "plugin") {
    res.status(400).json(createApiError("Plugin-Skills werden über die Plugins-Seite verwaltet, nicht hier."));
    return;
  }

  rmSync(resolved.skillDir, { recursive: true, force: true });
  res.json(createApiResponse({ slug, deleted: true }));
});

skillsRouter.post("/:slug/execute", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const { scriptFile, input, context } = (req.body ?? {}) as { scriptFile?: string; input?: unknown; context?: unknown };
  const resolved = resolveSkillFile(slug);
  if (!resolved) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  try {
    const content = readFileSync(resolved.skillFile, "utf8");
    const loaded = loadSkillScript(resolved.skillDir, content, scriptFile);
    const executed = runSkillScript(loaded.script, { input, context });

    res.json(
      createApiResponse({
        slug,
        executed: true,
        source: loaded.source,
        logs: executed.logs,
        result: executed.result ?? null,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json(createApiError(message));
  }
});

// POST /api/skills/:slug/run - Run a skill's bundled script as a real subprocess.
// Guarded: disabled unless ALLOW_EXTERNAL_SKILL_SCRIPTS=true; executable allowlist;
// explicit command from the caller (never auto-parsed from SKILL.md).
skillsRouter.post("/:slug/run", async (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }
  const { command, args, timeoutMs, allowNetwork } = (req.body ?? {}) as {
    command?: string;
    args?: unknown;
    timeoutMs?: number;
    allowNetwork?: boolean;
  };

  try {
    const result = await runSkillCommand({
      slug,
      skillsRoot,
      command: String(command ?? ""),
      args: Array.isArray(args) ? args.map((a) => String(a)) : [],
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
      allowNetwork: allowNetwork === true,
    });
    res.json(createApiResponse(result));
  } catch (error) {
    if (error instanceof SkillRunnerError) {
      res.status(error.status).json(createApiError(error.message));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json(createApiError(message));
  }
});
