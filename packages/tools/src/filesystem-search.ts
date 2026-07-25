import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join, relative, basename } from "node:path";

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GlobOptions {
  maxResults?: number;
}

export interface GrepOptions {
  filePattern?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

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

function walkDir(dir: string, results: string[], limit: number): void {
  if (results.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) break;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results, limit);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
}

export function globFiles(rootPath: string, pattern: string, options: GlobOptions = {}): string[] {
  const limit = options.maxResults ?? 1000;
  if (!existsSync(rootPath)) return [];

  const allFiles: string[] = [];
  walkDir(rootPath, allFiles, limit * 4);

  const patternRegex = globToRegex(pattern);

  return allFiles
    .filter((f) => {
      const rel = relative(rootPath, f).replace(/\\/g, "/");
      return patternRegex.test(rel) || patternRegex.test(basename(f));
    })
    .slice(0, limit);
}

export function grepFiles(rootPath: string, pattern: string, options: GrepOptions = {}): GrepMatch[] {
  const limit = options.maxResults ?? 500;
  const caseSensitive = options.caseSensitive ?? false;

  if (!existsSync(rootPath)) return [];

  let filesToSearch: string[];
  if (options.filePattern) {
    filesToSearch = globFiles(rootPath, options.filePattern, { maxResults: 2000 });
  } else {
    filesToSearch = [];
    walkDir(rootPath, filesToSearch, 2000);
  }

  const flags = caseSensitive ? "" : "i";
  const results: GrepMatch[] = [];

  for (const filePath of filesToSearch) {
    if (results.length >= limit) break;
    let content: string;
    try {
      const buf = readFileSync(filePath);
      if (buf.includes(0)) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      if (results.length >= limit) break;
      const re = new RegExp(pattern, flags);
      if (re.test(lines[ln]!)) {
        results.push({ path: filePath, line: ln + 1, text: lines[ln]!.trim() });
      }
    }
  }

  return results;
}
