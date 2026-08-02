import type { SkillManifest } from "../config/interfaces_types.js";
import { DEFAULT_SKILL_BUNDLES, SkillBundleManager } from "./skill-bundle.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse YAML-style frontmatter from SKILL.md
 * Supports: name, description, category, tags, scripts, dependencies, priority
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return result;

  const block = content.slice(3, endIdx).trim();
  const lines = block.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentArray: string[] = [];
  let inScripts = false;
  let inDependencies = false;
  let scripts: Record<string, string> = {};

  for (const line of lines) {
    // Handle indented array items or object properties
    if (line.startsWith("  ") || line.startsWith("\t")) {
      const trimmed = line.trim();

      if (inScripts) {
        // Parse scripts object: key: value
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
          scripts[key] = value;
        }
        continue;
      }

      if (inDependencies && trimmed.startsWith("-")) {
        // Array item
        const item = trimmed.slice(1).trim().replace(/^['"]|['"]$/g, "");
        currentArray.push(item);
        continue;
      }
    }

    // Reset indentation-based parsing
    if (!line.startsWith("  ") && !line.startsWith("\t")) {
      if (currentKey === "tags" && currentArray.length > 0) {
        result.tags = currentArray;
        currentArray = [];
      }
      if (currentKey === "dependencies" && currentArray.length > 0) {
        result.dependencies = currentArray;
        currentArray = [];
      }
      if (currentKey === "primary_skills" && currentArray.length > 0) {
        result.primary_skills = currentArray;
        currentArray = [];
      }
      if (currentKey === "related_skills" && currentArray.length > 0) {
        result.related_skills = currentArray;
        currentArray = [];
      }
      if (currentKey === "fallback_skills" && currentArray.length > 0) {
        result.fallback_skills = currentArray;
        currentArray = [];
      }
      if (currentKey === "scripts") {
        result.scripts = scripts;
        inScripts = false;
        scripts = {};
      }
      currentKey = null;
      inDependencies = false;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    // Simple key: value pairs
    if (value && !value.startsWith("[") && !value.startsWith("{")) {
      result[key] = value.replace(/^['"]|['"]$/g, "");
      currentKey = null;
      inDependencies = false;
      inScripts = false;
    }

    // Handle arrays: key: [item1, item2] or key:\n  - item1
    if (value === "" || value === "[" || value.startsWith("[") || value === "-") {
      currentKey = key;
      currentArray = [];
      inDependencies = (key === "dependencies" || key === "primary_skills" || key === "related_skills" || key === "fallback_skills");
      inScripts = (key === "scripts");

      // Handle inline arrays like "tags: [tag1, tag2]"
      if (value.startsWith("[") && value.includes("]")) {
        const arrayStr = value.slice(1, value.indexOf("]"));
        result[key] = arrayStr.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
        currentKey = null;
        inDependencies = false;
        inScripts = false;
      }
    }
  }

  // Handle remaining array
  if (currentKey === "tags" && currentArray.length > 0) result.tags = currentArray;
  if (currentKey === "dependencies" && currentArray.length > 0) result.dependencies = currentArray;
  if (currentKey === "primary_skills" && currentArray.length > 0) result.primary_skills = currentArray;
  if (currentKey === "related_skills" && currentArray.length > 0) result.related_skills = currentArray;
  if (currentKey === "fallback_skills" && currentArray.length > 0) result.fallback_skills = currentArray;
  if (currentKey === "scripts") result.scripts = scripts;

  return result;
}

/**
 * Dynamically load skills from the skills directory
 */
function loadSkillsFromDirectory(): SkillManifest[] {
  const skills: SkillManifest[] = [];
  const skillsDir = join(process.cwd(), "skills");

  try {
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const skillDir of skillDirs) {
      const skillPath = join(skillsDir, skillDir);
      const skillMdPath = join(skillPath, "SKILL.md");

      // Try to read SKILL.md for metadata
      let frontmatter: Record<string, unknown> = {};
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf8");
          frontmatter = parseFrontmatter(content);
        } catch (e) {
          // Ignore frontmatter parse errors, use defaults
        }
      }

      const slug = skillDir.replace(/\s+/g, "-").toLowerCase();
      const defaultName = skillDir
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      skills.push({
        slug,
        name: (frontmatter.name as string) || defaultName,
        description: (frontmatter.description as string) || undefined,
        path: skillPath,
        primarySkills: (frontmatter.primary_skills as string[]) || [],
        relatedSkills: (frontmatter.related_skills as string[]) || [],
        fallbackSkills: (frontmatter.fallback_skills as string[]) || [],
        // Hermes Pattern #1: Load additional metadata
        category: (frontmatter.category as string) || undefined,
        tags: (frontmatter.tags as string[]) || undefined,
        scripts: (frontmatter.scripts as Record<string, string>) || undefined,
        dependencies: (frontmatter.dependencies as string[]) || undefined,
        priority: (frontmatter.priority as "critical" | "high" | "medium" | "low") || undefined,
      });
    }
  } catch (error) {
    getRootLogger().warn("Could not load skills from directory", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return skills;
}

/**
 * Central registry for available skills in the system
 * Loads skills from the skills directory
 */
export const AVAILABLE_SKILLS: SkillManifest[] = loadSkillsFromDirectory();

/**
 * Populate skill bundles with real skills from the system
 */
export function populateSkillBundles(
  bundles: typeof DEFAULT_SKILL_BUNDLES,
  skillManager?: SkillBundleManager
): typeof DEFAULT_SKILL_BUNDLES {
  const skillMap = new Map(AVAILABLE_SKILLS.map((s) => [s.slug, s]));

  // Helper to safely get skills
  const getSkills = (slugs: (string | undefined)[]): SkillManifest[] => {
    return slugs
      .map((slug) => slug && skillMap.get(slug))
      .filter((skill): skill is SkillManifest => skill !== undefined);
  };

  // Populate bundles
  const bundleConfig = [
    { index: 0, slugs: ["browser-control", "coding-system", "code-review"] },
    { index: 1, slugs: ["coding-system", "test-driven-development", "shared-workspace-api-first", "json-tool-format"] },
    { index: 2, slugs: ["cronjobs", "shared-workspace-ops", "tool-orchestration", "mcp-integration"] },
    { index: 3, slugs: ["history-search", "json-tool-format", "llm-wiki"] },
    { index: 4, slugs: ["cronjobs", "workflow-orchestrator", "tool-orchestration", "discord"] },
    { index: 5, slugs: ["code-review", "test-driven-development", "security-skill"] },
    { index: 6, slugs: ["llm-wiki", "plan", "auto-plan"] },
  ];

  for (const config of bundleConfig) {
    if (config.index < bundles.length) {
      bundles[config.index]!.skills = getSkills(config.slugs);
    }
  }

  return bundles;
}

/**
 * Initialize skill registry with available skills
 */
export class SkillRegistry {
  private logger: Logger;
  private skills: Map<string, SkillManifest> = new Map();
  private bundleManager: SkillBundleManager;

  constructor() {
    this.logger = getRootLogger().child("SkillRegistry");
    this.skills = new Map(AVAILABLE_SKILLS.map((s) => [s.slug, s]));

    // Populate bundles with real skills
    const populatedBundles = populateSkillBundles([...DEFAULT_SKILL_BUNDLES], undefined);
    this.bundleManager = new SkillBundleManager(populatedBundles);

    this.logger.info("Skill registry initialized", {
      totalSkills: this.skills.size,
      totalBundles: populatedBundles.length,
    });
  }

  /**
   * Get all available skills
   */
  getAllSkills(): SkillManifest[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skill by slug
   */
  getSkill(slug: string): SkillManifest | undefined {
    return this.skills.get(slug);
  }

  /**
   * Register additional skill (dynamic)
   */
  registerSkill(skill: SkillManifest): void {
    this.skills.set(skill.slug, skill);
    this.logger.info("Skill registered", { slug: skill.slug });
  }

  /**
   * Update existing skill
   */
  updateSkill(slug: string, updates: Partial<SkillManifest>): void {
    const existing = this.skills.get(slug);
    if (!existing) {
      this.logger.warn("Cannot update non-existent skill", { slug });
      return;
    }

    const updated = { ...existing, ...updates };
    this.skills.set(slug, updated);
    this.logger.info("Skill updated", { slug });
  }

  /**
   * Get bundle manager for skill selection
   */
  getBundleManager(): SkillBundleManager {
    return this.bundleManager;
  }

  /**
   * Hermes Pattern #2: Discover and list skills with optional filtering
   */
  listAllSkills(filter?: { category?: string; tags?: string[] }): SkillManifest[] {
    let filtered = Array.from(this.skills.values());

    if (filter?.category) {
      filtered = filtered.filter((s) => s.category === filter.category);
    }

    if (filter?.tags?.length) {
      filtered = filtered.filter((s) => s.tags?.some((tag) => filter.tags!.includes(tag)));
    }

    return filtered;
  }

  /**
   * Get full metadata for a skill by slug
   */
  getSkillMetadata(slug: string): SkillManifest | undefined {
    return this.skills.get(slug);
  }

  /**
   * Validate that all dependencies for a skill exist in the registry
   */
  validateSkillDependencies(slug: string): { valid: boolean; missing?: string[] } {
    const skill = this.skills.get(slug);
    if (!skill?.dependencies?.length) return { valid: true };

    const missing = skill.dependencies.filter((dep) => !this.skills.has(dep));
    return { valid: missing.length === 0, missing };
  }

  /**
   * Get dependency graph of all skills
   */
  getSkillDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const [slug, skill] of this.skills) {
      graph.set(slug, skill.dependencies || []);
    }

    return graph;
  }

  /**
   * Generate self-documentation manifest (for public API/discovery)
   */
  generateSkillManifest(): { skills: SkillManifest[]; categories: string[]; tags: string[] } {
    const skills = Array.from(this.skills.values());
    const categories = [...new Set(skills.map((s) => s.category).filter(Boolean))] as string[];
    const tags = [...new Set(skills.flatMap((s) => s.tags || []))];

    return { skills, categories, tags };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalSkills: this.skills.size,
      skillsByName: Array.from(this.skills.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ slug: s.slug, name: s.name })),
      bundles: this.bundleManager.getStats(),
    };
  }
}

// Singleton instance
export const skillRegistry = new SkillRegistry();
