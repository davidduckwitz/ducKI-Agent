#!/usr/bin/env node
/**
 * CI check: validate every skill in ./skills against the agentskills.io spec.
 *
 * Requires the agent package to be built (pnpm --filter @ducki/agent build),
 * since it imports the compiled validator. Exits non-zero if any skill fails.
 *
 * Usage: node scripts/validate-skills.mjs
 */
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
if (!existsSync(skillsDir)) {
  console.error(`skills directory not found: ${skillsDir}`);
  process.exit(2);
}

const dirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let failed = 0;
let warned = 0;
const failures = [];

for (const name of dirs) {
  const result = validateSkillDirectory(join(skillsDir, name));
  if (!result.valid) {
    failed++;
    failures.push({ name, errors: result.errors });
    console.error(`✗ ${name}`);
    for (const e of result.errors) console.error(`    [${e.field}] ${e.message}`);
  } else if (result.warnings.length) {
    warned++;
    console.warn(`⚠ ${name}`);
    for (const w of result.warnings) console.warn(`    [${w.field}] ${w.message}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

console.log(
  `\n${dirs.length} skills checked — ${dirs.length - failed} valid, ${failed} failed, ${warned} with warnings.`
);

process.exit(failed > 0 ? 1 : 0);
