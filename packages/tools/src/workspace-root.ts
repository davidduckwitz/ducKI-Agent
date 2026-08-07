import { resolve } from "node:path";

/**
 * Single source of truth for the shared-workspace root.
 *
 * Historically this expression (`resolve(process.env.SHARED_WORKSPACE_PATH ?? "./shared-workspace")`)
 * was duplicated across five modules. Because the default is anchored to `process.cwd()`, the SAME
 * relative path resolved to three different physical directories depending on how the server was
 * launched (Tauri dev = repo root, Tauri prod = exe dir, `npm start` = apps/server). That is the
 * root cause of the "agent reads/writes the wrong directory" bug and the `shared-workspace/shared-workspace`
 * double-nesting artifact.
 *
 * All consumers must import from here so there is exactly one root definition per process. For
 * cross-launch determinism the launchers additionally set `SHARED_WORKSPACE_PATH` to an absolute
 * path, which this constant honors.
 */
export const SHARED_WORKSPACE_ROOT = resolve(
  process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace"
);

/** Root for coding-agent sandboxes: `<workspace>/coding`. */
export const CODING_WORKSPACE_ROOT = resolve(SHARED_WORKSPACE_ROOT, "coding");
