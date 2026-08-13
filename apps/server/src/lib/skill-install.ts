/**
 * Skill installation from a remote source (folder-level).
 *
 * Downloads a tar.gz bundle, extracts it into a sandboxed temp directory with
 * strict guards against untrusted archives (path traversal, size, file count,
 * path whitelist), locates the skill's SKILL.md, validates it against the
 * agentskills.io spec, and atomically installs it into the skills root.
 *
 * Sources supported by `resolveSkillSource`:
 *   - `catalog:<id>`         -> the project's own landing catalog (CATALOG_API_URL)
 *   - `owner/repo[/subpath]` -> GitHub tarball of the default branch (or `ref`)
 *   - a direct https .tar.gz / .tgz URL
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import { validateSkillContent } from "@ducki/agent";

// --- Limits (defensive defaults for untrusted archives) ---------------------
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MB compressed
const MAX_TOTAL_UNCOMPRESSED = 20 * 1024 * 1024; // 20 MB
const MAX_FILES = 400;
const DOWNLOAD_TIMEOUT_MS = 15000;

// Only these top-level entries are allowed out of a bundle.
const ALLOWED_ROOT = new Set([
  "SKILL.md",
  "script.js", // legacy single-file script skills
  "scripts",
  "references",
  "assets",
  "LICENSE",
  "LICENSE.txt",
  "README.md",
]);

export interface ResolvedSource {
  kind: "catalog" | "github" | "bundle-url";
  /** URL to download the tar.gz from. */
  url: string;
  /** Optional slug hint (from catalog id). */
  slugHint?: string;
}

export interface InstallResult {
  slug: string;
  files: string[];
  source: string;
}

function catalogBaseUrl(): string {
  return (
    process.env["CATALOG_API_URL"]?.trim() ||
    "https://ducki.cloud/api/v1"
  );
}

/** Resolve a user-supplied source string into a concrete download URL. */
export function resolveSkillSource(input: string, ref?: string): ResolvedSource {
  const raw = input.trim();
  if (!raw) throw new Error("Empty skill source");

  // catalog:<id>
  if (raw.startsWith("catalog:")) {
    const id = raw.slice("catalog:".length).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid catalog id");
    const base = catalogBaseUrl();
    const sep2 = base.includes("?") ? "&" : "?";
    return { kind: "catalog", url: `${base}${sep2}action=download&id=${encodeURIComponent(id)}`, slugHint: id };
  }

  // Direct tarball URL
  if (/^https:\/\/.+\.(tar\.gz|tgz)(\?.*)?$/i.test(raw)) {
    return { kind: "bundle-url", url: raw };
  }

  // GitHub owner/repo[/subpath]
  const gh = raw.replace(/^https?:\/\/github\.com\//i, "");
  const m = gh.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
  if (m) {
    const owner = m[1];
    const repo = m[2]!.replace(/\.git$/, "");
    const branch = ref?.trim() || "HEAD";
    return {
      kind: "github",
      url: `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`,
      slugHint: m[3] ? m[3].split("/").pop() : repo,
    };
  }

  throw new Error("Unrecognized source. Use 'catalog:<id>', 'owner/repo', or an https .tar.gz URL.");
}

/** Download a URL into a file, enforcing a byte cap and timeout. */
async function downloadToFile(url: string, destFile: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "ducki-skills-importer",
        Accept: "application/octet-stream, application/gzip, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Bundle too large: ${declared} bytes (max ${MAX_DOWNLOAD_BYTES})`);
    }
    if (!res.body) throw new Error("Empty response body");

    let received = 0;
    const nodeStream = Readable.fromWeb(res.body as any);
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        nodeStream.destroy(new Error(`Bundle exceeds ${MAX_DOWNLOAD_BYTES} bytes`));
      }
    });
    await pipeline(nodeStream, createWriteStream(destFile));
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a tar.gz into destDir with strict guards. Returns extracted entry paths. */
async function extractGuarded(tarFile: string, destDir: string): Promise<string[]> {
  const entries: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  await tar.x({
    file: tarFile,
    cwd: destDir,
    preservePaths: false, // reject absolute paths and `..` (Zip-Slip protection)
    // Strip a single leading wrapper dir (GitHub tarballs wrap in `owner-repo-sha/`).
    // We do NOT strip for our own bundles; detect below by locating SKILL.md.
    filter: (path: string, entry: any) => {
      // Normalize and reject anything trying to escape.
      const norm = path.replace(/\\/g, "/");
      if (norm.includes("..") || norm.startsWith("/")) return false;
      // Only regular files and directories.
      const type = entry.type;
      if (type !== "File" && type !== "Directory" && type !== "0" && type !== "5") {
        return false; // no symlinks, hardlinks, devices, etc.
      }
      fileCount++;
      if (fileCount > MAX_FILES) throw new Error(`Too many files in bundle (max ${MAX_FILES})`);
      totalBytes += entry.size ?? 0;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error(`Bundle uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED} bytes`);
      }
      entries.push(norm);
      return true;
    },
  });

  return entries;
}

