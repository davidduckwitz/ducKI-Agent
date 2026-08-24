/**
 * Project-Local Skills Service
 *
 * Discovers skills from project directories (`.agents/skills/` or
 * `.hermes/skills/`) and merges them with the global skill registry.
 * Ported from Hermes Agent's "Project-Local Skills" feature.
 *
 * Principle: A repo can carry its own skills that are active only when
 * working inside that project. Projects must be explicitly trusted.
 *
 * Precedence: Project > Local (./skills/) > External dirs (plugins)
 *
 * The Agent's loadSkillManifests() calls discoverAndMerge() to get
 * a merged list with project skills taking priority over same-slug
 * built-in skills.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { SkillManifest } from "@ducki/agent";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("ProjectSkills");

const SKILL_DIR_NAMES = [".agents/skills", ".hermes/skills"];

export class ProjectSkillsService {
  /** Find the project root by walking up from cwd looking for .git. */
  findProjectRoot(fromDir: string = process.cwd()): string | undefined {
    let dir = fromDir;
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, ".git"))) return dir;
      dir = dirname(dir);
    }
    return undefined;
  }

  /** Check if a project root is trusted. */
  isTrusted(projectRoot: string): boolean {
    const trustFile = this.trustFilePath();
    if (!existsSync(trustFile)) return false;

    try {
      const trusted: string[] = JSON.parse(readFileSync(trustFile, "utf8"));
      return trusted.includes(projectRoot);
    } catch {
      return false;
    }
  }

  /** Trust a project root persistently. */
  trustProject(projectRoot: string): void {
    const trustFile = this.trustFilePath();
    const dir = dirname(trustFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let trusted: string[] = [];
    if (existsSync(trustFile)) {
      try { trusted = JSON.parse(readFileSync(trustFile, "utf8")); } catch { /* start fresh */ }
    }
    if (!trusted.includes(projectRoot)) {
      trusted.push(projectRoot);
      writeFileSync(trustFile, JSON.stringify(trusted, null, 2), "utf8");
      logger.info("Project trusted for local skills", { projectRoot });
    }
  }

  /** Untrust a project root. */
  untrustProject(projectRoot: string): void {
    const trustFile = this.trustFilePath();
    if (!existsSync(trustFile)) return;

    try {
      let trusted: string[] = JSON.parse(readFileSync(trustFile, "utf8"));
      trusted = trusted.filter((p) => p !== projectRoot);
      writeFileSync(trustFile, JSON.stringify(trusted, null, 2), "utf8");
      logger.info("Project untrusted for local skills", { projectRoot });
    } catch { /* ignore */ }
  }

  /**
   * Discover skills from a project directory. Returns empty array if project
   * is not found or not trusted.
   *
   * Parses SKILL.md frontmatter (same subset as the Agent's own inline parser)
   * so project skill names, descriptions and conditional activation fields work
   * identically to built-in skills.
   */
  discoverProjectSkills(projectRoot?: string): SkillManifest[] {
    if (!projectRoot) {
      projectRoot = this.findProjectRoot();
    }
    if (!projectRoot) return [];
    if (!this.isTrusted(projectRoot)) {
      logger.debug("Project not trusted, skipping local skills", { projectRoot });
      return [];
    }

    const skills: SkillManifest[] = [];

    for (const dirName of SKILL_DIR_NAMES) {
      const skillsDir = join(projectRoot, dirName);
      if (!existsSync(skillsDir)) continue;

      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
          if (!existsSync(skillMdPath)) continue;

          // Parse SKILL.md frontmatter for name, description, and
          // conditional activation fields (same subset as Agent.parseFrontmatter).
          const fm = this.parseSkillFrontmatter(readFileSync(skillMdPath, "utf8"));

          const slug = entry.name.replace(/\s+/g, "-").toLowerCase();
          const displayName = fm.name ?? entry.name
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");

          skills.push({
            slug,
            name: `[project] ${displayName}`,
            description: fm.description ?? `Project-local skill from ${basename(projectRoot)}`,
            path: skillMdPath,
            primarySkills: fm.primarySkills ?? [],
            relatedSkills: fm.relatedSkills ?? [],
            fallbackSkills: fm.fallbackSkills ?? [],
            // Hermes pattern: conditional activation from frontmatter
            fallbackForToolsets: fm.fallbackForToolsets,
            requiresToolsets: fm.requiresToolsets,
            fallbackForTools: fm.fallbackForTools,
            requiresTools: fm.requiresTools,
            metadata: { source: "project", projectRoot },
          });
        }
      } catch (error) {
        logger.warn("Failed to scan project skills directory", {
          dir: skillsDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (skills.length > 0) {
      logger.info("Discovered project-local skills", {
        projectRoot,
        count: skills.length,
        slugs: skills.map((s) => s.slug),
      });
    }

    return skills;
  }

  /**
   * Merges project-local skills into an existing manifest list.
   * Project skills win over same-slug built-in skills (precedence rule).
   * Built-in skills not shadowed by a project skill are kept.
   */
  mergeWithBuiltinSkills(builtinManifests: SkillManifest[], projectRoot?: string): SkillManifest[] {
    const projectSkills = this.discoverProjectSkills(projectRoot);
    if (projectSkills.length === 0) return builtinManifests;

    // Build a set of project skill slugs for O(1) lookup.
    const projectSlugs = new Set(projectSkills.map((s) => s.slug));

    // Drop built-in skills that share a slug with a project skill (project wins).
    const kept = builtinManifests.filter((s) => !projectSlugs.has(s.slug));

    // Project skills come first (higher priority in the index).
    return [...projectSkills, ...kept];
  }

  /**
   * Lightweight frontmatter parser matching the subset used by Agent.parseFrontmatter.
   * Reads YAML-style `---` blocks for: name, description, primary_skills,
   * related_skills, fallback_skills, fallback_for_toolsets, requires_toolsets,
   * fallback_for_tools, requires_tools.
   */
  private parseSkillFrontmatter(content: string): {
    name?: string;
    description?: string;
    primarySkills?: string[];
    relatedSkills?: string[];
    fallbackSkills?: string[];
    fallbackForToolsets?: string[];
    requiresToolsets?: string[];
    fallbackForTools?: string[];
    requiresTools?: string[];
  } {
    if (!content.startsWith("---")) return {};
    const end = content.indexOf("\n---", 3);
    if (end < 0) return {};
    const block = content.slice(3, end).trim();

    const parseList = (raw: string): string[] => {
      const parsed = raw
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((token) => token.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
        .filter((token) => token.length > 0 && /^[a-z0-9_-]+$/.test(token));
      return Array.from(new Set(parsed));
    };

    const result: ReturnType<typeof this.parseSkillFrontmatter> = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key === "name") result.name = value;
      if (key === "description") result.description = value;
      if (key === "primary_skills") result.primarySkills = parseList(value);
      if (key === "related_skills") result.relatedSkills = parseList(value);
      if (key === "fallback_skills") result.fallbackSkills = parseList(value);
      if (key === "fallback_for_toolsets") result.fallbackForToolsets = parseList(value);
      if (key === "requires_toolsets") result.requiresToolsets = parseList(value);
      if (key === "fallback_for_tools") result.fallbackForTools = parseList(value);
      if (key === "requires_tools") result.requiresTools = parseList(value);
    }
    return result;
  }

  /** Trust file lives under data/.hermes/ relative to cwd (app root). */
  private trustFilePath(): string {
    return join(process.cwd(), "data", ".hermes", "trusted-projects.json");
  }
}

/** Singleton - the Agent wires this into loadSkillManifests at runtime. */
export const projectSkills = new ProjectSkillsService();