import type { SkillManifest, AgentRuntimeControls } from "../config/interfaces_types.js";
import { AdvancedSkillSelector, type SelectionContext, type SelectionResult } from "./advanced-selector.js";
import { skillSelector, type SkillMetrics } from "./selector.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Integrated skill selection service combining:
 * - AdvancedSkillSelector for intelligent context-aware selection
 * - SkillSelector for metrics tracking and performance scoring
 */
export class SkillSelectionService {
  private logger: Logger;
  private advancedSelector: AdvancedSkillSelector;
  private allSkills: SkillManifest[] = [];

  constructor() {
    this.logger = getRootLogger().child("SkillSelectionService");
    this.advancedSelector = new AdvancedSkillSelector();
  }

  /**
   * Initialize with available skills and load metrics
   */
  initialize(skills: SkillManifest[]): void {
    this.allSkills = skills;

    // Register skills with advanced selector
    this.advancedSelector.registerSkills(skills);

    // Register skill embeddings for semantic matching
    for (const skill of skills) {
      const content = `${skill.name} ${skill.description || ""}`;
      skillSelector.registerSkillEmbedding(skill.slug, content);
    }

    this.logger.info("Skill selection service initialized", { skillCount: skills.length });
  }

  /**
   * Select skills based on user input and context
   * Combines intelligent selection with performance metrics
   */
  selectSkills(context: SelectionContext): SelectionResult {
    // Get intelligent selection
    const selection = this.advancedSelector.selectSkills(context);

    // Enhance with metrics scoring
    const enhancedSkills = selection.selectedSkills.map((skill) => {
      const metrics = skillSelector.getMetrics(skill.slug);
      const semanticSim = skillSelector.calculateSemanticSimilarity(context.userInput, skill.slug);

      return {
        ...skill,
        _metrics: {
          successRate: metrics?.successRate ?? 0.5,
          lastUsed: metrics?.lastUsed,
          totalUses: metrics?.totalUses ?? 0,
          semanticSimilarity: semanticSim,
        },
      };
    });

    this.logger.debug("Skills selected", {
      input: context.userInput.substring(0, 100),
      selectedCount: enhancedSkills.length,
      confidence: selection.confidence,
      bundles: selection.bundles.map((b) => b.id),
    });

    return {
      ...selection,
      selectedSkills: enhancedSkills as SkillManifest[],
    };
  }

  /**
   * Record skill usage outcome
   */
  recordUsage(skillSlug: string, success: boolean, iterations: number = 1): void {
    skillSelector.recordSkillUsage(skillSlug, success, iterations);
    this.logger.debug("Skill usage recorded", { skillSlug, success, iterations });
  }

  /**
   * Get metrics for a skill
   */
  getMetrics(skillSlug: string): SkillMetrics | undefined {
    return skillSelector.getMetrics(skillSlug);
  }

  /**
   * Get all skill metrics
   */
  getAllMetrics(): SkillMetrics[] {
    return skillSelector.getAllMetrics();
  }

  /**
   * Get recommended skills for a user input
   * (simplified version without full context)
   */
  getRecommendedSkills(input: string, limit: number = 5): SkillManifest[] {
    const context: SelectionContext = {
      userInput: input,
      taskType: undefined,
      complexityLevel: undefined,
      timeConstraint: undefined,
      previousSkillsUsed: [],
    };

    const result = this.selectSkills(context);
    return result.selectedSkills.slice(0, limit);
  }

  /**
   * Auto-select skills if enabled in settings
   */
  shouldAutoSelect(runtimeControls: AgentRuntimeControls): boolean {
    return runtimeControls.enableAutoSkillSelection === true;
  }

  /**
   * Get auto-selection config from runtime controls
   */
  getAutoSelectionConfig(runtimeControls: AgentRuntimeControls): {
    enabled: boolean;
    threshold: number;
    margin: number;
    minInputLength: number;
    minOverlap: number;
  } {
    return {
      enabled: this.shouldAutoSelect(runtimeControls),
      threshold: runtimeControls.autoSkillScoreThreshold ?? 0.78,
      margin: runtimeControls.autoSkillMarginThreshold ?? 0.2,
      minInputLength: runtimeControls.autoSkillMinInputLength ?? 20,
      minOverlap: runtimeControls.autoSkillMinOverlap ?? 2,
    };
  }
}

// Singleton instance
export const skillSelectionService = new SkillSelectionService();
