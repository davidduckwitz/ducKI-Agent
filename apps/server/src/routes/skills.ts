import { Router, type IRouter } from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import { createApiError, createApiResponse } from "@ducki/shared";

export const skillsRouter: IRouter = Router();

interface SkillSummary {
  slug: string;
  name: string;
  description?: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  script?: string;
}

interface SkillRuntimePayload {
  input?: unknown;
  context?: unknown;
}

function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return resolve(configured);

  const monorepoCandidate = resolve(process.cwd(), "../../skills");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;

  const cwdLocal = resolve(process.cwd(), "skills");
  if (existsSync(cwdLocal)) return cwdLocal;

  return cwdLocal;
}

const skillsRoot = resolveSkillsRoot();

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
    `description: \"${safeDescription.replace(/\"/g, '\\"')}\"`,
    "version: 1.0.0",
    "---",
    "",
    contentBody,
    "",
  ].join("\n");
}

function parseFrontmatter(content: string): SkillFrontmatter {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end).trim();
  const result: SkillFrontmatter = {};

  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
    if (key === "script") result.script = value;
  }

  return result;
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

  const frontmatter = parseFrontmatter(content);
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

function listSkills(): SkillSummary[] {
  ensureSkillsRoot();
  if (!existsSync(skillsRoot)) return [];
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  const result: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillFile = join(skillsRoot, slug, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const content = readFileSync(skillFile, "utf8");
    const frontmatter = parseFrontmatter(content);
    result.push({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
    });
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

  mkdirSync(skillDir, { recursive: true });
  const content = body.content?.trim() || buildSkillMarkdown(slug, body.name, body.description);
  writeFileSync(skillFile, content, "utf8");

  res.status(201).json(createApiResponse({ slug, created: true }));
});

skillsRouter.post("/import", async (req, res, next) => {
  try {
    const body = req.body as { url?: string; name?: string; slug?: string };
    const url = normalizeSkillSourceUrl(body.url ?? "");
    if (!url || !/^https?:\/\//i.test(url)) {
      res.status(400).json(createApiError("Valid url is required"));
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

    const frontmatter = parseFrontmatter(content);
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

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, content, "utf8");

    res.status(201).json(createApiResponse({ slug, imported: true, sourceUrl: url }));
  } catch (error) {
    next(error);
  }
});

skillsRouter.get("/:slug", (req, res) => {
  const slug = req.params["slug"] ?? "";
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const skillFile = join(skillsRoot, slug, "SKILL.md");
  if (!existsSync(skillFile)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  const content = readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  res.json(
    createApiResponse({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
      content,
    })
  );
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

  const skillFile = join(skillsRoot, slug, "SKILL.md");
  if (!existsSync(skillFile)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  writeFileSync(skillFile, content, "utf8");
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

  const skillFile = join(skillsRoot, slug, "SKILL.md");
  if (!existsSync(skillFile)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  const content = readFileSync(skillFile, "utf8");
  if (!content.includes(oldString)) {
    res.status(400).json(createApiError("oldString not found"));
    return;
  }

  writeFileSync(skillFile, content.replace(oldString, newString ?? ""), "utf8");
  res.json(createApiResponse({ slug, patched: true }));
});

skillsRouter.delete("/:slug", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const skillDir = join(skillsRoot, slug);
  if (!existsSync(skillDir)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  rmSync(skillDir, { recursive: true, force: true });
  res.json(createApiResponse({ slug, deleted: true }));
});

skillsRouter.post("/:slug/execute", (req, res) => {
  const slug = slugify(req.params["slug"] ?? "");
  if (!slug) {
    res.status(400).json(createApiError("Invalid skill slug"));
    return;
  }

  const { scriptFile, input, context } = (req.body ?? {}) as { scriptFile?: string; input?: unknown; context?: unknown };
  const skillDir = join(skillsRoot, slug);
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    res.status(404).json(createApiError("Skill not found"));
    return;
  }

  try {
    const content = readFileSync(skillFile, "utf8");
    const loaded = loadSkillScript(skillDir, content, scriptFile);
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
