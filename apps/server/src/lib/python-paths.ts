import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { duckiHome } from "@ducki/shared";

/**
 * Where the local Python model servers (STT, Chatterbox, Pocket TTS, Qwen3-TTS) live.
 *
 * Dev: apps/server/scripts/ holds the scripts, their venvs and the voices/ library side by side.
 * Desktop: build.js ships the scripts next to the bundled server (server-dist/python-scripts/),
 * which is replaced on every update - so venvs (GBs) and the user's voices go to
 * <duckiHome>/python/ instead, where they survive updates.
 */
const bundled = fileURLToPath(new URL("./python-scripts/", import.meta.url));
const IS_BUNDLED = existsSync(bundled);

export const PYTHON_SCRIPTS_DIR = IS_BUNDLED ? bundled : fileURLToPath(new URL("../../scripts/", import.meta.url));

/** venvs and voices/; ends with a path separator like PYTHON_SCRIPTS_DIR. */
export const PYTHON_DATA_DIR = IS_BUNDLED ? join(duckiHome(), "python") + (process.platform === "win32" ? "\\" : "/") : PYTHON_SCRIPTS_DIR;
export const VOICES_DIR = `${PYTHON_DATA_DIR}voices/`;

if (IS_BUNDLED) {
  // Seed the user's library with the reference voices shipped in the installer - per file, so a
  // voice added in an update arrives too; existing files (same name) are never overwritten.
  mkdirSync(VOICES_DIR, { recursive: true });
  if (existsSync(`${bundled}voices`)) cpSync(`${bundled}voices`, VOICES_DIR, { recursive: true, force: false });
}

export const venvPython = (venvDir: string) => `${venvDir}/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;

/** Env for a spawned Python server: the scripts read DUCKI_VOICES_DIR (fallback: voices/ beside them). */
export const pythonServerEnv = (): NodeJS.ProcessEnv => ({ DUCKI_VOICES_DIR: VOICES_DIR });
