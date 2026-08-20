import type { ToolResult, ToolExecutor } from "@ducki/shared";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

function looksUnixShellCommand(command: string): boolean {
  // "date" is included because GNU-style `date +FORMAT` is a common LLM habit that silently
  // misbehaves under cmd.exe instead of failing clearly - Windows' own `date` builtin doesn't
  // accept `+FORMAT` at all.
  return /\b(grep|sed|awk|tail|head|tr|cut|xargs|date)\b|\/home\/|\/dev\/null|\*\.json|\|\|\s*true/.test(command);
}

let cachedBashPath: string | null | undefined;

function findBashOnWindows(): string | undefined {
  // `where bash` is itself a process spawn; caching it turns a per-command cost into a
  // once-per-process one.
  if (cachedBashPath !== undefined) return cachedBashPath ?? undefined;
  try {
    const output = execSync("where bash", { encoding: "utf8", timeout: 3000 });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    cachedBashPath = first ?? null;
  } catch {
    cachedBashPath = null;
  }
  return cachedBashPath ?? undefined;
}

const MAX_CAPTURED_OUTPUT = 10 * 1024 * 1024;
/** Ring-buffer size for a background process's output. A dev server logs forever; only the
 *  recent tail is ever diagnostic. */
const BACKGROUND_OUTPUT_LIMIT = 256 * 1024;

interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  output: string;
  startedAt: string;
  exitCode: number | null;
  finishedAt?: string;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();

function appendBounded(existing: string, chunk: string, limit: number): string {
  const combined = existing + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

/** Kills every process this tool started. Called on shutdown so a spawned dev server does not
 *  outlive the agent and hold its port. */
export function stopAllBackgroundProcesses(): void {
  for (const entry of backgroundProcesses.values()) {
    if (entry.exitCode === null) killTree(entry.child);
  }
  backgroundProcesses.clear();
}

interface SpawnPlan {
  file: string;
  args: string[];
  useShell: boolean;
  shellName: string;
}

function planSpawn(command: string): SpawnPlan {
  const isWindows = process.platform === "win32";

  if (isWindows && looksUnixShellCommand(command)) {
    const bashPath = findBashOnWindows();
    if (bashPath) {
      return { file: bashPath, args: ["-lc", command], useShell: false, shellName: "bash" };
    }
    return {
      file: "powershell",
      args: ["-NoProfile", "-Command", command],
      useShell: false,
      shellName: "powershell",
    };
  }

  return { file: command, args: [], useShell: true, shellName: isWindows ? "cmd" : "sh" };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Runs a command WITHOUT blocking the event loop.
 *
 * The previous implementation used execSync/execFileSync, which stops the entire Node process
 * for the duration of the command. In a server that hosts the agent, its WebSocket events and
 * its HTTP API, that meant a 30-second build froze everything: no progress events reached the
 * UI, the Stop button could not be serviced, and any other request queued behind it. Nothing
 * about the command changes here - only that the process stays alive while it runs.
 */
function runCommand(
  command: string,
  cwd: string,
  timeout: number,
  onOutput?: (chunk: string) => void
): Promise<RunResult> {
  const plan = planSpawn(command);

  return new Promise<RunResult>((resolvePromise) => {
    const child = spawn(plan.file, plan.args, spawnOptions(cwd, plan.useShell));

    // Close stdin immediately. A child inheriting an open, never-written pipe hangs until the
    // timeout on anything that prompts ("Ok to proceed? (y)", a credential prompt) instead of
    // reading EOF and failing fast - and an agent has no way to answer such a prompt anyway.
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeout));

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdout = appendBounded(stdout, text, MAX_CAPTURED_OUTPUT);
      onOutput?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderr = appendBounded(stderr, text, MAX_CAPTURED_OUTPUT);
      onOutput?.(text);
    });

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, timedOut });
    };

    child.on("error", (error: Error) => {
      stderr = appendBounded(stderr, `\n${error.message}`, MAX_CAPTURED_OUTPUT);
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? (timedOut ? 124 : 0)));
  });
}

function startBackground(command: string, cwd: string): BackgroundProcess {
  const plan = planSpawn(command);
  const child = spawn(plan.file, plan.args, spawnOptions(cwd, plan.useShell));

  const entry: BackgroundProcess = {
    id: `proc_${randomBytes(4).toString("hex")}`,
    command,
    cwd,
    child,
    output: "",
    startedAt: new Date().toISOString(),
    exitCode: null,
  };

  child.stdin?.end();
  child.stdout?.on("data", (data: Buffer) => {
    entry.output = appendBounded(entry.output, data.toString("utf8"), BACKGROUND_OUTPUT_LIMIT);
  });
  child.stderr?.on("data", (data: Buffer) => {
    entry.output = appendBounded(entry.output, data.toString("utf8"), BACKGROUND_OUTPUT_LIMIT);
  });
  child.on("error", (error: Error) => {
    entry.output = appendBounded(entry.output, `\n${error.message}`, BACKGROUND_OUTPUT_LIMIT);
  });
  child.on("close", (code) => {
    entry.exitCode = code ?? 0;
    entry.finishedAt = new Date().toISOString();
  });

  backgroundProcesses.set(entry.id, entry);
  return entry;
}

