#!/usr/bin/env node
/**
 * CI check: validate core skills in ./skills AND plugin skills declared via
 * provides.skills in apps/server/plugins/<plugin>/plugin.json against the agentskills.io spec.
 *
 * Additionally checks:
 *  - every provides.skills reference resolves to a directory with a SKILL.md
 *  - plugin skill slugs that clash with a core skill are reported (core wins at
 *    runtime, so the plugin version is shadowed - see docs/DEV_ENVIRONMENT.md)
 *
 * The pure scanning/validation logic lives in validateAllSkills() (exported for
 * tests). The CLI wrapper imports the compiled agent validator, prints the
 * report and exits non-zero if any skill fails.
 *
 * Requires the agent package to be built (pnpm --filter @ducki/agent build).
 *
 * Usage: node scripts/validate-skills.mjs
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Scan core skills in `skillsDir` and plugin skills declared via provides.skills
 * in `pluginsDir`, validate each with the injected `validateSkillDirectory`
 * (same signature as @ducki/agent's compiled validator) and detect slug clashes
 * between plugin and core skills.
 *
 * Pure function - no process.exit, no repo-root assumptions (testable).
 */
export function validateAllSkills({ skillsDir, pluginsDir, validateSkillDirectory }) {
  const coreDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  /** Flat list of checks: { label, isPlugin, result } (result shape from validateSkillDirectory). */
  const entries = [];

  for (const name of coreDirs) {
    entries.push({
      label: name,
      isPlugin: false,
      result: validateSkillDirectory(join(skillsDir, name)),
    });
  }

  // --- Plugin skills (pluginsDir/<plugin>/<ref>) ---
  const pluginSkillSlugs = [];
  if (existsSync(pluginsDir)) {
    const pluginNames = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const pluginName of pluginNames) {
      const manifestPath = join(pluginsDir, pluginName, "plugin.json");
      if (!existsSync(manifestPath)) continue; // not a plugin (no manifest), like the runtime loader

      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
      } catch (error) {
        entries.push({
          label: `${pluginName} (plugin.json)`,
          isPlugin: true,
          result: {
            valid: false,
            errors: [{ field: "plugin.json", message: `unparseable JSON: ${error.message}` }],
            warnings: [],
          },
        });
        continue;
      }

      const refs = manifest?.provides?.skills;
      if (refs === undefined) continue; // plugin declares no skills

      if (!Array.isArray(refs)) {
        entries.push({
          label: `${pluginName} (provides.skills)`,
          isPlugin: true,
          result: {
            valid: false,
            errors: [{ field: "provides.skills", message: "must be an array of relative skill directories" }],
            warnings: [],
          },
        });
        continue;
      }

      for (const rel of refs) {
        const skillDir = join(pluginsDir, pluginName, rel);
        const slug = basename(rel);
        if (!existsSync(join(skillDir, "SKILL.md"))) {
          entries.push({
            label: `${pluginName}/${rel}`,
            isPlugin: true,
            result: {
              valid: false,
              errors: [{ field: "provides.skills", message: `referenced skill directory '${rel}' has no SKILL.md` }],
              warnings: [],
            },
          });
          continue;
        }
        pluginSkillSlugs.push({ slug, plugin: pluginName });
        entries.push({
          label: `${pluginName}/${slug}`,
          isPlugin: true,
          result: validateSkillDirectory(skillDir),
        });
      }
    }
  }

  // --- Slug-clash warnings (core wins at runtime, plugin version is shadowed) ---
  const coreSlugSet = new Set(coreDirs);
  for (const { slug, plugin } of pluginSkillSlugs) {
    if (coreSlugSet.has(slug)) {
      entries.push({
        label: `${slug} (clash)`,
        isPlugin: true,
        result: {
          valid: true,
          errors: [],
          warnings: [
            {
              field: "slug",
              message: `plugin skill '${slug}' (from '${plugin}') clashes with the core skill of the same slug — core wins at runtime, the plugin version is shadowed`,
            },
          ],
        },
      });
    }
  }

  const coreCount = entries.filter((e) => !e.isPlugin).length;
  const pluginCount = entries.filter((e) => e.isPlugin).length;
  const failed = entries.filter((e) => !e.result.valid).length;
  const warned = entries.filter((e) => e.result.valid && e.result.warnings.length).length;
  return { entries, coreCount, pluginCount, failed, warned };
}

// --- CLI (only when executed directly, not when imported by tests) ---
const isCli =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const validatorPath = join(root, "packages/agent/dist/skill-selector/validate.js");

  if (!existsSync(validatorPath)) {
    console.error(
      "Compiled validator not found. Run:\n  pnpm --filter @ducki/agent build\nthen re-run this script."
    );
    process.exit(2);
  }

  const { validateSkillDirectory } = await import(pathToFileURL(validatorPath).href);

  const skillsDir = join(root, "skills");
  const pluginsDir = join(root, "apps", "server", "plugins");
  if (!existsSync(skillsDir)) {
    console.error(`skills directory not found: ${skillsDir}`);
    process.exit(2);
  }

  const { entries, coreCount, pluginCount, failed, warned } = validateAllSkills({
    skillsDir,
    pluginsDir,
    validateSkillDirectory,
  });

  for (const { label, result } of entries) {
    if (!result.valid) {
      console.error(`✗ ${label}`);
      for (const e of result.errors) console.error(`    [${e.field}] ${e.message}`);
    } else if (result.warnings.length) {
      console.warn(`⚠ ${label}`);
      for (const w of result.warnings) console.warn(`    [${w.field}] ${w.message}`);
    } else {
      console.log(`✓ ${label}`);
    }
  }

  console.log(
    `\n${coreCount} core skills + ${pluginCount} plugin entries checked — ${entries.length - failed} valid, ${failed} failed, ${warned} with warnings.`
  );

  process.exit(failed > 0 ? 1 : 0);
}
