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

/** Git change type per file, as reported by `git diff --name-status`. */
export type DiffFileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";

export interface CheckpointDiff {
  sha: string;
  files: Array<{ path: string; added: number; removed: number; status: DiffFileStatus }>;
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
 *
 * `paths`: when the caller already knows exactly which file(s) just changed (a per-edit
 * checkpoint, see checkpoint-on-write.ts), staging only those paths skips `git add -A`'s full
 * working-tree scan - on every single file write, that scan is the dominant cost of a checkpoint
 * on a project of any real size. Omit it (the attempt-level checkpoint, taken BEFORE the attempt
 * runs and so unable to know what will change) to fall back to the full `-A` scan.
 */
export async function createCheckpoint(root: string, label: string, paths?: string[]): Promise<Checkpoint | undefined> {
  try {
    if (!(await ensureCheckpointRepo(root))) return undefined;
    if (paths && paths.length > 0) {
      await git(root, ["add", "--", ...paths]);
    } else {
      await git(root, ["add", "-A"]);
    }
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

    // Stage everything first: a commit-vs-worktree `git diff <sha>` silently skips brand-new
    // files the run created (untracked files are invisible to it). Staging makes them regular
    // "A" entries with a real patch. This only mutates the shadow repo's index - the project's
    // own git state stays untouched, and discardNoopCheckpoint resets the index before its own
    // status check, so a no-op detection is never fooled by a stale staging state.
    await git(root, ["add", "-A"]);

    const numstat = await git(root, ["diff", "--numstat", ...range]);
    // Per-file change type, so a reviewer can tell a brand-new file (A) from a deleted
    // one (D) at a glance instead of inferring it from the +/- counters.
    const nameStatus = await git(root, ["diff", "--name-status", ...range]);
    const statusByPath = new Map<string, DiffFileStatus>();
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      // Format: "<XY>\t<path>"; renames/copies add a second path column
      // ("<XY>\t<old>\t<new>") - the diff path is always the LAST column.
      const parts = line.split("\t");
      const code = parts[0];
      const path = parts[parts.length - 1];
      if (code && path) statusByPath.set(path, code[0] as DiffFileStatus);
    }
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
          status: statusByPath.get(path ?? "") ?? "M",
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

/**
 * Removes a checkpoint commit from the shadow history when the working tree has NOT changed
 * since it was taken - i.e. the run it protected was a no-op (asked a question, read files,
 * but wrote nothing). Without this, every chat turn leaves an empty checkpoint behind and the
 * Changes tab drowns in noise entries.
 *
 * The working tree is NEVER modified: HEAD just moves back to the checkpoint's parent (soft
 * reset), so the commit disappears from listCheckpoints() while the files stay exactly as the
 * run left them. A first-ever checkpoint has no parent - there the HEAD ref is dropped, which
 * leaves the shadow repo ready for the next checkpoint to become the root commit again.
 * Returns true when the checkpoint was actually removed.
 */
export async function discardNoopCheckpoint(root: string, sha: string): Promise<boolean> {
  try {
    if (!(await ensureCheckpointRepo(root))) return false;
    // The checkpoint itself is committed with a clean status, so ANY dirty entry means the
    // run touched files - modified, deleted or newly created (git status --porcelain also
    // surfaces untracked files, which `git diff <sha>` alone would miss).
    // Neutralise any index mutation diffCheckpoint may have done: the no-op check must reflect
    // the true working tree, not a staged state.
    await git(root, ["reset", "-q"]);
    const status = (await git(root, ["status", "--porcelain"])).trim();
    if (status.length > 0) return false;
    // Only ever remove the checkpoint we just created - never something the user restored
    // into or an entry another run owns.
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    if (head !== sha) return false;
    let parent: string | undefined;
    try {
      parent = (await git(root, ["rev-parse", `${sha}^`])).trim();
    } catch {
      parent = undefined; // root commit
    }
    if (parent && /^[0-9a-f]{40}$/i.test(parent)) {
      await git(root, ["reset", "--soft", parent]);
    } else {
      await git(root, ["update-ref", "-d", "HEAD"]);
    }
    return true;
  } catch {
    // Safety net, never a gate: if anything fails, the checkpoint simply stays.
    return false;
  }
}
