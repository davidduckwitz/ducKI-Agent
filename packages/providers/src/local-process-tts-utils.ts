import { spawn } from "node:child_process";

/**
 * Shared spawn helper for local-process TTS engines (Piper and the generic local-command
 * provider both need it): pipes `text` on stdin - the natural interface for Piper and many
 * other local TTS CLIs (`echo "text" | piper --model x.onnx --output_file out.wav`) - and
 * waits for the child to exit, enforcing a timeout.
 */
export function runTtsProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  stdinText: string
): Promise<{ stderr: string; exitCode: number }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
      shell: false,
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error(`Local TTS process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ stderr, exitCode: code ?? 0 });
    });

    child.stdin.end(stdinText, "utf8");
  });
}

export function parseArgsTemplate(template: string): string[] {
  const trimmed = template.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map((part) => String(part));
    } catch {
      // Fall back to shell-like tokenization below.
    }
  }
  return trimmed.split(/\s+/).filter((part) => part.length > 0);
}

export function replacePlaceholders(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) => {
    let next = arg;
    for (const [key, value] of Object.entries(values)) {
      next = next.replaceAll(`{${key}}`, value);
    }
    return next;
  });
}
