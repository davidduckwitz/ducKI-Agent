import type { ToolExecutor, ToolResult } from "@ducki/shared";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { Script, createContext } from "node:vm";

function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return resolve(configured);

  const monorepoCandidate = resolve(process.cwd(), "../../skills");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;

  const cwdLocal = resolve(process.cwd(), "skills");
  if (existsSync(cwdLocal)) return cwdLocal;

  return cwdLocal;
}

const SKILLS_ROOT = resolveSkillsRoot();
const SKILL_FILE = "SKILL.md";

function ensureRoot(): void {
  if (!existsSync(SKILLS_ROOT)) {
    mkdirSync(SKILLS_ROOT, { recursive: true });
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function skillDir(name: string): string {
  return join(SKILLS_ROOT, slugify(name));
}

function skillFile(name: string): string {
  return join(skillDir(name), SKILL_FILE);
}

function safeRelativePath(filePath: string): string {
  const normalized = normalize(filePath).replace(/^([/\\])+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }
  return normalized;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end).trim();
  const lines = block.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

function frontmatterScript(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const block = content.slice(3, end).trim();
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "script") return value;
  }
  return undefined;
}

function extractInlineScript(content: string): string | undefined {
  const closedMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (closedMatch?.[1]?.trim()) return closedMatch[1].trim();

  const openMatch = content.match(/<script\b[^>]*>([\s\S]*)$/i);
  if (openMatch?.[1]?.trim()) return openMatch[1].trim();
  return undefined;
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

function runScriptInSandbox(script: string, runtime?: { input?: unknown; context?: unknown }): { logs: string[]; result: unknown } {
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
    console: { log: logger, info: logger, warn: logger, error: logger },
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
  return {
    logs,
    result: vmScript.runInContext(context, { timeout: 1500 }),
  };
}

function skillNameFromPath(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/").trim();
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\.md$/i);
  if (match?.[1]) return match[1];
  return undefined;
}

