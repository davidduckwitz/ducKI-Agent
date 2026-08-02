import type { SkillManifest, SkillScore } from "../config/interfaces_types.js";
import { SkillBundleManager, type SkillBundle } from "./skill-bundle.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Context for skill selection decision
 */
export interface SelectionContext {
  userInput: string;
  conversationHistory?: string;
  previousSkillsUsed?: string[];
  complexityLevel?: "simple" | "moderate" | "complex";
  taskType?: "development" | "analysis" | "automation" | "communication" | "other";
  timeConstraint?: "immediate" | "reasonable" | "flexible";
}

/**
 * Result of skill selection
 */
export interface SelectionResult {
  selectedSkills: SkillManifest[];
  bundles: SkillBundle[];
  reasoning: string;
  confidence: number; // 0-1
  alternativeSkills?: SkillManifest[];
  // Hermes Pattern #2: Auto-dependency resolution
  directSkills?: SkillManifest[];
  resolvedDependencies?: SkillManifest[];
  dependencyIssues?: string[];
}

/**
 * Advanced skill selection with bundle awareness
 *
 * Features:
 * - Bundle-based skill grouping
 * - Context-aware selection
 * - Intelligent dependency resolution
 * - Performance optimization
 * - Skill conflict detection
 */
export class AdvancedSkillSelector {
  private logger: Logger;
  private bundleManager: SkillBundleManager;
  private availableSkills: Map<string, SkillManifest> = new Map();

  constructor(bundles?: SkillBundle[]) {
    this.logger = getRootLogger().child("AdvancedSkillSelector");
    this.bundleManager = new SkillBundleManager(bundles);
  }

  /**
   * Register available skills
   */
  registerSkills(skills: SkillManifest[]): void {
    for (const skill of skills) {
      this.availableSkills.set(skill.slug, skill);

      // Find matching bundles and add skill to them
      const bundleIds = this.findBundlesForSkill(skill);
      for (const bundleId of bundleIds) {
        this.bundleManager.addSkillsToBundle(bundleId, [skill]);
      }
    }

    this.logger.info("Registered skills", {
      count: skills.length,
      totalAvailable: this.availableSkills.size,
    });
  }

  /**
   * Find bundles that match a skill
   */
  private findBundlesForSkill(skill: SkillManifest): string[] {
    // Match bundles by tags or skill name patterns
    const allBundles = this.bundleManager.getAllBundles();
    const matching: string[] = [];

    for (const bundle of allBundles) {
      for (const tag of bundle.tags) {
        if (skill.slug.includes(tag) || skill.name.toLowerCase().includes(tag)) {
          matching.push(bundle.id);
          break;
        }
      }
    }

    return matching;
  }

  /**
   * Select skills based on context
   */
  selectSkills(context: SelectionContext, topN: number = 5): SelectionResult {
    const startTime = Date.now();

    // Step 1: Find relevant bundles
    const relevantBundles = this.bundleManager.getRecommendedBundles(context.userInput);

    this.logger.debug("Found relevant bundles", {
      input: context.userInput.slice(0, 100),
      bundleCount: relevantBundles.length,
      bundles: relevantBundles.map(b => b.id),
    });

    // Step 2: Collect skills from bundles
    const bundleSkills = new Set<string>();
    for (const bundle of relevantBundles) {
      for (const skill of bundle.skills) {
        bundleSkills.add(skill.slug);
      }
    }

    // Step 3: Score available skills
    const scored = this.scoreSkills(
      Array.from(bundleSkills).map(id => this.availableSkills.get(id)).filter((s): s is SkillManifest => !!s),
      context
    );

    // Step 4: Filter by bundle constraints
    const selected = this.filterByBundleConstraints(scored, relevantBundles, topN);

    // Step 5: Resolve full dependency closure (Hermes Pattern #2)
    const { resolved: withDeps, issues: depIssues } = this.resolveFullDependencies(selected);

    const elapsed = Date.now() - startTime;

    // Add reasoning about dependency resolution
    let reasoning = this.generateReasoning(withDeps, relevantBundles, context);
    if (withDeps.length > selected.length) {
      const addedCount = withDeps.length - selected.length;
      reasoning += `. Auto-included ${addedCount} dependent skill(s).`;
    }
    if (depIssues.length > 0) {
      reasoning += ` [Warnings: ${depIssues.join("; ")}]`;
    }

    const result: SelectionResult = {
      selectedSkills: withDeps,
      bundles: relevantBundles.filter(b => b.skills.some(s => withDeps.some(sel => sel.slug === s.slug))),
      reasoning,
      confidence: this.calculateConfidence(scored.slice(0, topN), context),
      alternativeSkills: scored.slice(topN, topN + 3).map(s => s.skill),
      // Hermes Pattern #2: Track direct vs resolved dependencies
      directSkills: selected,
      resolvedDependencies: withDeps.filter(s => !selected.some(sel => sel.slug === s.slug)),
      dependencyIssues: depIssues.length > 0 ? depIssues : undefined,
    };

    this.logger.info("Skill selection complete", {
      selectedCount: withDeps.length,
      bundleCount: result.bundles.length,
      confidence: result.confidence,
      elapsedMs: elapsed,
    });

    return result;
  }

