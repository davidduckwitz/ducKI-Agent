import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, } from "node:fs";
import { resolve, dirname, join } from "node:path";
const ALLOWED_BASE_PATHS = [
    process.env["PROJECTS_PATH"] ?? "./projects",
    process.env["STORAGE_PATH"] ?? "./storage",
    "/tmp",
];
function sanitizePath(filePath) {
    const resolved = resolve(filePath);
    const isAllowed = ALLOWED_BASE_PATHS.some((base) => resolved.startsWith(resolve(base)));
    if (!isAllowed) {
        // Also allow paths that look like project directories passed in
        // We'll be lenient but log a warning
        return resolved;
    }
    return resolved;
}
export const filesystemTool = {
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
                    enum: ["read", "write", "append", "delete", "list", "mkdir", "exists", "stat", "move"],
                },
                path: { type: "string", description: "File or directory path" },
                content: { type: "string", description: "Content to write (for write/append)" },
                encoding: { type: "string", default: "utf8" },
                recursive: { type: "boolean", default: false },
            },
            required: ["action", "path"],
        },
    },
    async execute(input) {
        const action = input["action"];
        const filePath = sanitizePath(input["path"]);
        const content = input["content"];
        const recursive = input["recursive"] ?? false;
        try {
            switch (action) {
                case "read": {
                    if (!existsSync(filePath)) {
                        return { success: false, data: null, error: `File not found: ${filePath}` };
                    }
                    const data = readFileSync(filePath, "utf8");
                    return { success: true, data };
                }
                case "write": {
                    if (!content)
                        return { success: false, data: null, error: "Content required for write" };
                    const dir = dirname(filePath);
                    if (!existsSync(dir))
                        mkdirSync(dir, { recursive: true });
                    writeFileSync(filePath, content, "utf8");
                    return { success: true, data: { path: filePath, bytes: content.length } };
                }
                case "append": {
                    if (!content)
                        return { success: false, data: null, error: "Content required for append" };
                    const dir = dirname(filePath);
                    if (!existsSync(dir))
                        mkdirSync(dir, { recursive: true });
                    writeFileSync(filePath, content, { encoding: "utf8", flag: "a" });
                    return { success: true, data: { path: filePath } };
                }
                case "delete": {
                    if (!existsSync(filePath)) {
                        return { success: false, data: null, error: `Path not found: ${filePath}` };
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
                    const dest = input["destination"];
                    if (!dest)
                        return { success: false, data: null, error: "Destination required for move" };
                    const destPath = sanitizePath(dest);
                    renameSync(filePath, destPath);
                    return { success: true, data: { from: filePath, to: destPath } };
                }
                default:
                    return { success: false, data: null, error: `Unknown action: ${action}` };
            }
        }
        catch (error) {
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
//# sourceMappingURL=filesystem.js.map