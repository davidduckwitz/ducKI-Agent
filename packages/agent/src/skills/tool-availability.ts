/**
 * Tool Availability Checker for Skill Conditional Activation
 *
 * Checks whether a skill should be active based on the availability of
 * tools and toolsets in the current session. This enables skills to
 * auto-show/hide based on runtime tool availability.
 *
 * Inspired by hermes-agent's conditional activation system:
 * - requires_tools: skill shown only when these tools exist
 * - fallback_for_tools: skill shown only when these tools are missing
 * - requires_toolsets: skill shown only when toolset available
 * - fallback_for_toolsets: skill shown only when toolset missing
 */

import type { SkillManifest } from "../config/interfaces_types.js";

/** Metadata structure for conditional activation */
interface SkillMetadata {
  requires_tools?: string[];
  fallback_for_tools?: string[];
  requires_toolsets?: string[];
  fallback_for_toolsets?: string[];
  [key: string]: unknown;
}

/**
 * Toolset definitions - maps toolset names to the tools they contain.
 */
export const TOOLSET_DEFINITIONS: Record<string, string[]> = {
  terminal: ["shell", "filesystem", "git"],
  web: ["http", "browser"],
  browser: ["browser"],
  coding: ["filesystem", "shell", "git", "diagnostics"],
  memory: ["memory"],
  task: ["task", "project"],
  skill: ["skill_manage"],
};

/**
 * Check if a skill should be active based on tool availability.
 */
export function checkSkillActivation(
  skill: SkillManifest,
  availableTools: Set<string>,
  availableToolsets: Set<string> = new Set()
): boolean {
  const metadata = skill.metadata?.hermes as SkillMetadata | undefined;
  if (!metadata) return true; // No conditions = always active

  // Check requires_tools - skill hidden when listed tools are missing
  if (metadata.requires_tools && Array.isArray(metadata.requires_tools)) {
    if (!metadata.requires_tools.every((t: string) => availableTools.has(t))) {
      return false;
    }
  }

  // Check fallback_for_tools - skill hidden when listed tools are available
  if (metadata.fallback_for_tools && Array.isArray(metadata.fallback_for_tools)) {
    if (metadata.fallback_for_tools.some((t: string) => availableTools.has(t))) {
      return false;
    }
  }

  // Check requires_toolsets - skill hidden when listed toolsets are missing
  if (metadata.requires_toolsets && Array.isArray(metadata.requires_toolsets)) {
    for (const toolset of metadata.requires_toolsets) {
      const toolsetTools = TOOLSET_DEFINITIONS[toolset] ?? [];
      if (!toolsetTools.some((t) => availableTools.has(t))) {
        return false;
      }
    }
  }

  // Check fallback_for_toolsets - skill hidden when listed toolsets are available
  if (metadata.fallback_for_toolsets && Array.isArray(metadata.fallback_for_toolsets)) {
    for (const toolset of metadata.fallback_for_toolsets) {
      const toolsetTools = TOOLSET_DEFINITIONS[toolset] ?? [];
      if (toolsetTools.some((t) => availableTools.has(t))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filter skills by activation conditions.
 */
export function filterSkillsByActivation(
  skills: SkillManifest[],
  availableTools: Set<string>,
  availableToolsets?: Set<string>
): SkillManifest[] {
  return skills.filter((skill) =>
    checkSkillActivation(skill, availableTools, availableToolsets)
  );
}

/**
 * Get activation status for a skill (for debugging/logging).
 */
export function getSkillActivationStatus(
  skill: SkillManifest,
  availableTools: Set<string>,
  availableToolsets?: Set<string>
): { active: boolean; reason: string } {
  const metadata = skill.metadata?.hermes as SkillMetadata | undefined;
  if (!metadata) return { active: true, reason: "No conditions" };

  if (metadata.requires_tools && Array.isArray(metadata.requires_tools)) {
    const missing = metadata.requires_tools.filter((t: string) => !availableTools.has(t));
    if (missing.length > 0) {
      return { active: false, reason: `Missing required tools: ${missing.join(", ")}` };
    }
  }

  if (metadata.fallback_for_tools && Array.isArray(metadata.fallback_for_tools)) {
    const present = metadata.fallback_for_tools.filter((t: string) => availableTools.has(t));
    if (present.length > 0) {
      return { active: false, reason: `Fallback tools available: ${present.join(", ")}` };
    }
  }

  if (metadata.requires_toolsets && Array.isArray(metadata.requires_toolsets)) {
    for (const toolset of metadata.requires_toolsets) {
      const toolsetTools = TOOLSET_DEFINITIONS[toolset] ?? [];
      if (!toolsetTools.some((t) => availableTools.has(t))) {
        return { active: false, reason: `Missing required toolset: ${toolset}` };
      }
    }
  }

  if (metadata.fallback_for_toolsets && Array.isArray(metadata.fallback_for_toolsets)) {
    for (const toolset of metadata.fallback_for_toolsets) {
      const toolsetTools = TOOLSET_DEFINITIONS[toolset] ?? [];
      if (toolsetTools.some((t) => availableTools.has(t))) {
        return { active: false, reason: `Fallback toolset available: ${toolset}` };
      }
    }
  }

  return { active: true, reason: "All conditions met" };
}