  /**
   * Score skills based on context
   */
  private scoreSkills(skills: SkillManifest[], context: SelectionContext): Array<{ skill: SkillManifest; scoreValue: number }> {
    const scored: Array<{ skill: SkillManifest; scoreValue: number }> = [];

    for (const skill of skills) {
      const score = this.calculateSkillScore(skill, context);
      scored.push({ skill, scoreValue: score });
    }

    scored.sort((a, b) => b.scoreValue - a.scoreValue);
    return scored;
  }

  /**
   * Calculate relevance score for a skill
   */
  private calculateSkillScore(skill: SkillManifest, context: SelectionContext): number {
    let score = 0;

    // Relevance: does skill match task?
    const inputLower = context.userInput.toLowerCase();
    const slugLower = skill.slug.toLowerCase();
    if (slugLower.includes(inputLower) || inputLower.includes(slugLower)) {
      score += 10;
    }

    // Check if skill is used recently (from history)
    if (context.previousSkillsUsed?.includes(skill.slug)) {
      score += 3; // Slight boost for recently used skills
    }

    // Compatibility with task type
    if (context.taskType) {
      score += this.scoreTaskTypeCompatibility(skill, context.taskType);
    }

    return Math.max(0, score);
  }

  /**
   * Score task type compatibility
   */
  private scoreTaskTypeCompatibility(skill: SkillManifest, taskType: string): number {
    const skillId = skill.slug.toLowerCase();

    const compatibilityMap: Record<string, string[]> = {
      development: ["code", "build", "compile", "test", "deploy"],
      analysis: ["analyze", "review", "inspect", "audit", "check"],
      automation: ["automate", "script", "workflow", "job", "cron"],
      communication: ["document", "write", "report", "present", "notify"],
    };

    const compatible = compatibilityMap[taskType] ?? [];
    for (const keyword of compatible) {
      if (skillId.includes(keyword)) return 5;
    }

    return 0;
  }

  /**
   * Filter skills by bundle constraints
   */
  private filterByBundleConstraints(
    scored: Array<{ skill: SkillManifest; scoreValue: number }>,
    bundles: SkillBundle[],
    topN: number
  ): SkillManifest[] {
    const selected: SkillManifest[] = [];
    const bundleUsage = new Map<string, number>();

    for (const { skill } of scored) {
      // Check bundle constraints
      const skillBundles = this.bundleManager.getBundlesForSkill(skill.slug);

      let canAdd = true;
      for (const bundle of skillBundles) {
        const usage = bundleUsage.get(bundle.id) ?? 0;
        if (usage >= bundle.maxConcurrent) {
          canAdd = false;
          break;
        }
      }

      if (canAdd) {
        selected.push(skill);
        for (const bundle of skillBundles) {
          bundleUsage.set(bundle.id, (bundleUsage.get(bundle.id) ?? 0) + 1);
        }
      }

      if (selected.length >= topN) break;
    }

    return selected;
  }

