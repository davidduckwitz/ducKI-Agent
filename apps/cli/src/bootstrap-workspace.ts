import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Pins the shared-workspace root before `@ducki/tools` captures it (see the server's
 * bootstrap-workspace for the full rationale). Must be the first import in the CLI entry.
 *
 * The CLI shares the server package's workspace so both agree on one root. An explicit
 * `SHARED_WORKSPACE_PATH` from the repo .env still wins, so it is loaded here first.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(moduleDir, "../../../.env") });
if (!process.env["SHARED_WORKSPACE_PATH"]) {
  process.env["SHARED_WORKSPACE_PATH"] = resolve(moduleDir, "../../server/shared-workspace");
}
