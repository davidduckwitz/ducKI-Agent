import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { duckiHome } from "@ducki/shared";

/**
 * Pins the shared-workspace root to a stable, launcher-independent location: the user's home
 * directory (`~/DucKI/shared-workspace`) - the SAME location the packaged Tauri app already uses
 * (see apps/tauri-desktop/src-tauri/src/main.rs's `shared_workspace_path`: "user-authored files
 * belong in a visible, stable location"). Before this, a plain `pnpm dev`/`npm start` server
 * defaulted to the repo-relative `apps/server/shared-workspace` while the packaged app used the
 * home directory - two different physical directories depending on how the server was launched,
 * so a file an agent wrote under one launcher was invisible ("missing") from the other.
 *
 * `@ducki/tools` (and the other consumers) read `SHARED_WORKSPACE_PATH` at module-load time and
 * otherwise default the root to `process.cwd()`. This module MUST be imported before
 * `@ducki/tools` (it is the first import in index.ts, right after dotenv) so the env is set
 * before the tools module captures it. An explicit `SHARED_WORKSPACE_PATH` (e.g. from .env) still
 * takes precedence.
 */
if (!process.env["DUCKI_HOME"] && !process.env["SHARED_WORKSPACE_PATH"] && !process.env["DUCKI_PLUGINS_DIR"] && !process.env["SKILLS_PATH"]) {
  const home = duckiHome();
  migrateLegacyRepoRuntime(home);
  process.env["DUCKI_HOME"] = home;
}

const home = duckiHome();
if (!process.env["SHARED_WORKSPACE_PATH"]) process.env["SHARED_WORKSPACE_PATH"] = resolve(home, "shared-workspace");
if (!process.env["DUCKI_PLUGINS_DIR"]) process.env["DUCKI_PLUGINS_DIR"] = resolve(home, "plugins");
if (!process.env["SKILLS_PATH"]) process.env["SKILLS_PATH"] = resolve(home, "skills");

/**
 * One-time, additive-only migration: copies anything from the OLD repo-relative
 * `apps/server/shared-workspace` into the new home-dir workspace, without ever overwriting a file
 * that already exists at the destination or touching/deleting the source. An existing install
 * keeps every file it already had in both places; nothing is deleted, so this is safe to run on
 * every startup (cheap no-op once the two directories have converged) and always recoverable from
 * the untouched original if something looks wrong.
 *
 * moduleDir is `apps/server/src` under tsx and `apps/server/dist` when built; `../shared-workspace`
 * resolves to `apps/server/shared-workspace` in both cases.
 */
function migrateLegacyRepoRuntime(home: string): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const legacyWorkspace = resolve(moduleDir, "../shared-workspace");
  const legacyPlugins = resolve(moduleDir, "../plugins");
  const legacySkills = resolve(moduleDir, "../skills");
  const targets = [
    [legacyWorkspace, join(home, "shared-workspace")],
    [legacyPlugins, join(home, "plugins")],
    [legacySkills, join(home, "skills")],
  ] as const;
  for (const [source, target] of targets) {
    if (!existsSync(source) || source === target) continue;
    mkdirSync(target, { recursive: true });
    try {
      cpSync(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (entry) => !entry.split(sep).some((part) => part === ".ducki-checkpoints" || part === ".git" || part === "node_modules" || part === "models"),
      });
    } catch (error) {
      console.error(`[DucKI] Could not migrate runtime data from ${source} to ${target}:`, error);
    }
  }
}
