import { execSync } from "node:child_process";
export const gitTool = {
    name: "git",
    description: "Git operations: clone, status, add, commit, push, pull, diff, log",
    definition: {
        name: "git",
        description: "Git version control operations",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["status", "add", "commit", "push", "pull", "clone", "diff", "log", "branch", "checkout", "init"],
                },
                path: { type: "string", description: "Repository path" },
                message: { type: "string", description: "Commit message" },
                remote: { type: "string", description: "Remote URL for clone/push/pull" },
                branch: { type: "string", description: "Branch name" },
                files: { type: "array", items: { type: "string" }, description: "Files to add" },
                timeout: { type: "number", description: "Timeout in ms", default: 30000 },
            },
            required: ["action"],
        },
    },
    async execute(input) {
        const action = input["action"];
        const repoPath = input["path"] ?? ".";
        const message = input["message"];
        const remote = input["remote"];
        const branch = input["branch"];
        const files = input["files"] ?? ["."];
        const timeout = Number(input["timeout"] ?? 30000);
        const runGit = (args) => {
            try {
                return execSync(`git ${args}`, {
                    cwd: repoPath,
                    encoding: "utf8",
                    timeout,
                }).trim();
            }
            catch (error) {
                if (error instanceof Error && "stderr" in error) {
                    throw new Error(error.stderr || error.message);
                }
                throw error;
            }
        };
        try {
            switch (action) {
                case "status":
                    return { success: true, data: { output: runGit("status --porcelain") } };
                case "add": {
                    const fileArgs = files.join(" ");
                    runGit(`add ${fileArgs}`);
                    return { success: true, data: { added: files } };
                }
                case "commit": {
                    if (!message)
                        return { success: false, data: null, error: "Commit message required" };
                    const output = runGit(`commit -m "${message.replace(/"/g, '\\"')}"`);
                    return { success: true, data: { output } };
                }
                case "push": {
                    const output = runGit(`push ${remote ?? "origin"} ${branch ?? "HEAD"}`);
                    return { success: true, data: { output } };
                }
                case "pull": {
                    const output = runGit(`pull ${remote ?? "origin"} ${branch ?? ""}`);
                    return { success: true, data: { output } };
                }
                case "clone": {
                    if (!remote)
                        return { success: false, data: null, error: "Remote URL required for clone" };
                    const output = execSync(`git clone "${remote}" "${repoPath}"`, {
                        encoding: "utf8",
                        timeout,
                    });
                    return { success: true, data: { output: output.trim(), path: repoPath } };
                }
                case "diff": {
                    const output = runGit("diff HEAD");
                    return { success: true, data: { output } };
                }
                case "log": {
                    const output = runGit("log --oneline -20");
                    return { success: true, data: { output } };
                }
                case "branch": {
                    const output = runGit("branch -a");
                    return { success: true, data: { output } };
                }
                case "checkout": {
                    if (!branch)
                        return { success: false, data: null, error: "Branch name required" };
                    const output = runGit(`checkout ${branch}`);
                    return { success: true, data: { output } };
                }
                case "init": {
                    const output = runGit("init");
                    return { success: true, data: { output, path: repoPath } };
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
//# sourceMappingURL=git.js.map