/**
 * Terminates a command AND everything it started.
 *
 * `child.kill()` only ever reached the shell we spawned (`cmd /c` or `sh -c`), not the process
 * it in turn started - so killing `npm run dev` left the actual node server alive, still holding
 * its port, invisible to us. That is the difference between "stop" working and a restart failing
 * with EADDRINUSE.
 *
 * Windows has no process groups, so the whole tree is walked by taskkill. On POSIX the child is
 * spawned into its OWN process group (see spawnOptions) precisely so a negative pid can signal
 * the group - which is also why the group kill must never be attempted for a child that was not
 * spawned detached: -pid would then denote OUR group and take the server down with it.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      // fall through to the plain kill below
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      // The group may already be gone, or the child was never detached - plain kill below.
    }
  }

  try {
    child.kill();
  } catch {
    // already gone
  }
}

/** POSIX children get their own process group so killTree can signal the whole group. */
function spawnOptions(cwd: string, useShell: boolean): Parameters<typeof spawn>[2] {
  return {
    cwd,
    shell: useShell,
    windowsHide: true,
    detached: process.platform !== "win32",
  };
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/\s*/,
  /format\s+c:/i,
  /mkfs/,
  /dd\s+if=.*of=\/dev/,
  />\s*\/dev\/(sda|hda|nvme)/,
];

export const shellTool: ToolExecutor = {
  name: "shell",
  description: "Execute shell commands in a controlled environment",
  definition: {
    name: "shell",
    description:
      "Execute shell/terminal commands. Set background:true for a long-running process (a dev server, a watcher) - " +
      "it returns immediately with a processId you can then poll with action:'output' and end with action:'stop'.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute" },
        cwd: { type: "string", description: "Working directory" },
        timeout: { type: "number", description: "Timeout in ms", default: 30000 },
        background: {
          type: "boolean",
          default: false,
          description:
            "Run the command in the background and return a processId immediately. Use for anything that does " +
            "not terminate on its own (dev server, watch mode). NEVER use it for a build or test run - you need " +
            "those exit codes.",
        },
        action: {
          type: "string",
          enum: ["output", "stop", "list"],
          description:
            "Manage a background process instead of running a command: output (read what it has printed so far), " +
            "stop (terminate it), list (show all running background processes).",
        },
        processId: { type: "string", description: "For action output/stop: the id returned when the process started." },
      },
      required: [],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof input["action"] === "string" ? (input["action"] as string).toLowerCase() : undefined;

    if (action === "list") {
      return {
        success: true,
        data: {
          processes: [...backgroundProcesses.values()].map((entry) => ({
            processId: entry.id,
            command: entry.command,
            running: entry.exitCode === null,
            exitCode: entry.exitCode,
            startedAt: entry.startedAt,
          })),
        },
      };
    }

    if (action === "output" || action === "stop") {
      const processId = String(input["processId"] ?? "");
      const entry = backgroundProcesses.get(processId);
      if (!entry) {
        const known = [...backgroundProcesses.keys()];
        return {
          success: false,
          data: null,
          error: `No background process '${processId}'. ${known.length > 0 ? `Known ids: ${known.join(", ")}` : "None are running."}`,
        };
      }

      if (action === "stop") {
        killTree(entry.child);
        return { success: true, data: { processId, stopped: true, output: entry.output.slice(-4000) } };
      }

      return {
        success: true,
        data: {
          processId,
          running: entry.exitCode === null,
          exitCode: entry.exitCode,
          output: entry.output,
        },
      };
    }

    let command = input["command"] as string;
    if (!command || typeof command !== "string") {
      return { success: false, data: null, error: "command required" };
    }

    const cwd = (input["cwd"] as string | undefined) ?? process.cwd();
    const timeout = (input["timeout"] as number | undefined) ?? 30000;

    // De-escape literal \n, \t, \r sequences that LLM might generate in shell commands
    command = command
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r");

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { success: false, data: null, error: "Command blocked for safety reasons" };
      }
    }

    if (input["background"] === true) {
      try {
        const entry = startBackground(command, cwd);
        return {
          success: true,
          data: {
            processId: entry.id,
            started: true,
            command,
            note:
              "Running in the background. Read its output with action:'output' and processId, and terminate it " +
              "with action:'stop' when you are done - it will not stop by itself.",
          },
        };
      } catch (error) {
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const result = await runCommand(command, cwd, timeout);
    const combined = result.stdout || result.stderr;

    if (result.timedOut) {
      return {
        success: false,
        data: { output: combined, exitCode: 124, timedOut: true },
        error:
          `Command timed out after ${timeout}ms: ${command}\n` +
          `If this command does not terminate on its own (a dev server, a watcher), re-run it with background:true.\n` +
          (combined ? `Output so far:\n${combined.slice(-2000)}` : ""),
      };
    }

    if (result.exitCode !== 0) {
      return {
        success: false,
        // The real exit code is reported, not a hard-coded one: a caller that decides success
        // from it (the CodingAgent's verification step does exactly that) has to see the truth.
        data: { output: result.stdout, exitCode: result.exitCode },
        error: result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.exitCode}`,
      };
    }

    return {
      success: true,
      data: {
        output: combined.trim(),
        exitCode: 0,
        ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
      },
    };
  },
};
