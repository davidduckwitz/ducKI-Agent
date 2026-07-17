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
} from "node:fs";
import { resolve, dirname, join } from "node:path";

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
  description: "Read, write, delete, list files and directories",
  definition: {
    name: "filesystem",
    description: "File system operations",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "append", "delete", "list", "mkdir", "exists", "stat", "move", "copy"],
        },
        path: { type: "string", description: "File or directory path" },
        content: { type: "string", description: "Content to write (for write/append)" },
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
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, bytes: content.length } };
          }
          writeFileSync(filePath, content, "utf8");
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
          writeFileSync(filePath, content, { encoding: "utf8", flag: "a" });
          return { success: true, data: { path: filePath } };
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
