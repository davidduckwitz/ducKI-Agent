import type { ToolResult, ToolExecutor } from "@ducki/shared";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { globFiles, grepFiles } from "./filesystem-search.js";
import { randomBytes } from "node:crypto";
import { SHARED_WORKSPACE_ROOT } from "./workspace-root.js";

const SHARED_BASE_PATH = SHARED_WORKSPACE_ROOT;

export const FILESYSTEM_ACTIONS = [
  "read", "write", "append", "edit", "delete",
  "list", "mkdir", "exists", "stat", "move", "copy",
  "glob", "grep",
] as const;

export type FilesystemAction = typeof FILESYSTEM_ACTIONS[number];

interface PathOptions {
  basePath?: string;
  safeMode: boolean;
}

function normalizeForCompare(value: string): string {
  return resolve(value).replace(/\\+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInsideBase(basePath: string, candidatePath: string): boolean {
  const base = normalizeForCompare(basePath);
  const candidate = normalizeForCompare(candidatePath);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * Type of a path, without throwing for a missing one.
 *
 * Several actions used to check only `existsSync` and then hand the path straight to a
 * file-only fs call, so pointing them at a directory surfaced a raw Node errno
 * ("EISDIR: illegal operation on a directory, read") that tells the agent nothing about
 * what to do instead.
 */
function pathKind(candidate: string): "file" | "directory" | "other" | "missing" {
  try {
    const stats = statSync(candidate);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

function listDirectory(dirPath: string): Array<{ name: string; type: string; path: string }> {
  return readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: join(dirPath, entry.name),
  }));
}

function validateContent(filePath: string, content: string): string | undefined {
  if (extname(filePath).toLowerCase() === ".json") {
    try {
      JSON.parse(content);
    } catch (error) {
      return `Refusing to write invalid JSON to ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return undefined;
}

/**
 * Writes content via temp-file + rename (atomic on the same volume) and keeps
 * a .bak copy of the previous version, so a truncated/garbled LLM completion
 * can never leave the target file half-written and the prior version is
 * always recoverable.
 */
function atomicWrite(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    copyFileSync(filePath, `${filePath}.bak`);
  }
  const tmpPath = join(dirname(filePath), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

const ABSOLUTE_PATH_RE = /^[A-Za-z]:\\|^\\\\|^\//;

const REDUNDANT_LEADING_SEGMENT = "shared-workspace";

/**
 * Strips a redundant leading `shared-workspace/` prefix from a relative path when the base it will be
 * joined onto already ends in that segment.
 *
 * The model is told to address files as `./shared-workspace/scripts/foo.js`, but the workspace base is
 * itself `…/shared-workspace`. Joining them naively produced `…/shared-workspace/shared-workspace/scripts`.
 * Only the literal `shared-workspace` segment is stripped (not arbitrary base names) so a coding sandbox
 * whose folder happens to be named like a real subdir — e.g. a project slug `src` — is never affected,
 * and only when the base ends in that segment, so a legitimately nested `shared-workspace` folder is
 * still reachable (address it twice).
 */
function stripRedundantBaseSegment(relative: string, base: string): string {
  const normalized = relative.replace(/\\+/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const baseTail = base.replace(/\\+/g, "/").replace(/\/+$/, "").split("/").pop()?.toLowerCase();
  if (baseTail !== REDUNDANT_LEADING_SEGMENT) return normalized;
  const segments = normalized.split("/");
  if (segments[0]?.toLowerCase() === REDUNDANT_LEADING_SEGMENT) {
    segments.shift();
  }
  return segments.join("/");
}

function resolvePath(inputPath: string, options: PathOptions): string {
  const trimmed = String(inputPath ?? "").trim();
  const scopedBase = options.basePath ? resolve(options.basePath) : undefined;
  const isAbsolute = ABSOLUTE_PATH_RE.test(trimmed);

  // Coding agent: a basePath is always supplied and the path is confined to that sandbox.
  if (scopedBase) {
    const resolved = isAbsolute
      ? resolve(trimmed)
      : resolve(scopedBase, stripRedundantBaseSegment(trimmed, scopedBase));

    if (!options.safeMode) return resolved;
    if (!isInsideBase(scopedBase, resolved)) {
      throw new Error(`Path is outside basePath scope: ${trimmed}`);
    }
    return resolved;
  }

  // Normal agent: no basePath. Rebase relative paths ONTO the workspace root (rather than resolving
  // them against process.cwd() and merely rejecting the result) so a path like "scripts/foo.js" — or
  // the "./shared-workspace/scripts" convention — always lands inside the workspace regardless of cwd.
  const resolved = isAbsolute
    ? resolve(trimmed)
    : resolve(SHARED_BASE_PATH, stripRedundantBaseSegment(trimmed, SHARED_BASE_PATH));

  if (!options.safeMode) return resolved;

  if (!isInsideBase(SHARED_BASE_PATH, resolved)) {
    throw new Error(`Path is outside shared workspace: ${trimmed}. Use /api/shared or a path under ${SHARED_BASE_PATH}`);
  }

  return resolved;
}

export const filesystemTool: ToolExecutor = {
  name: "filesystem",
  description:
    "Read, write, delete, list files and directories. REQUIRED: Always provide 'action' and 'path'. " +
    "Use 'list' for directories and 'read' for files - if you are unsure what a path is, call 'stat' or 'list' first.",
  definition: {
    name: "filesystem",
    description:
      "File system operations. Required parameters: action (the operation), path (file/directory path). " +
      "All paths are scoped to shared-workspace for safety. " +
      "Directories and files take different actions: list/mkdir operate on directories, read/write/append/edit/copy operate on files.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "append", "edit", "delete", "list", "mkdir", "exists", "stat", "move", "copy", "glob", "grep"],
          description:
            "Operation to perform: read (content of a SINGLE FILE - for a directory use list instead), " +
            "write (create/overwrite file), append (add to file), " +
            "edit (replace an exact substring in an existing file - PREFER this over write for changes to existing files), " +
            "delete (remove; needs recursive:true for a directory), " +
            "list (contents of a DIRECTORY - use this for paths like ./shared-workspace), mkdir (create directory), " +
            "exists (check if exists), stat (file info incl. isDirectory - use when unsure), move (rename/move), " +
            "copy (duplicate a single file), glob (find files by pattern under path), grep (search file contents by regex under path)",
        },
        path: {
          type: "string",
          description:
            "REQUIRED: Full file or directory path. Examples: /shared-workspace/config.json, ./data/file.txt, data/subfolder/. " +
            "A path without a file extension is usually a directory - use action:'list' for it. Must be provided.",
        },
        content: { type: "string", description: "Content to write (for write/append). Use actual line breaks (newlines) in multiline content - each line should be on a separate line, not escaped as \\n." },
        offset: { type: "number", description: "For read: first line to return (0-indexed, default 0)" },
        limit: { type: "number", description: "For read: maximum number of lines to return" },
        maxBytes: { type: "number", description: "For read: byte cap before truncation (default 262144 = 256KB)" },
        pattern: { type: "string", description: "For glob: file path pattern (e.g. **/*.ts). For grep: regex to search." },
        filePattern: { type: "string", description: "For grep: optional glob pattern to restrict which files to search" },
        caseSensitive: { type: "boolean", default: false, description: "For grep: case-sensitive match (default false)" },
        maxResults: { type: "number", description: "For glob/grep: maximum results to return (default: 1000 for glob, 500 for grep)" },
        oldString: { type: "string", description: "For edit: exact existing text to replace. Must match exactly once unless replaceAll is set." },
        newString: { type: "string", description: "For edit: text to replace oldString with." },
        replaceAll: { type: "boolean", default: false, description: "For edit: replace every occurrence of oldString instead of requiring a unique match." },
        encoding: { type: "string", default: "utf8" },
        recursive: { type: "boolean", default: false },
        destination: { type: "string", description: "Destination path for move action" },
        basePath: { type: "string", description: "Optional base path to scope relative paths" },
        safeMode: { type: "boolean", default: true, description: "Reject paths outside allowed scope/basePath" },
        dryRun: { type: "boolean", default: false, description: "Validate and report action without changing files" },
        createDirs: { type: "boolean", default: true, description: "Create parent directories for write/append/move destination" },
        overwrite: { type: "boolean", default: true, description: "Allow overwriting existing file on write" },
      },
      required: ["action", "path"],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input["action"] ?? "");
    const safeMode = (input["safeMode"] as boolean | undefined) ?? true;
    const dryRun = (input["dryRun"] as boolean | undefined) ?? false;
    const createDirs = (input["createDirs"] as boolean | undefined) ?? true;
    const overwrite = (input["overwrite"] as boolean | undefined) ?? true;
    let content = input["content"] as string | undefined;
    const recursive = (input["recursive"] as boolean | undefined) ?? false;

    // De-escape literal \n, \t, \r escape sequences (from JSON string parsing)
    // ONLY convert actual escape sequences, not random 'n' characters - other patterns break code
    if (content) {
      content = content
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r");
    }

    try {
      const filePath = resolvePath(String(input["path"] ?? ""), {
        basePath: input["basePath"] as string | undefined,
        safeMode,
      });

      switch (action) {
        case "read": {
          const kind = pathKind(filePath);
          if (kind === "missing") {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          // Reading a directory is a plausible thing for an agent to try. Answer with the
          // listing it was after instead of failing the turn, and name the right action.
          if (kind === "directory") {
            const entries = listDirectory(filePath);
            return {
              success: true,
              data: {
                path: filePath,
                isDirectory: true,
                entries,
                count: entries.length,
                note: `'${filePath}' is a directory, not a file - its contents are listed above. Use action:"list" for directories, or action:"read" on one of the entry paths.`,
              },
            };
          }
          const offset = (input["offset"] as number | undefined) ?? 0;
          const limit = input["limit"] as number | undefined;
          const maxBytes = (input["maxBytes"] as number | undefined) ?? 262144;

          const raw = readFileSync(filePath, "utf8");

          if (offset > 0 || limit !== undefined) {
            const lines = raw.split("\n");
            const totalLines = lines.length;
            const sliced = lines.slice(offset, limit !== undefined ? offset + limit : undefined);
            const text = sliced.join("\n");
            const remaining = totalLines - (offset + sliced.length);
            if (text.length > maxBytes) {
              return {
                success: true,
                data: text.slice(0, maxBytes) + `\n[... truncated at ${maxBytes} bytes]`,
              };
            }
            const suffix = remaining > 0 ? `\n[lines ${offset + 1}–${offset + sliced.length} of ${totalLines}]` : "";
            return { success: true, data: text + suffix };
          }

          if (raw.length > maxBytes) {
            const lineCount = raw.split("\n").length;
            return {
              success: true,
              data:
                raw.slice(0, maxBytes) +
                `\n[... truncated: file is ${raw.length} bytes (${lineCount} lines), showing first ${maxBytes}. Use offset/limit to read specific sections.]`,
            };
          }

          return { success: true, data: raw };
        }

        case "write": {
          if (!content) return { success: false, data: null, error: "Content required for write" };
          if (!overwrite && existsSync(filePath)) {
            return { success: false, data: null, error: `File already exists: ${filePath}` };
          }
          const dir = dirname(filePath);
          if (!existsSync(dir) && createDirs) mkdirSync(dir, { recursive: true });
          if (!existsSync(dir) && !createDirs) {
            return { success: false, data: null, error: `Parent directory does not exist: ${dir}` };
          }
          const validationError = validateContent(filePath, content);
          if (validationError) return { success: false, data: null, error: validationError };
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, bytes: content.length } };
          }
          atomicWrite(filePath, content);
          return { success: true, data: { path: filePath, bytes: content.length } };
        }

        case "append": {
          if (!content) return { success: false, data: null, error: "Content required for append" };
          const dir = dirname(filePath);
          if (!existsSync(dir) && createDirs) mkdirSync(dir, { recursive: true });
          if (!existsSync(dir) && !createDirs) {
            return { success: false, data: null, error: `Parent directory does not exist: ${dir}` };
          }
          if (pathKind(filePath) === "directory") {
            return { success: false, data: null, error: `Cannot append: '${filePath}' is a directory, not a file.` };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, bytes: content.length } };
          }
          const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
          const combined = previous + content;
          const validationError = validateContent(filePath, combined);
          if (validationError) return { success: false, data: null, error: validationError };
          atomicWrite(filePath, combined);
          return { success: true, data: { path: filePath } };
        }

        case "edit": {
          let oldString = input["oldString"] as string | undefined;
          let newString = input["newString"] as string | undefined;
          const replaceAll = (input["replaceAll"] as boolean | undefined) ?? false;

          // De-escape newString and oldString
          if (newString) {
            newString = newString
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\r/g, "\r");
          }
          if (oldString) {
            oldString = oldString
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\r/g, "\r");
          }
          if (!oldString) return { success: false, data: null, error: "oldString required for edit" };
          if (newString === undefined) return { success: false, data: null, error: "newString required for edit" };
          const editKind = pathKind(filePath);
          if (editKind === "missing") {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          if (editKind === "directory") {
            return {
              success: false,
              data: null,
              error: `Cannot edit: '${filePath}' is a directory, not a file. Use action:"list" to see its contents and edit a file inside it.`,
            };
          }
          const original = readFileSync(filePath, "utf8");
          const occurrences = original.split(oldString).length - 1;
          if (occurrences === 0) {
            return { success: false, data: null, error: `oldString not found in file: ${filePath}` };
          }
          if (occurrences > 1 && !replaceAll) {
            return {
              success: false,
              data: null,
              error: `oldString is not unique (${occurrences} matches) in ${filePath}. Provide more surrounding context or set replaceAll:true.`,
            };
          }
          const updated = replaceAll
            ? original.split(oldString).join(newString)
            : original.replace(oldString, newString);
          const validationError = validateContent(filePath, updated);
          if (validationError) return { success: false, data: null, error: validationError };
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, occurrences } };
          }
          atomicWrite(filePath, updated);
          return { success: true, data: { path: filePath, occurrences } };
        }

        case "delete": {
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Path not found: ${filePath}` };
          }
          if (!recursive && pathKind(filePath) === "directory") {
            return {
              success: false,
              data: null,
              error: `'${filePath}' is a directory. Pass recursive:true to delete it and everything inside.`,
            };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, recursive } };
          }
          rmSync(filePath, { recursive });
          return { success: true, data: { deleted: filePath } };
        }

        case "list": {
          const listKind = pathKind(filePath);
          if (listKind === "missing") {
            return { success: false, data: null, error: `Directory not found: ${filePath}` };
          }
          // The mirror image of read-on-a-directory: readdirSync would throw ENOTDIR.
          if (listKind === "file") {
            return {
              success: false,
              data: null,
              error: `'${filePath}' is a file, not a directory. Use action:"read" to read its contents.`,
            };
          }
          return { success: true, data: listDirectory(filePath) };
        }

        case "mkdir": {
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath } };
          }
          mkdirSync(filePath, { recursive: true });
          return { success: true, data: { created: filePath } };
        }

        case "exists": {
          return { success: true, data: { exists: existsSync(filePath), path: filePath } };
        }

        case "stat": {
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Path not found: ${filePath}` };
          }
          const stats = statSync(filePath);
          return {
            success: true,
            data: {
              path: filePath,
              size: stats.size,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
              modified: stats.mtime.toISOString(),
              created: stats.birthtime.toISOString(),
            },
          };
        }

        case "move": {
          const dest = input["destination"] as string | undefined;
          if (!dest) return { success: false, data: null, error: "Destination required for move" };
          const destPath = resolvePath(dest, {
            basePath: input["basePath"] as string | undefined,
            safeMode,
          });
          const destDir = dirname(destPath);
          if (!existsSync(destDir) && createDirs) mkdirSync(destDir, { recursive: true });
          if (!existsSync(destDir) && !createDirs) {
            return { success: false, data: null, error: `Destination directory does not exist: ${destDir}` };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, from: filePath, to: destPath } };
          }
          renameSync(filePath, destPath);
          return { success: true, data: { from: filePath, to: destPath } };
        }

        case "copy": {
          const dest = input["destination"] as string | undefined;
          if (!dest) return { success: false, data: null, error: "Destination required for copy" };
          const destPath = resolvePath(dest, {
            basePath: input["basePath"] as string | undefined,
            safeMode,
          });
          const destDir = dirname(destPath);
          if (!existsSync(destDir) && createDirs) mkdirSync(destDir, { recursive: true });
          if (!existsSync(destDir) && !createDirs) {
            return { success: false, data: null, error: `Destination directory does not exist: ${destDir}` };
          }
          const copyKind = pathKind(filePath);
          if (copyKind === "missing") {
            return { success: false, data: null, error: `Source file not found: ${filePath}` };
          }
          if (copyKind === "directory") {
            return {
              success: false,
              data: null,
              error: `Cannot copy: '${filePath}' is a directory. Copy individual files, or use the shell tool for a recursive copy.`,
            };
          }
          if (!overwrite && existsSync(destPath)) {
            return { success: false, data: null, error: `Destination already exists: ${destPath}` };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, from: filePath, to: destPath } };
          }
          copyFileSync(filePath, destPath);
          return { success: true, data: { from: filePath, to: destPath } };
        }

        case "glob": {
          const pattern = input["pattern"] as string | undefined;
          if (!pattern) return { success: false, data: null, error: "pattern required for glob" };
          const maxResults = (input["maxResults"] as number | undefined) ?? 1000;
          const matches = globFiles(filePath, pattern, { maxResults });
          return { success: true, data: { matches, count: matches.length } };
        }

        case "grep": {
          const pattern = input["pattern"] as string | undefined;
          if (!pattern) return { success: false, data: null, error: "pattern required for grep" };
          const filePattern = input["filePattern"] as string | undefined;
          const maxResults = (input["maxResults"] as number | undefined) ?? 500;
          const caseSensitive = (input["caseSensitive"] as boolean | undefined) ?? false;
          const matches = grepFiles(filePath, pattern, { filePattern, maxResults, caseSensitive });
          return { success: true, data: { matches, count: matches.length } };
        }

        default:
          return {
            success: false,
            data: null,
            error: `Unknown action: ${action}. Valid actions: ${FILESYSTEM_ACTIONS.join(", ")}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
