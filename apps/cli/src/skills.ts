import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSkillFrontmatter } from "@ducki/agent";

export interface CliSkillEntry {
  slug: string;
  description?: string;
}

/**
 * Mirrors Agent's own skillsRoot resolution (agent.ts constructor) exactly, instead of
 * @ducki/agent's AVAILABLE_SKILLS (skill-registry.ts), which resolves relative to
 * process.cwd() + "skills" - wrong when the CLI is started from apps/cli, since that
 * directory doesn't have a skills/ folder. Keeping this in sync with Agent's resolution is
 * what makes `ducki skills`/`/skills` show the SAME skills the chat agent actually loads.
 */
function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return resolve(configured);
  const monorepoCandidate = resolve(process.cwd(), "../../skills");
  const cwdLocal = resolve(process.cwd(), "skills");
  return existsSync(monorepoCandidate) ? monorepoCandidate : cwdLocal;
}

export function listInstalledSkills(): CliSkillEntry[] {
  const skillsRoot = resolveSkillsRoot();
  if (!existsSync(skillsRoot)) return [];

  const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const result: CliSkillEntry[] = [];
  for (const entry of dirs) {
    const skillPath = join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const fm = readSkillFrontmatter(readFileSync(skillPath, "utf8"));
    result.push({ slug: entry.name, description: fm.frontmatter.description });
  }
  return result.sort((a, b) => a.slug.localeCompare(b.slug));
}
