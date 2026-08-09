#!/usr/bin/env node
/**
 * Package repo plugins/<name>/ folders into installable JSON bundles for the landing catalog,
 * and regenerate landing/api/data/plugins.json from the manifests. File-first: a bundle is
 * { name, version, files: [{ path, content }] } - exactly what POST /api/plugins/install writes.
 *
 * Excludes runtime/local artifacts (data/, .state.json, .gitignore). Run:
 *   node landing/scripts/build-plugin-bundles.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const pluginsDir = join(repoRoot, "plugins");
const outDir = join(here, "..", "api", "data", "plugin-bundles");
const listFile = join(here, "..", "api", "data", "plugins.json");

const EXCLUDE_DIRS = new Set(["data", "node_modules"]);
const EXCLUDE_FILES = new Set([".state.json", ".gitignore"]);

/** Recursively collect { path, content } for all text files under a plugin dir. */
function collectFiles(root, dir = root, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collectFiles(root, join(dir, entry.name), acc);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split("\\").join("/");
      acc.push({ path: rel, content: readFileSync(abs, "utf8") });
    }
  }
  return acc;
}

function main() {
  if (!existsSync(pluginsDir)) {
    console.error(`No plugins directory at ${pluginsDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const listing = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(pluginsDir, entry.name);
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const name = manifest.name ?? entry.name;
    const files = collectFiles(dir);
    const bundle = { name, version: manifest.version ?? "1.0.0", files };
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    listing.push({
      id: name,
      name,
      description: manifest.description ?? "",
      version: manifest.version ?? "1.0.0",
      author: manifest.author ?? null,
      license: manifest.license ?? null,
      hasStorage: manifest.storage?.sqlite === true,
      origin: "builtin",
      source_url: `https://ducki-ai-agent.davidduckwitz.de/api/v1.php?action=download&type=plugin&id=${name}`,
      status: "active",
    });
    console.log(`bundled ${name} (${files.length} files)`);
  }

  writeFileSync(
    listFile,
    `${JSON.stringify({ version: 1, updated: new Date().toISOString(), plugins: listing }, null, 2)}\n`,
    "utf8"
  );
  console.log(`wrote ${listing.length} plugins to plugins.json`);
}

main();
