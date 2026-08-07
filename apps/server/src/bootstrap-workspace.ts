import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pins the shared-workspace root to an absolute path anchored to THIS server package.
 *
 * `@ducki/tools` (and the other consumers) read `SHARED_WORKSPACE_PATH` at module-load time and
 * otherwise default the root to `process.cwd()`. Because cwd varies with how the process is
 * launched, the agent used to read/write a different directory depending on the launcher. This
 * module MUST be imported before `@ducki/tools` (it is the first import in index.ts, right after
 * dotenv) so the env is set before the tools module captures it. An explicit `SHARED_WORKSPACE_PATH`
 * (e.g. from .env) still takes precedence.
 *
 * moduleDir is `apps/server/src` under tsx and `apps/server/dist` when built; `../shared-workspace`
 * resolves to `apps/server/shared-workspace` in both cases.
 */
if (!process.env["SHARED_WORKSPACE_PATH"]) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  process.env["SHARED_WORKSPACE_PATH"] = resolve(moduleDir, "../shared-workspace");
}
