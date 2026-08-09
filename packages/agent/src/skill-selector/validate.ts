/**
 * agentskills.io-conformant validation for a SKILL.md file / skill directory.
 *
 * Implements the spec's hard constraints:
 *   - name: 1-64 chars, /^[a-z0-9]+(-[a-z0-9]+)*$/, no leading/trailing/double hyphen,
 *           and must equal the parent directory name.
 *   - description: 1-1024 chars, non-empty.
 *   - compatibility (if present): 1-500 chars.
 * See https://agentskills.io/specification
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter, normalizeFrontmatter } from "./frontmatter.js";

export interface SkillValidationIssue {
  field: string;
  message: string;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate raw SKILL.md content. `dirName`, when provided, is the expected
 * parent directory name that `name` must match.
 */
export function validateSkillContent(content: string, dirName?: string): SkillValidationResult {
  const errors: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];

  const parsed = parseFrontmatter(content);
  if (!parsed.found) {
    errors.push({ field: "frontmatter", message: "Missing YAML frontmatter block (--- ... ---)" });
  }
  const fm = normalizeFrontmatter(parsed.data);

  // name
  if (!fm.name) {
    errors.push({ field: "name", message: "Required field 'name' is missing" });
  } else {
    if (fm.name.length > 64) {
      errors.push({ field: "name", message: "'name' must be at most 64 characters" });
    }
    if (!NAME_RE.test(fm.name)) {
      errors.push({
        field: "name",
        message:
          "'name' must be lowercase alphanumeric with single hyphens (no leading/trailing/double hyphen)",
      });
    }
    if (dirName && fm.name !== dirName) {
      errors.push({
        field: "name",
        message: `'name' (${fm.name}) must match the directory name (${dirName})`,
      });
    }
  }

  // description
  if (!fm.description) {
    errors.push({ field: "description", message: "Required field 'description' is missing" });
  } else if (fm.description.length > 1024) {
    errors.push({ field: "description", message: "'description' must be at most 1024 characters" });
  } else if (fm.description.length < 20) {
    warnings.push({
      field: "description",
      message: "'description' is very short; include what the skill does and when to use it",
    });
  }

  // compatibility (optional)
  if (fm.compatibility && fm.compatibility.length > 500) {
    errors.push({ field: "compatibility", message: "'compatibility' must be at most 500 characters" });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a skill directory: requires a SKILL.md and enforces the name/dir match.
 */
export function validateSkillDirectory(skillDir: string): SkillValidationResult {
  const dirName = basename(skillDir);
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    return {
      valid: false,
      errors: [{ field: "SKILL.md", message: `SKILL.md not found in ${dirName}` }],
      warnings: [],
    };
  }
  const content = readFileSync(skillFile, "utf8");
  return validateSkillContent(content, dirName);
}
