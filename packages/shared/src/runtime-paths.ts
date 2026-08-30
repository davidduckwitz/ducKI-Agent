import { homedir } from "node:os";
import { resolve } from "node:path";

/** Stable per-user DucKI data root, independent of the process working directory. */
export function duckiHome(): string {
  return resolve(process.env["DUCKI_HOME"]?.trim() || resolve(homedir(), "DucKI"));
}

export function pluginsRoot(): string {
  const configured = process.env["DUCKI_PLUGINS_DIR"]?.trim() || process.env["PLUGINS_PATH"]?.trim();
  return resolve(configured || resolve(duckiHome(), "plugins"));
}

export function skillsRoot(): string {
  return resolve(process.env["SKILLS_PATH"]?.trim() || resolve(duckiHome(), "skills"));
}

export function sharedWorkspaceRoot(): string {
  return resolve(process.env["SHARED_WORKSPACE_PATH"]?.trim() || resolve(duckiHome(), "shared-workspace"));
}
