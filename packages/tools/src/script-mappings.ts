/**
 * Hermes Pattern #3: Explicit script-to-tool mappings
 * Centralizes where each skill's scripts are located for discovery and validation
 */

export interface ScriptMapping {
  skillSlug: string;
  scripts: Record<string, string>; // scriptName -> filePath
}

export interface SkillManifest {
  slug: string;
  scripts?: Record<string, string>;
}

/**
 * Central registry of script mappings for skills
 * Can be extended with more skills as needed
 */
export const SKILL_SCRIPT_MAPPINGS: ScriptMapping[] = [
  {
    skillSlug: "filesystem-ops",
    scripts: {
      main: "./script.js",
      find: "./scripts/find.sh",
      "bulk-replace": "./scripts/bulk-replace.sh",
      validate: "./scripts/validate.sh",
    },
  },
  {
    skillSlug: "http-operations",
    scripts: {
      main: "./script.js",
      fetch: "./scripts/fetch.sh",
      post: "./scripts/post.sh",
    },
  },
  {
    skillSlug: "shell-commands",
    scripts: {
      main: "./script.js",
      execute: "./scripts/execute.sh",
    },
  },
  {
    skillSlug: "git-operations",
    scripts: {
      main: "./script.js",
      commit: "./scripts/commit.sh",
      push: "./scripts/push.sh",
    },
  },
];

/**
 * Get script path for a specific skill and script name
 * Returns undefined if not found
 *
 * @param skillSlug - The skill identifier
 * @param scriptName - Optional script name (defaults to 'main')
 * @returns The script file path or undefined
 */
export function getScriptPath(skillSlug: string, scriptName?: string): string | undefined {
  const mapping = SKILL_SCRIPT_MAPPINGS.find((m) => m.skillSlug === skillSlug);
  if (!mapping) return undefined;

  const name = scriptName || "main";
  return mapping.scripts[name];
}

/**
 * Build script mapping from a SkillManifest (useful for dynamic registration)
 *
 * @param skill - The skill manifest with scripts defined
 * @returns A ScriptMapping or undefined if no scripts defined
 */
export function buildScriptMappingFromManifest(skill: SkillManifest): ScriptMapping | undefined {
  if (!skill.scripts) return undefined;

  return {
    skillSlug: skill.slug,
    scripts: skill.scripts,
  };
}

/**
 * Register a new script mapping for a skill
 * Useful for dynamic skill registration
 *
 * @param mapping - The script mapping to register
 */
export function registerScriptMapping(mapping: ScriptMapping): void {
  // Remove existing mapping if present
  const idx = SKILL_SCRIPT_MAPPINGS.findIndex((m) => m.skillSlug === mapping.skillSlug);
  if (idx >= 0) {
    SKILL_SCRIPT_MAPPINGS[idx] = mapping;
  } else {
    SKILL_SCRIPT_MAPPINGS.push(mapping);
  }
}

/**
 * List all registered script mappings
 */
export function listScriptMappings(): ScriptMapping[] {
  return [...SKILL_SCRIPT_MAPPINGS];
}

/**
 * Get all scripts for a skill
 *
 * @param skillSlug - The skill identifier
 * @returns Record of script names to file paths, or undefined
 */
export function getSkillScripts(skillSlug: string): Record<string, string> | undefined {
  const mapping = SKILL_SCRIPT_MAPPINGS.find((m) => m.skillSlug === skillSlug);
  return mapping?.scripts;
}