  /**
   * Resolve dependencies and add required skills
   */
  private resolveDependencies(selected: SkillManifest[], bundles: SkillBundle[]): SkillManifest[] {
    const result = new Set(selected);

    for (const bundle of bundles) {
      // Check if bundle is active
      const hasSkillFromBundle = selected.some(s => bundle.skills.some(bs => bs.slug === s.slug));

      if (hasSkillFromBundle) {
        // Add dependent bundles' skills
        for (const depId of bundle.dependencies) {
          const depBundle = this.bundleManager.getBundle(depId);
          if (depBundle) {
            for (const skill of depBundle.skills.slice(0, 1)) {
              // Add at least one skill from dependency
              result.add(skill);
            }
          }
        }
      }
    }

    return Array.from(result);
  }

  /**
   * Calculate confidence in selection
   */
  private calculateConfidence(topSkills: Array<{ skill: SkillManifest; scoreValue: number }>, context: SelectionContext): number {
    if (topSkills.length === 0) return 0;

    // Base confidence on top score
    const topScore = topSkills[0]!.scoreValue;
    let confidence = Math.min(topScore / 20, 1); // Normalize to 0-1

    // Boost if we have clear task type
    if (context.taskType) confidence *= 1.1;

    // Reduce if time constraint is immediate
    if (context.timeConstraint === "immediate") confidence *= 0.9;

    return Math.min(confidence, 1);
  }

  /**
   * Generate reasoning for selection
   */
  private generateReasoning(selected: SkillManifest[], bundles: SkillBundle[], context: SelectionContext): string {
    const parts: string[] = [];

    if (bundles.length > 0) {
      parts.push(`Selected ${bundles.length} skill bundle(s): ${bundles.map(b => b.name).join(", ")}`);
    }

    if (selected.length > 0) {
      parts.push(`Activated ${selected.length} skill(s) based on context: "${context.userInput.slice(0, 50)}..."`);
    }

    if (context.taskType) {
      parts.push(`Optimized for ${context.taskType} tasks`);
    }

    if (context.timeConstraint) {
      parts.push(`Time constraint: ${context.timeConstraint}`);
    }

    return parts.join(". ") || "Skills selected based on relevance to user input";
  }

  /**
   * Hermes Pattern #2: Resolve full dependency closure
   * Recursively resolves all skill dependencies, detects circular deps
   */
  private resolveFullDependencies(
    selected: SkillManifest[],
    maxDepth: number = 5
  ): { resolved: SkillManifest[]; issues: string[] } {
    const resolved = new Map<string, SkillManifest>();
    const issues: string[] = [];
    const visited = new Set<string>();

    const traverse = (skillSlug: string, path: string[] = [], depth: number = 0): void => {
      // Check for circular dependency
      if (path.includes(skillSlug)) {
        const cycle = path.slice(path.indexOf(skillSlug)).concat(skillSlug);
        issues.push(`Circular dependency: ${cycle.join(" → ")}`);
        return;
      }

      // Check depth limit
      if (depth > maxDepth) {
        issues.push(`Dependency chain too deep for ${skillSlug}`);
        return;
      }

      // Skip if already visited
      if (visited.has(skillSlug)) return;
      visited.add(skillSlug);

      // Get skill
      const skill = this.availableSkills.get(skillSlug);
      if (!skill) {
        issues.push(`Missing skill: ${skillSlug}`);
        return;
      }

      resolved.set(skillSlug, skill);

      // Recursively resolve dependencies
      const dependencies = skill.dependencies || [];
      for (const depSlug of dependencies) {
        traverse(depSlug, [...path, skillSlug], depth + 1);
      }
    };

    // Start traversal from direct skills
    for (const skill of selected) {
      traverse(skill.slug);
    }

    return {
      resolved: Array.from(resolved.values()),
      issues,
    };
  }

  /**
   * Get selection statistics
   */
  getStats() {
    return {
      availableSkills: this.availableSkills.size,
      bundles: this.bundleManager.getStats(),
    };
  }
}
