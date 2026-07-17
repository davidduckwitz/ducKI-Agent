import { execSync } from "node:child_process";
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