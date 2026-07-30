import type { ToolResult, ToolExecutor } from "@ducki/shared";
import { execFileSync, execSync } from "node:child_process";

function looksUnixShellCommand(command: string): boolean {
  // "date" is included because GNU-style `date +FORMAT` is a common LLM habit that silently
  // misbehaves under cmd.exe instead of failing clearly - Windows' own `date` builtin doesn't
  // accept `+FORMAT` at all.
  return /\b(grep|sed|awk|tail|head|tr|cut|xargs|date)\b|\/home\/|\/dev\/null|\*\.json|\|\|\s*true/.test(command);
}

function findBashOnWindows(): string | undefined {
  try {
    const output = execSync("where bash", { encoding: "utf8", timeout: 3000 });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

export const shellTool: ToolExecutor = {
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
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    let command = input["command"] as string;
    const cwd = (input["cwd"] as string | undefined) ?? process.cwd();
    const timeout = (input["timeout"] as number | undefined) ?? 30000;
    const isWindows = process.platform === "win32";

    // De-escape literal \n, \t, \r sequences that LLM might generate in shell commands
    command = command
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r");

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
        if (bashPath) {
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

        // Fallback to PowerShell on Windows if bash is not available
        try {
          const psCommand = `${command}; $?`;
          const output = execFileSync("powershell", ["-NoProfile", "-Command", psCommand], {
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
              shell: "powershell",
            },
          };
        } catch (fallbackError) {
          return {
            success: false,
            data: null,
            error:
              "Unix shell command detected on Windows, but bash is not available and PowerShell fallback failed. " +
              "Install Git Bash/WSL for Unix commands, or rewrite the command for PowerShell/cmd.exe. " +
              (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)),
          };
        }
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
    } catch (error: unknown) {
      if (error instanceof Error) {
        const execError = error as Error & { status?: number; stderr?: string; stdout?: string };
        const errorMessage = execError.stderr?.trim() || error.message || `Command exited with code ${execError.status ?? 1}`;
        return {
          success: false,
          data: {
            output: execError.stdout ?? "",
            exitCode: execError.status ?? 1,
          },
          error: errorMessage,
        };
      }
      return { success: false, data: null, error: String(error) };
    }
  },
};
