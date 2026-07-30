/**
 * Input normalization pipeline: composable transformations for tool inputs.
 * Handles alias resolution, type coercion, JSON repair, etc.
 */

import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Result of input normalization.
 */
export interface NormalizationResult {
  normalized: Record<string, unknown>;
  issues: string[];
  warnings: string[];
  transformations: Array<{ field: string; from: unknown; to: unknown; via: string }>;
}

/**
 * A single normalizer that transforms tool input.
 */
export interface InputNormalizer {
  name: string;
  normalize(toolName: string, input: Record<string, unknown>): Promise<NormalizationResult | null>;
}

/**
 * Composable pipeline of normalizers.
 */
export class InputNormalizerPipeline {
  private normalizers: InputNormalizer[] = [];
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? getRootLogger().child("InputNormalizerPipeline");
  }

  /**
   * Add a normalizer to the pipeline.
   */
  addNormalizer(normalizer: InputNormalizer): void {
    this.normalizers.push(normalizer);
  }

  /**
   * Run all normalizers sequentially.
   */
  async normalize(toolName: string, input: Record<string, unknown>): Promise<NormalizationResult> {
    let current = { ...input };
    const allIssues: string[] = [];
    const allWarnings: string[] = [];
    const allTransformations: Array<{ field: string; from: unknown; to: unknown; via: string }> = [];

    for (const normalizer of this.normalizers) {
      try {
        const result = await normalizer.normalize(toolName, current);
        if (result) {
          current = result.normalized;
          allIssues.push(...result.issues);
          allWarnings.push(...result.warnings);
          allTransformations.push(...result.transformations);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("Normalizer failed", { normalizer: normalizer.name, toolName, error: message });
        allWarnings.push(`Normalizer '${normalizer.name}' failed: ${message}`);
      }
    }

    return {
      normalized: current,
      issues: allIssues,
      warnings: allWarnings,
      transformations: allTransformations,
    };
  }
}

/**
 * Built-in normalizers
 */

/**
 * Resolves parameter aliases (e.g., project_id -> projectId).
 */
export class AliasNormalizer implements InputNormalizer {
  readonly name = "alias";

  private aliases = new Map<string, Map<string, string>>([
    [
      "filesystem",
      new Map([
        ["file_path", "path"],
        ["file", "path"],
        ["directory", "path"],
        ["dir", "path"],
      ]),
    ],
    [
      "project",
      new Map([
        ["project_id", "id"],
        ["projectId", "id"],
        ["name", "title"],
        ["project_name", "title"],
      ]),
    ],
    [
      "task",
      new Map([
        ["task_id", "id"],
        ["taskId", "id"],
        ["title", "name"],
        ["task_title", "name"],
        ["project_id", "projectId"],
      ]),
    ],
  ]);

  async normalize(toolName: string, input: Record<string, unknown>): Promise<NormalizationResult | null> {
    const toolAliases = this.aliases.get(toolName);
    if (!toolAliases || toolAliases.size === 0) {
      return null;
    }

    const normalized = { ...input };
    const transformations: Array<{ field: string; from: unknown; to: unknown; via: string }> = [];

    for (const [alias, canonical] of toolAliases.entries()) {
      if (alias in input && !(canonical in input)) {
        const value = input[alias];
        normalized[canonical] = value;
        delete normalized[alias];
        transformations.push({
          field: alias,
          from: alias,
          to: canonical,
          via: "alias",
        });
      }
    }

    return {
      normalized,
      issues: [],
      warnings: [],
      transformations,
    };
  }
}

/**
 * Coerces types based on expected schemas (string to number, etc.).
 */
export class TypeCoercer implements InputNormalizer {
  readonly name = "type-coerce";

  private coercions = new Map<string, Map<string, string>>([
    [
      "filesystem",
      new Map([
        ["recursive", "boolean"],
        ["maxDepth", "number"],
      ]),
    ],
    [
      "task",
      new Map([
        ["projectId", "number"],
        ["priority", "string"],
      ]),
    ],
  ]);

  async normalize(toolName: string, input: Record<string, unknown>): Promise<NormalizationResult | null> {
    const toolCoercions = this.coercions.get(toolName);
    if (!toolCoercions || toolCoercions.size === 0) {
      return null;
    }

    const normalized = { ...input };
    const transformations: Array<{ field: string; from: unknown; to: unknown; via: string }> = [];
    const issues: string[] = [];

    for (const [field, expectedType] of toolCoercions.entries()) {
      if (field in input) {
        const value = input[field];
        const coerced = this.coerce(value, expectedType);

        if (coerced !== value) {
          normalized[field] = coerced;
          transformations.push({
            field,
            from: value,
            to: coerced,
            via: `coerce-to-${expectedType}`,
          });
        }
      }
    }

    return {
      normalized,
      issues,
      warnings: [],
      transformations,
    };
  }

  private coerce(value: unknown, targetType: string): unknown {
    if (value === null || value === undefined) return value;

    switch (targetType) {
      case "number":
        if (typeof value === "number") return value;
        if (typeof value === "string") {
          const n = parseInt(value, 10);
          return isNaN(n) ? value : n;
        }
        return value;
      case "boolean":
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.toLowerCase() === "true";
        return Boolean(value);
      case "string":
        return String(value);
      default:
        return value;
    }
  }
}

/**
 * Repairs malformed JSON in input values.
 */
export class JSONRepairNormalizer implements InputNormalizer {
  readonly name = "json-repair";

  async normalize(toolName: string, input: Record<string, unknown>): Promise<NormalizationResult | null> {
    const normalized = { ...input };
    const transformations: Array<{ field: string; from: unknown; to: unknown; via: string }> = [];
    const warnings: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string" && value.includes("{")) {
        try {
          // Try parsing as JSON
          const parsed = JSON.parse(value);
          normalized[key] = parsed;
          transformations.push({
            field: key,
            from: value,
            to: parsed,
            via: "json-parse",
          });
        } catch {
          // Not valid JSON, leave as-is
          warnings.push(`Field '${key}' looks like JSON but could not parse: ${value.substring(0, 50)}`);
        }
      }
    }

    return {
      normalized,
      issues: [],
      warnings,
      transformations,
    };
  }
}
