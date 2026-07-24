import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveScriptSource } from "@ducki/tools";

export interface ToolManifestEntry {
  name: string;
  core: boolean;
  description?: string;
  path: string;
  /** Resolved JS source when the tool's TOOL.md declares (or falls back to) an executable script; absent for metadata-only tools. */
  script?: string;
  /** Whether a successful script run should be interpreted by a one-shot subagent call before returning to the caller. */
  subagent?: boolean;
  subagentMaxTokens?: number;
  /** Body text after the frontmatter block - doubles as the subagent's tool-specific directive when `subagent` is set. */
  instructions?: string;
}

/**
 * Resolves the tools/ root the same way resolveSkillsRoot() in
 * packages/tools/src/skills.ts resolves skills/ - an explicit env override,
 * then the monorepo-root convention, then a local fallback. Kept separate
 * from the skills root since tool manifests are metadata for existing
 * ToolExecutor implementations, not a directory the agent writes into.
 */
function resolveToolsRoot(): string {
  const configured = process.env["TOOLS_PATH"]?.trim();
  if (configured) return resolve(configured);

  const monorepoCandidate = resolve(process.cwd(), "../../tools");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;

  return resolve(process.cwd(), "tools");
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  core?: boolean;
  subagent?: boolean;
  subagentMaxTokens?: number;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end).trim();

  const result: ParsedFrontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
    if (key === "core") result.core = value.toLowerCase() === "true";
    if (key === "subagent") result.subagent = value.toLowerCase() === "true";
    if (key === "subagent_max_tokens") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) result.subagentMaxTokens = parsed;
    }
  }
  return result;
}

/** Body text after the closing frontmatter delimiter, or the whole file when there is no frontmatter block. */
function parseBody(content: string): string {
  if (!content.startsWith("---")) return content.trim();
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content.trim();
  const afterDelimiter = content.indexOf("\n", end + 1);
  return (afterDelimiter < 0 ? "" : content.slice(afterDelimiter + 1)).trim();
}

/**
 * Reads every tools/<name>/TOOL.md manifest. Mirrors Agent.loadSkillManifests()
 * intentionally: same on-disk shape (frontmatter + slug-named directory), same
 * "re-read on every call, no caching" behavior, so editing a TOOL.md's `core`
 * flag takes effect on the next agent run without a restart.
 */
export function loadToolManifests(toolsRoot: string = resolveToolsRoot()): ToolManifestEntry[] {
  if (!existsSync(toolsRoot)) return [];
  const dirs = readdirSync(toolsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const result: ToolManifestEntry[] = [];

  for (const entry of dirs) {
    const slug = entry.name;
    const toolDir = join(toolsRoot, slug);
    const toolPath = join(toolDir, "TOOL.md");
    if (!existsSync(toolPath)) continue;
    const content = readFileSync(toolPath, "utf8");
    const fm = parseFrontmatter(content);
    const resolvedScript = resolveScriptSource(toolDir, content);

    result.push({
      name: fm.name ?? slug,
      core: fm.core === true,
      description: fm.description,
      path: toolPath,
      script: resolvedScript.ok ? resolvedScript.script : undefined,
      subagent: fm.subagent === true,
      subagentMaxTokens: fm.subagentMaxTokens,
      instructions: parseBody(content) || undefined,
    });
  }

  return result;
}

/** Parses the ENABLED_OPTIONAL_TOOLS setting (JSON array of tool names) for bootstrap-time registration filtering. */
export function parseEnabledToolNamesSetting(rawValue: string | undefined | null): string[] {
  if (!rawValue || rawValue.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0 && /^[a-z0-9_-]+$/.test(item));
  } catch {
    return [];
  }
}

export function getCoreToolNames(manifests: ToolManifestEntry[]): Set<string> {
  return new Set(manifests.filter((manifest) => manifest.core).map((manifest) => manifest.name));
}

/**
 * A tool with no TOOL.md manifest (e.g. a runtime-registered dynamic tool
 * from tool_factory, or the tools/ root missing entirely in some deployment)
 * is never gated by this allowlist - it falls back to "active". Dynamic tools
 * already have their own `enabled` column checked by
 * createDynamicToolResolver, and a missing manifest set should never silently
 * disable every built-in tool.
 */
export function isToolActive(
  name: string,
  manifests: ToolManifestEntry[],
  enabledOptionalTools: ReadonlySet<string> | readonly string[]
): boolean {
  const manifest = manifests.find((entry) => entry.name === name);
  if (!manifest) return true;
  if (manifest.core) return true;

  const enabledSet = enabledOptionalTools instanceof Set ? enabledOptionalTools : new Set(enabledOptionalTools);
  return enabledSet.has(name);
}
