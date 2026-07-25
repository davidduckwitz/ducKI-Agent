import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveScriptSource } from "@ducki/tools";
import type { ToolExecutor } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import type { DynamicToolResolver } from "../executor/executor";
import { resolveToolAlias, TOOL_ALIAS_TABLE } from "./tool-aliases";

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

/**
 * Unified tool executor registry with caching.
 * Reduces N+1 database queries and provides consistent tool lookup.
 */
export class ToolExecutorRegistry {
  private toolCache = new Map<string, ToolExecutor | null>();
  private manifestCache: ToolManifestEntry[] | null = null;
  private lastManifestCheck = 0;
  private readonly manifestCheckInterval: number;

  constructor(
    private readonly getToolFromExecutor: (name: string) => ToolExecutor | undefined,
    private readonly dynamicResolver: DynamicToolResolver | undefined,
    private readonly logger: Logger,
    private readonly toolsRoot: string = resolveToolsRoot(),
    manifestCheckIntervalMs = 1000
  ) {
    this.manifestCheckInterval = manifestCheckIntervalMs;
  }

  /**
   * Resolve a tool alias to its canonical name.
   */
  resolveAlias(name: string): string {
    return resolveToolAlias(name.trim().toLowerCase());
  }

  /**
   * Get a tool by name (with alias resolution and caching).
   */
  async getByName(name: string): Promise<ToolExecutor | undefined> {
    const canonical = this.resolveAlias(name);

    // Check cache
    if (this.toolCache.has(canonical)) {
      const cached = this.toolCache.get(canonical);
      return cached || undefined;
    }

    // Try in-memory first
    let tool = this.getToolFromExecutor(canonical);
    if (tool) {
      this.toolCache.set(canonical, tool);
      return tool;
    }

    // Try dynamic resolver (DB)
    if (this.dynamicResolver) {
      try {
        tool = await this.dynamicResolver(canonical);
        if (tool) {
          this.toolCache.set(canonical, tool);
          return tool;
        }
      } catch (error) {
        this.logger.warn("Dynamic tool resolver error", {
          toolName: canonical,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Cache negative result to avoid repeated lookups
    this.toolCache.set(canonical, null);
    return undefined;
  }

  /**
   * Get cached tool manifests (with time-based invalidation).
   */
  getManifests(): ToolManifestEntry[] {
    const now = Date.now();
    if (this.manifestCache && now - this.lastManifestCheck < this.manifestCheckInterval) {
      return this.manifestCache;
    }
    this.manifestCache = loadToolManifests(this.toolsRoot);
    this.lastManifestCheck = now;
    return this.manifestCache;
  }

  /**
   * Check if a tool is active/enabled (core tools are always active).
   */
  isToolActive(name: string, enabledOptionalTools: ReadonlySet<string> | readonly string[]): boolean {
    const canonical = this.resolveAlias(name);
    const manifests = this.getManifests();
    return isToolActive(canonical, manifests, enabledOptionalTools);
  }

  /**
   * Clear caches (useful for testing).
   */
  clearCache(): void {
    this.toolCache.clear();
    this.manifestCache = null;
    this.lastManifestCheck = 0;
  }

  /**
   * Get current cache size (for monitoring).
   */
  getCacheSize(): number {
    return this.toolCache.size;
  }
}

/**
 * Factory function to create a ToolExecutorRegistry.
 */
export function createToolExecutorRegistry(
  getToolFromExecutor: (name: string) => ToolExecutor | undefined,
  dynamicResolver: DynamicToolResolver | undefined,
  logger: Logger,
  toolsRoot?: string
): ToolExecutorRegistry {
  return new ToolExecutorRegistry(getToolFromExecutor, dynamicResolver, logger, toolsRoot);
}
