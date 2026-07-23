import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import type { SkillManifest } from "../config/interfaces_types";

export interface SkillMetrics {
  slug: string;
  totalUses: number;
  successfulUses: number;
  avgIterationsOnSuccess: number;
  avgIterationsOnFailure: number;
  lastUsed: string;
  successRate: number;
}

/**
 * Tracks skill usage and success metrics for intelligent skill selection.
 */
export class SkillSelector {
  private logger: Logger;
  private metricsCache = new Map<string, SkillMetrics>();
  private skillEmbeddings = new Map<string, number[]>(); // Simple word-frequency embeddings
  private readonly maxCacheAge = 86400000; // 24 hours

  constructor() {
    this.logger = getRootLogger().child("SkillSelector");
  }

  /**
   * Compute simple word-frequency embeddings for semantic similarity.
   */
  private computeEmbedding(text: string): number[] {
    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    const freq = new Map<string, number>();

    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Return top 20 words by frequency as a sparse embedding
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map((e) => e[1]);
  }

  /**
   * Calculate cosine similarity between two embeddings.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    const dotProduct = a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

    if (magA === 0 || magB === 0) return 0;
    return dotProduct / (magA * magB);
  }

  /**
   * Register a skill's embedding.
   */
  registerSkillEmbedding(skillSlug: string, skillContent: string): void {
    const embedding = this.computeEmbedding(skillContent);
    this.skillEmbeddings.set(skillSlug, embedding);
  }

  /**
   * Calculate semantic similarity between input and skill.
   */
  calculateSemanticSimilarity(input: string, skillSlug: string): number {
    const inputEmbedding = this.computeEmbedding(input);
    const skillEmbedding = this.skillEmbeddings.get(skillSlug);

    if (!skillEmbedding) {
      return 0.5; // Default if embedding not found
    }

    return this.cosineSimilarity(inputEmbedding, skillEmbedding);
  }

  /**
   * Score a skill based on Jaccard similarity, semantic similarity, and success rate.
   * Formula: jaccard × 0.4 + semantic × 0.3 + success_rate × 0.3
   */
  scoreSkill(
    input: string,
    skill: SkillManifest,
    jaccardSimilarity: number,
    semanticSimilarity: number = 0.5
  ): number {
    const metrics = this.metricsCache.get(skill.slug);
    const successRate = metrics ? metrics.successRate : 0.5;

    // Decay factor: recent successes weighted 2x
    const decayFactor = metrics
      ? Math.max(0, (24 * 60 * 60 * 1000 - (Date.now() - new Date(metrics.lastUsed).getTime())) / (24 * 60 * 60 * 1000))
      : 0.5;

    const decayedSuccessRate = successRate * (1 + decayFactor);

    return jaccardSimilarity * 0.4 + semanticSimilarity * 0.3 + Math.min(1, decayedSuccessRate) * 0.3;
  }

  /**
   * Record skill usage and outcome.
   */
  recordSkillUsage(slug: string, success: boolean, iterations: number): void {
    let metrics = this.metricsCache.get(slug);

    if (!metrics) {
      metrics = {
        slug,
        totalUses: 0,
        successfulUses: 0,
        avgIterationsOnSuccess: 0,
        avgIterationsOnFailure: 0,
        lastUsed: new Date().toISOString(),
        successRate: 0,
      };
    }

    metrics.totalUses++;
    metrics.lastUsed = new Date().toISOString();

    if (success) {
      metrics.successfulUses++;
      metrics.avgIterationsOnSuccess =
        (metrics.avgIterationsOnSuccess * (metrics.successfulUses - 1) + iterations) /
        metrics.successfulUses;
    } else {
      const failureCount = metrics.totalUses - metrics.successfulUses;
      metrics.avgIterationsOnFailure =
        (metrics.avgIterationsOnFailure * (failureCount - 1) + iterations) / failureCount;
    }

    metrics.successRate = metrics.successfulUses / metrics.totalUses;
    this.metricsCache.set(slug, metrics);

    this.logger.debug("Skill usage recorded", {
      slug,
      success,
      successRate: metrics.successRate,
      totalUses: metrics.totalUses,
    });
  }

  /**
   * Get metrics for a skill.
   */
  getMetrics(slug: string): SkillMetrics | undefined {
    return this.metricsCache.get(slug);
  }

  /**
   * Get all recorded metrics.
   */
  getAllMetrics(): SkillMetrics[] {
    return Array.from(this.metricsCache.values());
  }

  /**
   * Reset metrics for a skill or all skills.
   */
  resetMetrics(slug?: string): void {
    if (slug) {
      this.metricsCache.delete(slug);
    } else {
      this.metricsCache.clear();
    }
    this.logger.info("Skill metrics reset", { slug: slug || "all" });
  }

  /**
   * Prune old metrics (older than maxCacheAge).
   */
  pruneOldMetrics(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [slug, metrics] of this.metricsCache) {
      if (now - new Date(metrics.lastUsed).getTime() > this.maxCacheAge) {
        toDelete.push(slug);
      }
    }

    for (const slug of toDelete) {
      this.metricsCache.delete(slug);
    }

    if (toDelete.length > 0) {
      this.logger.debug("Old skill metrics pruned", { count: toDelete.length });
    }
  }
}

// Singleton instance
export const skillSelector = new SkillSelector();
