import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Lives INSIDE the project but is a separate git directory, so a project that is itself a git
 *  repo keeps its own history, index and branches completely untouched. */
const CHECKPOINT_DIR = ".ducki-checkpoints";

/** Never snapshot these - a checkpoint of node_modules would take minutes and gigabytes. */
const EXCLUDES = [
  "node_modules/",
  ".git/",
  ".ducki-checkpoints/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  "coverage/",
  "*.log",
  "*.bak",
];

export interface Checkpoint {
  sha: string;
  label: string;
  createdAt: string;
}

export interface CheckpointDiff {
  sha: string;
  files: Array<{ path: string; added: number; removed: number }>;
  patch: string;
  truncated: boolean;
}

function gitDir(root: string): string {
  return join(root, CHECKPOINT_DIR);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [`--git-dir=${gitDir(root)}`, `--work-tree=${root}`, ...args],
    { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
  );
  return stdout;
}

/** True once the shadow repo exists and is usable. Safe to call repeatedly. */
export async function ensureCheckpointRepo(root: string): Promise<boolean> {
  try {
    if (!existsSync(root)) return false;

    if (!existsSync(gitDir(root))) {
      mkdirSync(gitDir(root), { recursive: true });
      await execFileAsync("git", ["init", "--bare", `${gitDir(root)}`], { windowsHide: true });
      // A bare init gives us the object store; these two make it behave as a normal work-tree repo.
      await git(root, ["config", "core.bare", "false"]);
      await git(root, ["config", "core.worktree", root]);
      await git(root, ["config", "user.email", "coding-agent@ducki.local"]);
      await git(root, ["config", "user.name", "DucKI CodingAgent"]);
      // Byte-for-byte snapshots. With git's default line-ending translation on Windows, a
      // restore rewrites every LF file as CRLF - so "undo" would hand back a file that differs
      // from the one that was snapshotted, on every single line.
      await git(root, ["config", "core.autocrlf", "false"]);
      await git(root, ["config", "core.safecrlf", "false"]);
    }

    const infoDir = join(gitDir(root), "info");
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(join(infoDir, "exclude"), `${EXCLUDES.join("\n")}\n`, "utf8");
    return true;
  } catch {
    // Checkpoints are a safety net, never a gate: if git is unavailable the run proceeds
    // without them rather than failing.
    return false;
  }
}

/**
 * Snapshots the whole project as one commit and returns its sha.
 *
 * `--allow-empty` is deliberate: a checkpoint taken before an attempt that then changes nothing
 * still has to exist, otherwise "restore to before attempt 3" would silently land on attempt 1's
 * state and the user would have no way to tell.
 */
export async function createCheckpoint(root: string, label: string): Promise<Checkpoint | undefined> {
  try {
    if (!(await ensureCheckpointRepo(root))) return undefined;
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "--allow-empty", "-m", label]);
    const sha = (await git(root, ["rev-parse", "HEAD"])).trim();
    return { sha, label, createdAt: new Date().toISOString() };
  } catch {
    return undefined;
  }
}

export async function listCheckpoints(root: string, limit = 50): Promise<Checkpoint[]> {
  try {
    if (!existsSync(gitDir(root))) return [];
    const out = await git(root, ["log", `-n${limit}`, "--pretty=format:%H%x1f%s%x1f%cI"]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [sha, label, createdAt] = line.split("\x1f");
        return { sha: sha ?? "", label: label ?? "", createdAt: createdAt ?? "" };
      })
      .filter((entry) => entry.sha !== "");
  } catch {
    return [];
  }
}

/**
 * What changed since a checkpoint. Defaults to comparing against the CURRENT working tree,
 * which is the question a reviewer actually has ("what did the agent do to my project?").
 */
export async function diffCheckpoint(
  root: string,
  sha: string,
  options: { against?: string; maxPatchChars?: number } = {}
): Promise<CheckpointDiff | undefined> {
  try {
    if (!existsSync(gitDir(root))) return undefined;
    const maxPatchChars = options.maxPatchChars ?? 200_000;
    const range = options.against ? [sha, options.against] : [sha];

    const numstat = await git(root, ["diff", "--numstat", ...range]);
    const files = numstat
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [added, removed, path] = line.split("\t");
        return {
          path: path ?? "",
          // A binary file reports "-" rather than a count.
          added: Number(added) || 0,
          removed: Number(removed) || 0,
        };
      })
      .filter((entry) => entry.path !== "");

    const rawPatch = await git(root, ["diff", ...range]);
    const truncated = rawPatch.length > maxPatchChars;

    return {
      sha,
      files,
      patch: truncated ? `${rawPatch.slice(0, maxPatchChars)}\n[... diff truncated]` : rawPatch,
      truncated,
    };
  } catch {
    return undefined;
  }
}

/**
 * Puts every tracked file back to how it looked at `sha`.
 *
 * Takes a checkpoint of the CURRENT state first, so "undo" is itself undoable - a restore that
 * silently discards work the user wanted after all is the one failure mode that would make this
 * feature worse than not having it.
 */
export async function restoreCheckpoint(
  root: string,
  sha: string
): Promise<{ restored: boolean; safetyCheckpoint?: Checkpoint; error?: string }> {
  try {
    if (!existsSync(gitDir(root))) return { restored: false, error: "No checkpoints exist for this project" };
    const safetyCheckpoint = await createCheckpoint(root, `Before restore to ${sha.slice(0, 8)}`);
    await git(root, ["checkout", sha, "--", "."]);
    const result: { restored: boolean; safetyCheckpoint?: Checkpoint } = { restored: true };
    if (safetyCheckpoint) result.safetyCheckpoint = safetyCheckpoint;
    return result;
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) };
  }
}
