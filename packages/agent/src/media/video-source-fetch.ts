/**
 * Downloads a video from a URL (YouTube/TikTok/Instagram/X and hundreds more sites via yt-dlp,
 * or a direct video file link as a fallback) - the shared primitive behind the Cloud Voice-App's
 * automatic video detection (cloud-control.ts's "video.preview") and the `artifact` tool's
 * refetch_video action. Mirrors the download logic in apps/server/plugins/social-media/tools/
 * social-media.js, generalized so both core call sites can use ONE implementation instead of
 * three copies of the same yt-dlp/direct-fetch dance.
 */
import ytDlp from "yt-dlp-exec";
import ffmpegPath from "ffmpeg-static";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@ducki/logger";

/** Guard against an accidentally-huge download - matches media/video-processing.ts's own cap. */
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

const PLATFORM_HOST_MATCHERS: Array<{ platform: string; test: (host: string) => boolean }> = [
  { platform: "YouTube", test: (h) => h.includes("youtube.com") || h === "youtu.be" },
  { platform: "TikTok", test: (h) => h.includes("tiktok.com") },
  { platform: "Instagram", test: (h) => h.includes("instagram.com") },
  { platform: "X", test: (h) => h.includes("x.com") || h.includes("twitter.com") },
];

/** Best-effort source label for display - falls back to the bare hostname for anything else. */
export function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const matched = PLATFORM_HOST_MATCHERS.find((m) => m.test(host));
    return matched ? matched.platform : host;
  } catch {
    return "Web";
  }
}

/** The four platforms the Voice-App auto-triggers video analysis for (see cloud-control.ts) -
 *  a URL to any OTHER yt-dlp-supported site still works via fetchVideoFromUrl(), just isn't
 *  auto-detected client-side; the user can still paste it and get the plain URL preview. */
export function isKnownVideoPlatform(url: string): boolean {
  return ["YouTube", "TikTok", "Instagram", "X"].includes(detectPlatform(url));
}

export interface VideoFetchResult {
  buffer: Buffer;
  title?: string;
  platform: string;
}

/** Downloads a video from a URL. Returns null (never throws) if the URL is neither a
 *  yt-dlp-supported page nor a direct video file - e.g. a plain webpage or an image link. */
export async function fetchVideoFromUrl(url: string, logger: Logger): Promise<VideoFetchResult | null> {
  const platform = detectPlatform(url);

  try {
    const info = await ytDlp(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, skipDownload: true });
    if (info && typeof info === "object" && "id" in info && (info as { id?: unknown }).id) {
      const workDir = await mkdtemp(join(tmpdir(), "ducki-video-fetch-"));
      try {
        await ytDlp(url, {
          output: join(workDir, "video.%(ext)s"),
          format: "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
          mergeOutputFormat: "mp4",
          noPlaylist: true,
          maxFilesize: "80M",
          ffmpegLocation: (ffmpegPath as unknown as string | null) || undefined,
          noWarnings: true,
        });
        const files = await readdir(workDir);
        const match = files.find((f) => f.startsWith("video."));
        if (!match) return null;
        const buffer = await readFile(join(workDir, match));
        const title = (info as { title?: unknown }).title;
        return { buffer, title: typeof title === "string" ? title : undefined, platform };
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (error) {
    logger.debug("yt-dlp probe/download failed, trying a direct video fetch", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0]?.trim() ?? "";
    if (!contentType.startsWith("video/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_VIDEO_BYTES) return null;
    return { buffer, platform };
  } catch {
    return null;
  }
}
