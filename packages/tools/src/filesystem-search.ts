import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, statSync, type Dirent } from "node:fs";
import { join, relative, basename } from "node:path";

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GlobOptions {
  maxResults?: number;
  /** Walk into node_modules/.git/dist/... and ignore .gitignore. Off by default. */
  includeIgnored?: boolean;
  /** Extra directory names to skip, on top of the defaults. */
  extraIgnores?: string[];
}

export interface GrepOptions {
  filePattern?: string;
  maxResults?: number;
  caseSensitive?: boolean;
  includeIgnored?: boolean;
  extraIgnores?: string[];
  /** Files larger than this are skipped entirely (default 2 MB). Minified bundles and
   *  lockfiles otherwise dominate both the wall-clock time and the result list. */
  maxFileBytes?: number;
}

/**
 * Directories that are never source code and always dwarf it in size. Walking them is the
 * single biggest cost in a naive repo search: on a typical Node project `node_modules` holds
 * 100-500x more files than `src`, so an unfiltered walk spends all of its result budget there
 * and hands the agent matches from dependencies it cannot edit.
 */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  // The coding agent's own checkpoint store, which sits INSIDE each project it manages.
  ".ducki-checkpoints",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "vendor",
  "bin",
  "obj",
  ".gradle",
  ".idea",
  ".vscode-test",
  ".terraform",
  ".serverless",
  ".DS_Store",
]);

/** Extensions that are binary or generated and never worth grepping/reading as text. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".avif",
  ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi", ".mkv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".wasm",
  ".sqlite", ".sqlite-shm", ".sqlite-wal", ".db",
  ".pyc", ".pyo", ".class", ".jar", ".o", ".a", ".lib", ".pdb",
  ".lock",
]);

/** Files that are text but are generated noise - matching inside them is never actionable. */
const IGNORED_FILENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let result = "";
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i]!;

    if (ch === "*" && normalized[i + 1] === "*") {
      result += ".*";
      i += 2;
      if (normalized[i] === "/") i++;
    } else if (ch === "*") {
      result += "[^/]*";
      i++;
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = normalized.indexOf("}", i);
      if (end === -1) {
        result += "\\{";
        i++;
      } else {
        const inner = normalized.slice(i + 1, end);
        result += "(" + inner.split(",").map(escapeRegexChar).join("|") + ")";
        i = end + 1;
      }
    } else if (ch === "[") {
      const end = normalized.indexOf("]", i);
      if (end === -1) {
        result += "\\[";
        i++;
      } else {
        result += normalized.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      result += escapeRegexChar(ch);
      i++;
    }
  }

  return new RegExp(`^${result}$`);
}

/**
 * Reads the repo's own .gitignore so a project's build output is skipped even when its folder
 * isn't in DEFAULT_IGNORED_DIRS. Deliberately a subset of git's semantics - only the forms that
 * actually matter for "don't search this": plain names, directory entries, and simple globs.
 * Negations (`!foo`) are skipped rather than half-implemented, so an unsupported pattern can
 * only ever make the search broader, never silently hide a file the agent needs.
 */
