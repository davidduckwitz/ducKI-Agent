import type { SkillManifest } from "../config/interfaces_types.js";
import { DEFAULT_SKILL_BUNDLES, SkillBundleManager } from "./skill-bundle.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { readdirSync } from "node:fs";
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
      skills.push({
        slug: skillDir.replace(/\s+/g, "-").toLowerCase(),
        name: skillDir
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
        description: `Skill for ${skillDir}`,
        path: join(skillsDir, skillDir),
        primarySkills: [],
        relatedSkills: [],
        fallbackSkills: [],
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
