import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

export type AgentModeType = "chatbot" | "lightweight" | "full";
export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex";

export interface TaskCharacteristics {
  estimatedComplexity: TaskComplexity;
  requiresPlanning: boolean;
  requiresReflection: boolean;
  estimatedIterations: number;
  preferredMode: AgentModeType;
  confidence: number;
}

/**
 * Detects task characteristics and recommends optimal agent mode.
 * Uses heuristics to classify tasks and select appropriate execution strategy.
 */
export class ModeDetector {
  private logger: Logger;
  private modeAccuracy = new Map<AgentModeType, { correct: number; total: number }>();

  constructor() {
    this.logger = getRootLogger().child("ModeDetector");
    this.initializeModeMetrics();
  }

  private initializeModeMetrics(): void {
    this.modeAccuracy.set("chatbot", { correct: 0, total: 0 });
    this.modeAccuracy.set("lightweight", { correct: 0, total: 0 });
    this.modeAccuracy.set("full", { correct: 0, total: 0 });
  }

  /**
   * Detect task characteristics and recommend mode.
   */
  detectMode(input: string): TaskCharacteristics {
    const inputLength = input.length;
    const tokenEstimate = Math.ceil(inputLength / 4); // Rough estimate: 4 chars per token
    const hasTechKeywords = this.containsTechKeywords(input);
    const hasToolReference = input.includes("[TOOL:") || input.includes("/tool");
    const isQuestion = input.trim().endsWith("?");
    const isCommand = input.trim().startsWith("/");

    // Trivial: Very short, simple questions without tool refs
    if (inputLength < 100 && isQuestion && !hasTechKeywords) {
      return {
        estimatedComplexity: "trivial",
        requiresPlanning: false,
        requiresReflection: false,
        estimatedIterations: 1,
        preferredMode: "chatbot",
        confidence: 0.9,
      };
    }

    // Simple: Short input, no tech keywords, no tools
    if (inputLength < 250 && !hasTechKeywords && !hasToolReference && !isCommand) {
      return {
        estimatedComplexity: "simple",
        requiresPlanning: false,
        requiresReflection: false,
        estimatedIterations: 1,
        preferredMode: "lightweight",
        confidence: 0.85,
      };
    }

    // Moderate: Medium length, some tech keywords, possible tool use
    if (inputLength < 1000 && (hasTechKeywords || hasToolReference)) {
      return {
        estimatedComplexity: "moderate",
        requiresPlanning: false,
        requiresReflection: true,
        estimatedIterations: 3,
        preferredMode: "lightweight",
        confidence: 0.75,
      };
    }

    // Complex: Long input, multiple keywords, explicit tool references
    if (inputLength >= 1000 || (hasTechKeywords && hasToolReference)) {
      return {
        estimatedComplexity: "complex",
        requiresPlanning: true,
        requiresReflection: true,
        estimatedIterations: 5,
        preferredMode: "full",
        confidence: 0.8,
      };
    }

    // Default to full mode for unclassified inputs
    return {
      estimatedComplexity: "moderate",
      requiresPlanning: false,
      requiresReflection: true,
      estimatedIterations: 3,
      preferredMode: "full",
      confidence: 0.5,
    };
  }

  /**
   * Record actual complexity vs predicted to improve detection accuracy.
   */
  recordActualComplexity(input: string, actual: AgentModeType, iterations: number): void {
    const predicted = this.detectMode(input);
    const metrics = this.modeAccuracy.get(predicted.preferredMode);
    if (metrics) {
      metrics.total++;
      if (predicted.preferredMode === actual) {
        metrics.correct++;
      }
    }

    this.logger.debug("Mode detection recorded", {
      predicted: predicted.preferredMode,
      actual,
      iterations,
      accuracy: metrics ? (metrics.correct / metrics.total).toFixed(2) : "N/A",
    });
  }

  /**
   * Get accuracy metrics for each mode.
   */
  getAccuracyMetrics(): Record<AgentModeType, { accuracy: number; total: number }> {
    const result: Record<AgentModeType, { accuracy: number; total: number }> = {
      chatbot: { accuracy: 0, total: 0 },
      lightweight: { accuracy: 0, total: 0 },
      full: { accuracy: 0, total: 0 },
    };

    for (const [mode, metrics] of this.modeAccuracy.entries()) {
      result[mode as AgentModeType] = {
        accuracy: metrics.total > 0 ? metrics.correct / metrics.total : 0,
        total: metrics.total,
      };
    }

    return result;
  }

  private containsTechKeywords(input: string): boolean {
    const techKeywords = [
      "code",
      "function",
      "api",
      "database",
      "error",
      "bug",
      "debug",
      "test",
      "implement",
      "deploy",
      "script",
      "command",
      "config",
      "install",
      "build",
      "compile",
    ];

    const lowerInput = input.toLowerCase();
    return techKeywords.some((keyword) => lowerInput.includes(keyword));
  }
}

// Singleton instance
export const modeDetector = new ModeDetector();
