import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve } from "node:path";

/**
 * Rejects any path that normalizes to something outside its base directory.
 * Shared by every feature that lets a user point at a file relative to a
 * skill/tool directory (script resolution here, and skill write_file/remove_file).
 */
export function safeRelativePath(filePath: string): string {
  const normalized = normalize(filePath).replace(/^([/\\])+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }
  return normalized;
}

export function frontmatterScript(content: string): string | undefined {
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

export function extractInlineScript(content: string): string | undefined {
  const closedMatch = content.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (closedMatch?.[1]?.trim()) return closedMatch[1].trim();

  const openMatch = content.match(/<script\b[^>]*>([\s\S]*)$/i);
  if (openMatch?.[1]?.trim()) return openMatch[1].trim();
  return undefined;
}

export interface ResolveScriptSourceOptions {
  /** e.g. a caller-supplied `script_file` input - takes priority over everything else when set. */
  explicitRelativePath?: string;
}

export type ResolveScriptSourceResult =
  | { ok: true; source: string; script: string }
  | { ok: false; error: string };

/**
 * Runs the full fallback chain a *.md manifest uses to find its executable script:
 * explicit override -> frontmatter `script:` -> sibling `script.js` -> inline
 * `<script>` block in the body. Shared by skills (skills/<slug>/SKILL.md) and
 * script-backed tools (tools/<name>/TOOL.md) so both read the exact same
 * on-disk convention.
 */
export function resolveScriptSource(
  dir: string,
  content: string,
  opts: ResolveScriptSourceOptions = {}
): ResolveScriptSourceResult {
  try {
    const explicit = opts.explicitRelativePath?.trim();

    if (explicit) {
      const rel = safeRelativePath(explicit);
      const absolute = resolve(dir, rel);
      if (!absolute.startsWith(dir)) return { ok: false, error: "script_file escapes the directory" };
      if (!existsSync(absolute)) return { ok: false, error: `Script file not found: ${rel}` };
      return { ok: true, source: rel, script: readFileSync(absolute, "utf8") };
    }

    const configuredScript = frontmatterScript(content)?.trim();
    if (configuredScript) {
      const rel = safeRelativePath(configuredScript);
      const absolute = resolve(dir, rel);
      if (!absolute.startsWith(dir)) return { ok: false, error: "Configured script escapes the directory" };
      if (!existsSync(absolute)) return { ok: false, error: `Configured script not found: ${rel}` };
      return { ok: true, source: rel, script: readFileSync(absolute, "utf8") };
    }

    const defaultScript = resolve(dir, "script.js");
    if (existsSync(defaultScript)) {
      return { ok: true, source: "script.js", script: readFileSync(defaultScript, "utf8") };
    }

    const inlineScript = extractInlineScript(content);
    if (inlineScript) {
      return { ok: true, source: "inline:<script>", script: inlineScript };
    }

    return {
      ok: false,
      error: "No executable script found. Add <script>...</script>, set frontmatter script, or create script.js",
    };
  } catch (error) {
    // safeRelativePath throws on a path-traversal attempt (e.g. `script: ../../escape.js`) - callers
    // of this function (loadToolManifests iterates every manifest with no per-entry try/catch) expect
    // a graceful result, never an exception, so a bad path in one TOOL.md can't crash the whole scan.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
