import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface FileStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

function statMany(paths: string[]): FileStamp[] {
  const out: FileStamp[] = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Missing file - simply not included; its absence changes the fingerprint
      // via the caller's own directory listing already being part of watchedFiles.
    }
  }
  return out;
}

function fingerprintOf(paths: string[]): string {
  return statMany(paths)
    .map((s) => `${s.path}:${s.mtimeMs}:${s.size}`)
    .sort()
    .join("|");
}

interface CacheEntry<T> {
  fingerprint: string;
  value: T;
}

const caches = new Map<string, CacheEntry<unknown>>();

/**
 * Returns loader()'s cached result if none of watchedFiles changed (mtime/size) since
 * the last call for this cacheKey; otherwise re-runs loader() and caches the new result.
 * In-memory only, per process - the point isn't to survive restarts (a fresh process
 * pays the first-call cost anyway), it's to avoid re-reading and re-parsing every
 * SKILL.md/plugin.json on every single agent turn while still picking up file edits
 * immediately (no restart required, matching the existing hot-reload contract).
 */
export function withManifestCache<T>(cacheKey: string, watchedFiles: string[], loader: () => T): T {
  const fingerprint = fingerprintOf(watchedFiles);
  const cached = caches.get(cacheKey) as CacheEntry<T> | undefined;
  if (cached && cached.fingerprint === fingerprint) return cached.value;
  const value = loader();
  caches.set(cacheKey, { fingerprint, value });
  return value;
}

/** Lists `<skillsRoot>/<slug>/SKILL.md` for every immediate subdirectory that has one. */
export function listSkillMdFiles(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.map((slug) => join(skillsRoot, slug, "SKILL.md")).filter((p) => existsSync(p));
}