/** Recursively find the shallowest directory containing a SKILL.md file. */
async function findSkillDir(root: string, maxDepth = 4): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (dirents.some((d) => d.isFile() && d.name === "SKILL.md")) return dir;
    if (depth < maxDepth) {
      for (const d of dirents) {
        if (d.isDirectory()) queue.push({ dir: join(dir, d.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

/** Copy only whitelisted top-level entries from srcDir into destDir. */
async function copyWhitelisted(srcDir: string, destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];
  const dirents = await readdir(srcDir, { withFileTypes: true });
  for (const d of dirents) {
    if (!ALLOWED_ROOT.has(d.name)) continue;
    const from = join(srcDir, d.name);
    const to = join(destDir, d.name);
    await cp(from, to, { recursive: true });
    copied.push(d.name);
  }
  return copied;
}

/**
 * Install a skill from a resolved source into `skillsRoot`.
 * Validates spec-conformance before committing. Throws on any guard violation.
 */
export async function installSkillFromSource(opts: {
  source: string;
  ref?: string;
  skillsRoot: string;
  slug?: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const resolved = resolveSkillSource(opts.source, opts.ref);
  const work = await mkdtemp(join(tmpdir(), "ducki-skill-"));
  const tarFile = join(work, "bundle.tar.gz");
  try {
    await downloadToFile(resolved.url, tarFile);
    return await installFromTarball(tarFile, {
      skillsRoot: opts.skillsRoot,
      slug: opts.slug ?? resolved.slugHint,
      overwrite: opts.overwrite,
      source: resolved.url,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Install from an already-downloaded tar.gz file. Extracts with guards,
 * validates spec-conformance, and atomically installs. Network-free and
 * therefore unit-testable in isolation.
 */
export async function installFromTarball(
  tarFile: string,
  opts: { skillsRoot: string; slug?: string; overwrite?: boolean; source?: string }
): Promise<InstallResult> {
  const work = await mkdtemp(join(tmpdir(), "ducki-skill-x-"));
  const extractDir = join(work, "extract");
  await mkdir(extractDir, { recursive: true });

  try {
    await extractGuarded(tarFile, extractDir);

    const skillSrcDir = await findSkillDir(extractDir);
    if (!skillSrcDir) throw new Error("No SKILL.md found in bundle");

    const content = await readFile(join(skillSrcDir, "SKILL.md"), "utf8");

    const slug = (opts.slug ?? "").trim();
    if (!slug) throw new Error("Could not determine skill slug; provide 'slug'.");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`Invalid slug: ${slug}`);

    const validation = validateSkillContent(content, slug);
    if (!validation.valid) {
      throw new Error(
        "Skill is not agentskills.io spec-conformant: " +
          validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ")
      );
    }

    const destDir = resolve(opts.skillsRoot, slug);
    // Defense in depth: destination must stay within skillsRoot.
    if (!destDir.startsWith(resolve(opts.skillsRoot) + sep)) {
      throw new Error("Resolved destination escapes skills root");
    }

    const exists = await stat(destDir).then(() => true).catch(() => false);
    if (exists && !opts.overwrite) {
      throw new Error("Skill already exists");
    }

    // Stage into skillsRoot, then atomically swap into place.
    const staging = `${destDir}.incoming-${Date.now()}`;
    const files = await copyWhitelisted(skillSrcDir, staging);
    if (!files.includes("SKILL.md")) {
      await rm(staging, { recursive: true, force: true });
      throw new Error("Bundle SKILL.md was filtered out by whitelist");
    }
    if (exists) await rm(destDir, { recursive: true, force: true });
    await rename(staging, destDir);

    return { slug, files, source: opts.source ?? tarFile };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
