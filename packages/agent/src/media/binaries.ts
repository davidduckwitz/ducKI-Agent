/**
 * Locates ffmpeg / ffprobe / yt-dlp for the media pipeline through @ducki/shared's component
 * resolver (settings path -> installed pack -> bundled npm binary -> system PATH).
 *
 * The npm packages that ship a binary (ffmpeg-static, yt-dlp-exec) are OPTIONAL here: they are
 * imported dynamically and only registered as the "bundled" fallback, so the app also works when
 * they are left out of the installer and the user installs the component later (Settings) or has it
 * on PATH already.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { registerBundledComponent, resolveComponentPath } from "@ducki/shared";

let bundledRegistered: Promise<void> | undefined;

function registerBundled(): Promise<void> {
  bundledRegistered ??= (async () => {
    try {
      const mod = (await import("ffmpeg-static")) as unknown as { default?: string | null };
      registerBundledComponent("ffmpeg", mod.default);
    } catch {
      /* not shipped - fine */
    }
    try {
      const entry = createRequire(import.meta.url).resolve("yt-dlp-exec");
      registerBundledComponent("yt-dlp", join(dirname(entry), "..", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
    } catch {
      /* not shipped - fine */
    }
  })();
  return bundledRegistered;
}

export async function findFfmpeg(): Promise<string | undefined> {
  await registerBundled();
  return resolveComponentPath("ffmpeg");
}

export async function findFfprobe(): Promise<string | undefined> {
  await registerBundled();
  return resolveComponentPath("ffprobe");
}

export async function findYtDlp(): Promise<string | undefined> {
  await registerBundled();
  return resolveComponentPath("yt-dlp");
}
