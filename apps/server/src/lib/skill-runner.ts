/**
 * Real (subprocess) script runner for skills.
 *
 * This is the second, higher-capability execution path — distinct from the
 * `node:vm` sandbox used for legacy inline `script.js` skills. It runs a skill's
 * bundled scripts as real OS processes (bash / node / npx / uv / python …) so
 * spec skills that shell out can work.
 *
 * Because this executes potentially-untrusted code, it is guarded on multiple
 * levels and OFF by default:
 *   - Feature flag `ALLOW_EXTERNAL_SKILL_SCRIPTS` must be `true`.
 *   - The executable must be on an allowlist (`ALLOWED_SKILL_RUNTIMES`).
 *   - The command runs with `shell:false` (no shell parsing/injection), a
 *     minimal env, cwd pinned to the skill directory, a hard timeout, and
 *     truncated output.
 *   - Every invocation is written to the audit log.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getRootLogger } from "@ducki/logger";

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 30000; // per stream

const DEFAULT_RUNTIMES = ["bash", "sh", "node", "npx", "python3", "python", "uv", "uvx", "pnpm", "npm"];

export interface RunSkillOptions {
  slug: string;
  skillsRoot: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /** When false (default), the child gets no network-related env passthrough hints. */
  allowNetwork?: boolean;
}

export interface RunSkillResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  command: string;
  args: string[];
}

export class SkillRunnerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SkillRunnerError";
  }
}

export function isRunnerEnabled(): boolean {
  return String(process.env["ALLOW_EXTERNAL_SKILL_SCRIPTS"] ?? "").toLowerCase() === "true";
}

function allowedRuntimes(): string[] {
  const configured = process.env["ALLOWED_SKILL_RUNTIMES"]?.trim();
  if (configured) return configured.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return DEFAULT_RUNTIMES;
}

/** The base executable name (no path, no extension) for allowlist checks. */
function baseExecutable(command: string): string {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function truncate(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]", truncated: true };
}

/** Minimal, safe-ish environment for the child process. */
function childEnv(allowNetwork: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"] ?? process.env["USERPROFILE"],
    TMPDIR: process.env["TMPDIR"],
    TEMP: process.env["TEMP"],
    TMP: process.env["TMP"],
    LANG: process.env["LANG"],
    // Signal to well-behaved tools that they run non-interactively.
    CI: "1",
    SKILL_RUNNER: "1",
  };
  if (allowNetwork) {
    env["HTTP_PROXY"] = process.env["HTTP_PROXY"];
    env["HTTPS_PROXY"] = process.env["HTTPS_PROXY"];
    env["NO_PROXY"] = process.env["NO_PROXY"];
  }
  // Drop undefined keys.
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/**
 * Run a command for a skill. Throws SkillRunnerError (with an HTTP-ish status)
 * on guard violations; resolves with the process result otherwise (even on a
 * non-zero exit — that is reported, not thrown).
 */
export async function runSkillCommand(opts: RunSkillOptions): Promise<RunSkillResult> {
  const logger = getRootLogger().child("SkillRunner");

  if (!isRunnerEnabled()) {
    throw new SkillRunnerError(
      "Skill script execution is disabled. Set ALLOW_EXTERNAL_SKILL_SCRIPTS=true to enable.",
      403
    );
  }

  const slug = opts.slug.trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new SkillRunnerError(`Invalid skill slug: ${slug}`, 400);
  }

  const skillDir = resolve(opts.skillsRoot, slug);
  if (!skillDir.startsWith(resolve(opts.skillsRoot) + sep)) {
    throw new SkillRunnerError("Resolved skill directory escapes skills root", 400);
  }
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    throw new SkillRunnerError(`Skill not found: ${slug}`, 404);
  }

  const command = (opts.command ?? "").trim();
  if (!command) throw new SkillRunnerError("command is required", 400);

  const exe = baseExecutable(command);
  if (!allowedRuntimes().includes(exe)) {
    throw new SkillRunnerError(
      `Executable '${exe}' is not allowed. Allowed: ${allowedRuntimes().join(", ")}`,
      400
    );
  }

  const args = Array.isArray(opts.args) ? opts.args.map((a) => String(a)) : [];
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const allowNetwork = opts.allowNetwork === true;

  logger.info("skill script execution requested", { slug, command: exe, args, timeoutMs, allowNetwork });

  const started = Date.now();
  return await new Promise<RunSkillResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, {
      cwd: skillDir,
      env: childEnv(allowNetwork),
      shell: false, // no shell => no injection through args
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString();
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(spawnError ? `${stderr}\n${spawnError.message}` : stderr);
      const durationMs = Date.now() - started;
      const result: RunSkillResult = {
        ok: exitCode === 0 && !spawnError,
        exitCode,
        signal: signal ?? null,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        durationMs,
        command: exe,
        args,
      };
      logger.info("skill script execution finished", {
        slug,
        command: exe,
        exitCode,
        signal,
        ok: result.ok,
        durationMs,
      });
      resolvePromise(result);
    };

    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