function listSkills(): Array<{ slug: string; name: string; description?: string; path: string }> {
  ensureRoot();
  const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  const result: Array<{ slug: string; name: string; description?: string; path: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const path = join(SKILLS_ROOT, slug, SKILL_FILE);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const fm = parseFrontmatter(content);
    result.push({
      slug,
      name: fm.name ?? slug,
      description: fm.description,
      path,
    });
  }

  return result;
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

export const skillsTool: ToolExecutor = {
  name: "skill_manage",
  description: "Manage markdown skills (create, patch, edit, delete, view, list, write_file, remove_file)",
  definition: {
    name: "skill_manage",
    description: "Manage SKILL.md and supporting files under skills directory",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "list_skills", "get_skills", "view", "create", "patch", "edit", "edit_skill", "rename", "delete", "write_file", "remove_file", "execute"],
        },
        name: { type: "string", description: "Skill name/slug" },
        skillName: { type: "string", description: "Legacy skill name/slug" },
        oldSkillName: { type: "string", description: "Legacy skill name for rename operations" },
        newSkillName: { type: "string", description: "New skill name for rename operations" },
        old_name: { type: "string", description: "Legacy skill name for rename operations" },
        new_name: { type: "string", description: "New skill name for rename operations" },
        content: { type: "string", description: "Full SKILL.md content" },
        old_string: { type: "string", description: "String to replace for patch action" },
        new_string: { type: "string", description: "Replacement text for patch action" },
        file_path: { type: "string", description: "Supporting file path relative to skill directory" },
        file_content: { type: "string", description: "Supporting file content" },
        script_file: { type: "string", description: "Optional script file path relative to skill directory for execute action" },
        input: { type: "object", description: "Optional runtime input object available as skillInput in script" },
        context: { type: "object", description: "Optional runtime context object available as skillContext in script" },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const rawAction = String(input["action"] ?? "").toLowerCase();
    const actionAliases: Record<string, string> = {
      get_skills: "list",
      list_skills: "list",
      edit_skill: "rename",
    };
    const action = actionAliases[rawAction] ?? rawAction;
    const name = input["name"] ? String(input["name"]) : input["skillName"] ? String(input["skillName"]) : input["path"] ? skillNameFromPath(String(input["path"])) ?? "" : "";
    const oldSkillName = input["oldSkillName"] ? String(input["oldSkillName"]) : input["old_name"] ? String(input["old_name"]) : "";
    const newSkillName = input["newSkillName"] ? String(input["newSkillName"]) : input["new_name"] ? String(input["new_name"]) : "";

    try {
      ensureRoot();

      switch (action) {
        case "list": {
          return ok(listSkills());
        }

        case "view": {
          if (!name) return fail("name is required");
          const file = skillFile(name);
          if (!existsSync(file)) return fail(`Skill not found: ${name}`);
          return ok({
            name,
            path: file,
            content: readFileSync(file, "utf8"),
          });
        }

        case "create":
        case "edit": {
          if (!name) return fail("name is required");
          const content = String(input["content"] ?? "");
          if (!content) return fail("content is required");

          const dir = skillDir(name);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const file = join(dir, SKILL_FILE);
          writeFileSync(file, content, "utf8");
          return ok({ name: slugify(name), path: file, bytes: content.length, action });
        }

        case "patch": {
          if (!name) return fail("name is required");
          const oldString = String(input["old_string"] ?? "");
          const newString = String(input["new_string"] ?? "");
          if (!oldString) return fail("old_string is required");

          const file = skillFile(name);
          if (!existsSync(file)) return fail(`Skill not found: ${name}`);

          const content = readFileSync(file, "utf8");
          if (!content.includes(oldString)) {
            return fail("old_string not found in SKILL.md");
          }
          const updated = content.replace(oldString, newString);
          writeFileSync(file, updated, "utf8");
          return ok({ name: slugify(name), path: file, replaced: true });
        }

        case "delete": {
          if (!name) return fail("name is required");
          const dir = skillDir(name);
          if (!existsSync(dir)) return fail(`Skill not found: ${name}`);
          rmSync(dir, { recursive: true, force: true });
          return ok({ deleted: true, name: slugify(name) });
        }

        case "rename": {
          const sourceName = oldSkillName || name;
          if (!sourceName) return fail("oldSkillName is required");
          if (!newSkillName) return fail("newSkillName is required");

          const sourceDir = skillDir(sourceName);
          const targetDir = skillDir(newSkillName);
          if (!existsSync(sourceDir)) return fail(`Skill not found: ${sourceName}`);
          if (existsSync(targetDir)) return fail(`Skill already exists: ${newSkillName}`);

          renameSync(sourceDir, targetDir);
          return ok({ renamed: true, from: slugify(sourceName), to: slugify(newSkillName), path: join(targetDir, SKILL_FILE) });
        }

        case "write_file": {
          if (!name) return fail("name is required");
          const rel = input["file_path"] ? String(input["file_path"]) : "";
          if (!rel) return fail("file_path is required");
          const fileContent = String(input["file_content"] ?? "");

          const dir = skillDir(name);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

          const relativePath = safeRelativePath(rel);
          const absolutePath = resolve(dir, relativePath);
          if (!absolutePath.startsWith(dir)) {
            return fail("file_path escapes the skill directory");
          }

          const absoluteDir = dirname(absolutePath);
          if (!existsSync(absoluteDir)) mkdirSync(absoluteDir, { recursive: true });
          writeFileSync(absolutePath, fileContent, "utf8");
          return ok({ name: slugify(name), file_path: relativePath, bytes: fileContent.length });
        }

        case "remove_file": {
          if (!name) return fail("name is required");
          const rel = input["file_path"] ? String(input["file_path"]) : "";
          if (!rel) return fail("file_path is required");

          const dir = skillDir(name);
          if (!existsSync(dir)) return fail(`Skill not found: ${name}`);

          const relativePath = safeRelativePath(rel);
          const absolutePath = resolve(dir, relativePath);
          if (!absolutePath.startsWith(dir)) {
            return fail("file_path escapes the skill directory");
          }
          if (!existsSync(absolutePath)) return fail(`File not found: ${relativePath}`);
          if (statSync(absolutePath).isDirectory()) return fail("remove_file expects a file, not a directory");

          unlinkSync(absolutePath);
          return ok({ name: slugify(name), removed: relativePath });
        }

        case "execute": {
          if (!name) return fail("name is required");
          const dir = skillDir(name);
          const file = skillFile(name);
          if (!existsSync(file)) return fail(`Skill not found: ${name}`);

          const content = readFileSync(file, "utf8");
          const directScriptFile = input["script_file"] ? String(input["script_file"]).trim() : "";
          const runtimeInput = input["input"];
          const runtimeContext = input["context"];

          let source = "";
          let script = "";

          if (directScriptFile) {
            const rel = safeRelativePath(directScriptFile);
            const absolute = resolve(dir, rel);
            if (!absolute.startsWith(dir)) return fail("script_file escapes the skill directory");
            if (!existsSync(absolute)) return fail(`Script file not found: ${rel}`);
            source = rel;
            script = readFileSync(absolute, "utf8");
          } else {
            const configuredScript = frontmatterScript(content)?.trim();
            if (configuredScript) {
              const rel = safeRelativePath(configuredScript);
              const absolute = resolve(dir, rel);
              if (!absolute.startsWith(dir)) return fail("Configured script escapes the skill directory");
              if (!existsSync(absolute)) return fail(`Configured script not found: ${rel}`);
              source = rel;
              script = readFileSync(absolute, "utf8");
            } else {
              const defaultScript = resolve(dir, "script.js");
              if (existsSync(defaultScript)) {
                source = "script.js";
                script = readFileSync(defaultScript, "utf8");
              } else {
                const inlineScript = extractInlineScript(content);
                if (!inlineScript) {
                  return fail("No executable script found. Add <script>...</script>, set frontmatter script, or create script.js");
                }
                source = "inline:<script>";
                script = inlineScript;
              }
            }
          }

          const executed = runScriptInSandbox(script, { input: runtimeInput, context: runtimeContext });
          return ok({
            name: slugify(name),
            executed: true,
            source,
            logs: executed.logs,
            result: executed.result ?? null,
          });
        }

        default:
          return fail(`Unknown action: ${action}`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};