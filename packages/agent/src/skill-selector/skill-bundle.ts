import type { SkillManifest } from "../config/interfaces_types.js";

/**
 * Represents a thematic bundle of related skills
 */
export interface SkillBundle {
  id: string;
  name: string;
  description: string;
  category: "development" | "infrastructure" | "data" | "communication" | "automation" | "analysis" | "custom";
  skills: SkillManifest[];
  tags: string[];
  priority: "critical" | "high" | "medium" | "low";
  minSkillsRequired: number; // Minimum skills needed from this bundle to activate
  maxConcurrent: number; // Max skills from bundle to use simultaneously
  dependencies: string[]; // IDs of other bundles that should be active
}

/**
 * Skill bundle definitions for common use cases
 */
export const DEFAULT_SKILL_BUNDLES: SkillBundle[] = [
  {
    id: "web-development",
    name: "Web Development",
    description: "Skills for web application development and frontend work",
    category: "development",
    skills: [],
    tags: ["frontend", "javascript", "typescript", "react", "html", "css"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "backend-development",
    name: "Backend Development",
    description: "Skills for backend services and API development",
    category: "development",
    skills: [],
    tags: ["backend", "nodejs", "database", "api", "server"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "devops",
    name: "DevOps & Infrastructure",
    description: "Skills for deployment, infrastructure, and monitoring",
    category: "infrastructure",
    skills: [],
    tags: ["docker", "kubernetes", "ci/cd", "deployment", "cloud", "aws", "azure"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Skills for data processing, analysis, and visualization",
    category: "data",
    skills: [],
    tags: ["data", "analysis", "sql", "python", "statistics", "visualization"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "automation",
    name: "Automation & Scripting",
    description: "Skills for task automation and script development",
    category: "automation",
    skills: [],
    tags: ["automation", "scripting", "bash", "shell", "workflow", "robotics"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "code-review",
    name: "Code Quality & Review",
    description: "Skills for code review, testing, and quality assurance",
    category: "analysis",
    skills: [],
    tags: ["testing", "review", "quality", "linting", "debugging"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "documentation",
    name: "Documentation",
    description: "Skills for creating and maintaining documentation",
    category: "communication",
    skills: [],
    tags: ["documentation", "writing", "markdown", "api-docs", "guides"],
    priority: "low",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
];

/**
 * Manages skill bundling and intelligent selection
 *
 * Features:
 * - Group related skills into thematic bundles
 * - Intelligent bundle activation based on user intent
 * - Dependency resolution between bundles
 * - Concurrent skill limitation per bundle
 * - Context-aware skill recommendations
 */
export class SkillBundleManager {
  private bundles: Map<string, SkillBundle> = new Map();
  private skillToBundles: Map<string, string[]> = new Map(); // skill slug -> bundle IDs

  constructor(customBundles?: SkillBundle[]) {
    // Register default bundles
    for (const bundle of DEFAULT_SKILL_BUNDLES) {
      this.registerBundle(bundle);
    }

    // Register custom bundles
    if (customBundles) {
      for (const bundle of customBundles) {
        this.registerBundle(bundle);
      }
    }
  }

  /**
   * Register a skill bundle
   */
  registerBundle(bundle: SkillBundle): void {
    this.bundles.set(bundle.id, bundle);

    // Build skill-to-bundles index
    for (const skill of bundle.skills) {
      if (!this.skillToBundles.has(skill.slug)) {
        this.skillToBundles.set(skill.slug, []);
      }
      this.skillToBundles.get(skill.slug)!.push(bundle.id);
    }
  }

  /**
   * Add skills to a bundle
   */
  addSkillsToBundle(bundleId: string, skills: SkillManifest[]): void {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) return;

    for (const skill of skills) {
      if (!bundle.skills.find(s => s.slug === skill.slug)) {
        bundle.skills.push(skill);

        if (!this.skillToBundles.has(skill.slug)) {
          this.skillToBundles.set(skill.slug, []);
        }
        this.skillToBundles.get(skill.slug)!.push(bundleId);
      }
    }
  }

  /**
   * Get bundle by ID
   */
  getBundle(bundleId: string): SkillBundle | undefined {
    return this.bundles.get(bundleId);
  }

  /**
   * Get all bundles
   */
  getAllBundles(): SkillBundle[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Get bundles that contain a skill
   */
  getBundlesForSkill(skillSlug: string): SkillBundle[] {
    const bundleIds = this.skillToBundles.get(skillSlug) ?? [];
    return bundleIds
      .map(id => this.bundles.get(id))
      .filter((b): b is SkillBundle => !!b);
  }

  /**
   * Find relevant bundles based on user input keywords
   */
  findRelevantBundles(userInput: string, topN: number = 3): SkillBundle[] {
    const inputLower = userInput.toLowerCase();
    const scored: Array<{ bundle: SkillBundle; score: number }> = [];

    for (const bundle of this.bundles.values()) {
      let score = 0;

      // Name match
      if (bundle.name.toLowerCase().includes(inputLower)) score += 10;

      // Description match
      if (bundle.description.toLowerCase().includes(inputLower)) score += 5;

      // Tag matches
      for (const tag of bundle.tags) {
        if (inputLower.includes(tag)) score += 3;
        if (tag.includes(inputLower)) score += 2;
      }

      if (score > 0) {
        scored.push({ bundle, score });
      }
    }

    // Sort by score and return top N
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(s => s.bundle);
  }

  /**
   * Get recommended bundle combinations for task
   */
  getRecommendedBundles(userInput: string): SkillBundle[] {
    const relevant = this.findRelevantBundles(userInput, 5);
    const recommended: SkillBundle[] = [];
    const processed = new Set<string>();

    for (const bundle of relevant) {
      if (processed.has(bundle.id)) continue;
      recommended.push(bundle);
      processed.add(bundle.id);

      // Add dependencies
      for (const depId of bundle.dependencies) {
        const depBundle = this.bundles.get(depId);
        if (depBundle && !processed.has(depId)) {
          recommended.push(depBundle);
          processed.add(depId);
        }
      }
    }

    // Prioritize by importance
    recommended.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    return recommended;
  }

  /**
   * Get conflicting bundles (can't be used together)
   */
  getConflictingBundles(bundleId: string): SkillBundle[] {
    // In this basic implementation, no bundles conflict
    // Override in subclass for custom conflict rules
    return [];
  }

  /**
   * Check if bundle requirements are met
   */
  isBundleReady(bundle: SkillBundle): boolean {
    // Check if minimum skills are available
    return bundle.skills.length >= bundle.minSkillsRequired;
  }

  /**
   * Get bundle statistics
   */
  getStats(): {
    totalBundles: number;
    totalSkills: number;
    bundlesByCategory: Record<string, number>;
    averageSkillsPerBundle: number;
  } {
    const totalBundles = this.bundles.size;
    const allSkills = new Set<string>();
    const bundlesByCategory: Record<string, number> = {};

    let totalSkills = 0;
    for (const bundle of this.bundles.values()) {
      totalSkills += bundle.skills.length;
      for (const skill of bundle.skills) {
        allSkills.add(skill.slug);
      }

      bundlesByCategory[bundle.category] = (bundlesByCategory[bundle.category] ?? 0) + 1;
    }

    return {
      totalBundles,
      totalSkills: allSkills.size,
      bundlesByCategory,
      averageSkillsPerBundle: totalBundles > 0 ? totalSkills / totalBundles : 0,
    };
  }

  /**
   * Get optimal skill subset for a bundle
   * Respects maxConcurrent limit
   */
  getOptimalSkillSubset(bundleId: string): SkillManifest[] {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) return [];

    // Sort by relevance/usage metrics and limit to maxConcurrent
    const sorted = [...bundle.skills].slice(0, bundle.maxConcurrent);
    return sorted;
  }
}
