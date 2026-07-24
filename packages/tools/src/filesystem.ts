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
import { randomBytes } from "node:crypto";

const SHARED_BASE_PATH = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");

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

function resolvePath(inputPath: string, options: PathOptions): string {
  const trimmed = String(inputPath ?? "").trim();
  const scopedBase = options.basePath ? resolve(options.basePath) : undefined;
  const resolved = scopedBase && !trimmed.match(/^[A-Za-z]:\\|^\\\\|^\//)
    ? resolve(scopedBase, trimmed)
    : resolve(trimmed);

  if (!options.safeMode) return resolved;

  if (scopedBase) {
    if (!isInsideBase(scopedBase, resolved)) {
      throw new Error(`Path is outside basePath scope: ${trimmed}`);
    }
    return resolved;
  }

  if (!isInsideBase(SHARED_BASE_PATH, resolved)) {
    throw new Error(`Path is outside shared workspace: ${trimmed}. Use /api/shared or a path under ${SHARED_BASE_PATH}`);
  }

  return resolved;
}

export const filesystemTool: ToolExecutor = {
  name: "filesystem",
  description: "Read, write, delete, list files and directories. REQUIRED: Always provide 'action' and 'path' parameters.",
  definition: {
    name: "filesystem",
    description: "File system operations. Required parameters: action (the operation), path (file/directory path). All paths are scoped to shared-workspace for safety.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "append", "edit", "delete", "list", "mkdir", "exists", "stat", "move", "copy"],
          description: "Operation to perform: read (file content), write (create/overwrite file), append (add to file), edit (replace an exact substring in an existing file - PREFER this over write for changes to existing files), delete (remove), list (directory contents), mkdir (create directory), exists (check if exists), stat (file info), move (rename/move), copy (duplicate)",
        },
        path: {
          type: "string",
          description: "REQUIRED: Full file or directory path. Examples: /shared-workspace/config.json, ./data/file.txt, data/subfolder/. Must be provided.",
        },
        content: { type: "string", description: "Content to write (for write/append)" },
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
    const content = input["content"] as string | undefined;
    const recursive = (input["recursive"] as boolean | undefined) ?? false;

    try {
      const filePath = resolvePath(String(input["path"] ?? ""), {
        basePath: input["basePath"] as string | undefined,
        safeMode,
      });

      switch (action) {
        case "read": {
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          const data = readFileSync(filePath, "utf8");
          return { success: true, data };
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
          const oldString = input["oldString"] as string | undefined;
          const newString = input["newString"] as string | undefined;
          const replaceAll = (input["replaceAll"] as boolean | undefined) ?? false;
          if (!oldString) return { success: false, data: null, error: "oldString required for edit" };
          if (newString === undefined) return { success: false, data: null, error: "newString required for edit" };
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `File not found: ${filePath}` };
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
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, recursive } };
          }
          rmSync(filePath, { recursive });
          return { success: true, data: { deleted: filePath } };
        }

        case "list": {
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Directory not found: ${filePath}` };
          }
          const entries = readdirSync(filePath, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
            path: join(filePath, e.name),
          }));
          return { success: true, data: items };
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
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Source file not found: ${filePath}` };
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

        default:
          return { success: false, data: null, error: `Unknown action: ${action}` };
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
