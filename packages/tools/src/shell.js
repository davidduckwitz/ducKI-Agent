import { execFileSync, execSync } from "node:child_process";
function looksUnixShellCommand(command) {
    return /\b(grep|sed|awk|tail|head|tr|cut|xargs)\b|\/home\/|\/dev\/null|\*\.json|\|\|\s*true/.test(command);
}
function findBashOnWindows() {
    try {
        const output = execSync("where bash", { encoding: "utf8", timeout: 3000 });
        const first = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
        return first;
    }
    catch {
        return undefined;
    }
}
export const shellTool = {
    name: "shell",
    description: "Execute shell commands in a controlled environment",
    definition: {
        name: "shell",
        description: "Execute shell/terminal commands",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Command to execute" },
                cwd: { type: "string", description: "Working directory" },
                timeout: { type: "number", description: "Timeout in ms", default: 30000 },
            },
            required: ["command"],
        },
    },
    async execute(input) {
        const command = input["command"];
        const cwd = input["cwd"] ?? process.cwd();
        const timeout = input["timeout"] ?? 30000;
        const isWindows = process.platform === "win32";
        // Basic safety checks - block dangerous commands
        const dangerousPatterns = [
            /rm\s+-rf\s+\/\s*/,
            /format\s+c:/i,
            /mkfs/,
            /dd\s+if=.*of=\/dev/,
            />\s*\/dev\/(sda|hda|nvme)/,
        ];
        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                return {
                    success: false,
                    data: null,
                    error: "Command blocked for safety reasons",
                };
            }
        }
        try {
            if (isWindows && looksUnixShellCommand(command)) {
                const bashPath = findBashOnWindows();
                if (!bashPath) {
                    return {
                        success: false,
                        data: null,
                        error: "Unix shell command detected on Windows, but bash is not available. Use PowerShell commands or install Git Bash/WSL.",
                    };
                }
                const output = execFileSync(bashPath, ["-lc", command], {
                    cwd,
                    encoding: "utf8",
                    timeout,
                    maxBuffer: 10 * 1024 * 1024,
                });
                return {
                    success: true,
                    data: {
                        output: output.trim(),
                        exitCode: 0,
                        shell: "bash",
                    },
                };
            }
            const output = execSync(command, {
                cwd,
                encoding: "utf8",
                timeout,
                maxBuffer: 10 * 1024 * 1024, // 10MB
            });
            return {
                success: true,
                data: {
                    output: output.trim(),
                    exitCode: 0,
                },
            };
        }
        catch (error) {
            if (error instanceof Error) {
                const execError = error;
                return {
                    success: false,
                    data: {
                        output: execError.stdout ?? "",
                        exitCode: execError.status ?? 1,
                    },
                    error: execError.stderr ?? error.message,
                };
            }
            return { success: false, data: null, error: String(error) };
        }
    },
};
//# sourceMappingURL=shell.js.map