import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { config as loadEnv } from "dotenv";

/**
 * Pins the shared-workspace root before `@ducki/tools` captures it (see the server's
 * bootstrap-workspace for the full rationale - same `~/DucKI/shared-workspace` home-dir default,
 * same additive-only migration from the old repo-relative location). Must be the first import in
 * the CLI entry.
 *
 * The CLI shares the same root the server and the packaged Tauri app use, so all three agree on
 * one location. An explicit `SHARED_WORKSPACE_PATH` from the repo .env still wins, so it is
 * loaded here first.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(moduleDir, "../../../.env") });
if (!process.env["SHARED_WORKSPACE_PATH"]) {
  const homeWorkspace = resolve(homedir(), "DucKI", "shared-workspace");
  migrateLegacyRepoWorkspace(moduleDir, homeWorkspace);
  process.env["SHARED_WORKSPACE_PATH"] = homeWorkspace;
}

function migrateLegacyRepoWorkspace(moduleDir: string, homeWorkspace: string): void {
  const legacyWorkspace = resolve(moduleDir, "../../server/shared-workspace");
  if (!existsSync(legacyWorkspace) || legacyWorkspace === homeWorkspace) return;
  mkdirSync(homeWorkspace, { recursive: true });
  cpSync(legacyWorkspace, homeWorkspace, { recursive: true, force: false, errorOnExist: false });
}

/**
 * Same problem, same fix, for the database: `@ducki/database`'s getDatabase() resolves
 * DATABASE_PATH (default "./storage/ducki.db") relative to process.cwd(). The repo .env
 * sets that same relative value, so the CLI - started from apps/cli - was opening its own
 * apps/cli/storage/ducki.db instead of the server's apps/server/storage/ducki.db. Two
 * separate SQLite files meant two separate memory stores and two separate skill-usage
 * histories - the CLI never saw anything the server's agent had learned/used, and vice
 * versa. Pin it to the server's absolute path unless the user already set one explicitly.
 */
if (!process.env["DATABASE_PATH"] || process.env["DATABASE_PATH"] === "./storage/ducki.db") {
  process.env["DATABASE_PATH"] = resolve(moduleDir, "../../server/storage/ducki.db");
}