function readGitignorePatterns(rootPath: string): RegExp[] {
  const gitignorePath = join(rootPath, ".gitignore");
  if (!existsSync(gitignorePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(gitignorePath, "utf8");
  } catch {
    return [];
  }

  const patterns: RegExp[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const cleaned = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!cleaned) continue;
    try {
      // An anchored pattern matches from the root; an unanchored one matches at any depth.
      const anchored = trimmed.startsWith("/") || cleaned.includes("/");
      const body = globToRegex(cleaned).source.replace(/^\^/, "").replace(/\$$/, "");
      patterns.push(new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`));
    } catch {
      // A pattern we cannot translate is skipped - see the doc comment above.
    }
  }
  return patterns;
}

interface WalkContext {
  rootPath: string;
  ignoredDirs: ReadonlySet<string>;
  gitignore: RegExp[];
  /** Called for every candidate file; return false to stop the walk early. */
  onFile: (absolutePath: string, relativePath: string) => boolean;
}

function isIgnoredRelative(relativePath: string, ctx: WalkContext): boolean {
  return ctx.gitignore.some((re) => re.test(relativePath));
}

function walk(dir: string, ctx: WalkContext): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return true;
  }

  // Files before directories: a shallow, more relevant match should land inside the result
  // budget before the walk descends into deep subtrees.
  const dirs: Dirent[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry);
      continue;
    }
    if (!entry.isFile()) continue;
    const fullPath = join(dir, entry.name);
    const rel = relative(ctx.rootPath, fullPath).replace(/\\/g, "/");
    if (isIgnoredRelative(rel, ctx)) continue;
    if (!ctx.onFile(fullPath, rel)) return false;
  }

  for (const entry of dirs) {
    if (ctx.ignoredDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    const rel = relative(ctx.rootPath, fullPath).replace(/\\/g, "/");
    if (isIgnoredRelative(rel, ctx)) continue;
    if (!walk(fullPath, ctx)) return false;
  }

  return true;
}

function buildIgnoredDirs(includeIgnored: boolean | undefined, extra: string[] | undefined): ReadonlySet<string> {
  if (includeIgnored) return extra && extra.length > 0 ? new Set(extra) : new Set<string>();
  if (!extra || extra.length === 0) return DEFAULT_IGNORED_DIRS;
  return new Set([...DEFAULT_IGNORED_DIRS, ...extra]);
}

export function globFiles(rootPath: string, pattern: string, options: GlobOptions = {}): string[] {
  const limit = options.maxResults ?? 1000;
  if (limit <= 0 || !existsSync(rootPath)) return [];

  let patternRegex: RegExp;
  try {
    patternRegex = globToRegex(pattern);
  } catch {
    return [];
  }

  const results: string[] = [];
  const ctx: WalkContext = {
    rootPath,
    ignoredDirs: buildIgnoredDirs(options.includeIgnored, options.extraIgnores),
    gitignore: options.includeIgnored ? [] : readGitignorePatterns(rootPath),
    // The pattern is tested DURING the walk, not after collecting a fixed multiple of the
    // limit. The old "collect limit*4 files, then filter" approach filled its buffer with
    // whatever the walker hit first and could return nothing at all on a large repo even
    // though matches existed further in.
    onFile: (absolutePath, relativePath) => {
      if (patternRegex.test(relativePath) || patternRegex.test(basename(absolutePath))) {
        results.push(absolutePath);
      }
      return results.length < limit;
    },
  };

  walk(rootPath, ctx);
  return results;
}

/** Cheap binary sniff: read the first 4KB and look for a NUL byte, instead of loading the
 *  whole file into memory just to discover it is a 40MB video. */
function looksBinary(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

function isSearchableFile(filePath: string, maxFileBytes: number): boolean {
  const name = basename(filePath);
  if (IGNORED_FILENAMES.has(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())) return false;
  try {
    if (statSync(filePath).size > maxFileBytes) return false;
  } catch {
    return false;
  }
  return !looksBinary(filePath);
}

export function grepFiles(rootPath: string, pattern: string, options: GrepOptions = {}): GrepMatch[] {
  const limit = options.maxResults ?? 500;
  const caseSensitive = options.caseSensitive ?? false;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  if (limit <= 0 || !existsSync(rootPath)) return [];

  // Compiled ONCE. The previous implementation called `new RegExp(pattern, flags)` inside the
  // per-line loop, i.e. once per line of every file searched - by far the dominant cost on any
  // repo-sized input.
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`);
  }

  let filePattern: RegExp | undefined;
  if (options.filePattern) {
    try {
      filePattern = globToRegex(options.filePattern);
    } catch {
      filePattern = undefined;
    }
  }

  const results: GrepMatch[] = [];

  const searchFile = (absolutePath: string): void => {
    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      if (results.length >= limit) return;
      const line = lines[ln]!;
      if (matcher.test(line)) {
        // A minified bundle is one 2MB "line"; returning it verbatim would blow the whole
        // context on a single match.
        const text = line.trim();
        results.push({ path: absolutePath, line: ln + 1, text: text.length > 500 ? `${text.slice(0, 500)}…` : text });
      }
    }
  };

  const ctx: WalkContext = {
    rootPath,
    ignoredDirs: buildIgnoredDirs(options.includeIgnored, options.extraIgnores),
    gitignore: options.includeIgnored ? [] : readGitignorePatterns(rootPath),
    onFile: (absolutePath, relativePath) => {
      if (results.length >= limit) return false;
      if (filePattern && !filePattern.test(relativePath) && !filePattern.test(basename(absolutePath))) return true;
      if (!isSearchableFile(absolutePath, maxFileBytes)) return true;
      searchFile(absolutePath);
      return results.length < limit;
    },
  };

  walk(rootPath, ctx);
  return results;
}
