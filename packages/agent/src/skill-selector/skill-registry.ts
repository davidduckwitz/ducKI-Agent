import type { SkillManifest } from "../config/interfaces_types.js";
import { parseFrontmatter, normalizeFrontmatter } from "./frontmatter.js";
import { DEFAULT_SKILL_BUNDLES, SkillBundleManager } from "./skill-bundle.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";


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

      // Try to read SKILL.md for metadata (shared, BOM/CRLF-safe parser)
      let fm = normalizeFrontmatter({});
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf8");
          fm = normalizeFrontmatter(parseFrontmatter(content).data);
        } catch (e) {
          // Ignore frontmatter parse errors, use defaults
        }
      }

      const slug = skillDir.replace(/\s+/g, "-").toLowerCase();
      const defaultName = skillDir
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      const priority =
        fm.priority && ["critical", "high", "medium", "low"].includes(fm.priority)
          ? (fm.priority as "critical" | "high" | "medium" | "low")
          : undefined;

      skills.push({
        slug,
        name: fm.name || defaultName,
        description: fm.description,
        path: skillPath,
        primarySkills: fm.primarySkills ?? [],
        relatedSkills: fm.relatedSkills ?? [],
        fallbackSkills: fm.fallbackSkills ?? [],
        // Hermes Pattern #1: Load additional metadata
        category: fm.category,
        tags: fm.tags,
        scripts: fm.scripts,
        dependencies: fm.dependencies,
        priority,
        // agentskills.io spec fields
        license: fm.license,
        compatibility: fm.compatibility,
        allowedTools: fm.allowedTools,
        version: fm.version,
        metadata: Object.keys(fm.metadata).length ? fm.metadata : undefined,
        // Hermes pattern: conditional activation
        fallbackForToolsets: fm.fallbackForToolsets,
        requiresToolsets: fm.requiresToolsets,
        fallbackForTools: fm.fallbackForTools,
        requiresTools: fm.requiresTools,
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
    { index: 4, slugs: ["cronjobs", "workflow-orchestrator", "tool-orchestration"] },
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
