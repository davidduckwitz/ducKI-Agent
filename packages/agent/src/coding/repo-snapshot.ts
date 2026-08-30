import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { outlineFile, renderOutline } from "@ducki/tools";

/** Extensions outlineFile() can say something useful about - either via its TypeScript AST
 *  path or its regex heuristic fallback (see outline.ts). Skipping everything else (assets,
 *  lockfiles, markdown, ...) keeps this pass fast and its output free of noise. */
const OUTLINE_SOURCE_EXTENSIONS =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cpp|h|hpp|cs)$/i;
const MAX_OUTLINE_FILES = 60;
const MAX_OUTLINE_CHARS = 15_000;

/**
 * A compact, multi-file symbol map (function/class/interface names + line numbers) so the
 * Planner and a model's own EXPLORE phase start from a repo-wide overview instead of having
 * to `read`/`grep` their way to it call by call - the same idea as Aider's ctags-based "repo
 * map", built on outline.ts (already used per-file via the filesystem tool's action:"outline")
 * instead of introducing a new dependency.
 *
 * Deterministic and per-file fault-tolerant: one unparsable file is skipped, never aborts the
 * whole pass - same "never a gate" principle as the checkpoint system. Bounded by both file
 * count and total characters so a huge project cannot blow out the prompt this feeds into
 * (buildRepositorySnapshot's repositoryContext, handed to the Planner).
 */
function buildRepositoryOutline(sandboxRoot: string, files: string[]): string | undefined {
  const candidates = files.filter((path) => OUTLINE_SOURCE_EXTENSIONS.test(path));
  if (candidates.length === 0) return undefined;

  const selected = candidates.slice(0, MAX_OUTLINE_FILES);
  const sections: string[] = [];
  let totalChars = 0;
  let truncated = candidates.length > selected.length;

  for (const relativePath of selected) {
    if (totalChars >= MAX_OUTLINE_CHARS) {
      truncated = true;
      break;
    }
    try {
      const outline = outlineFile(join(sandboxRoot, relativePath));
      if (outline.symbols.length === 0) continue; // nothing worth listing for this file
      const rendered = renderOutline(relativePath, outline);
      const section = `### ${relativePath}\n${rendered}`;
      if (totalChars + section.length > MAX_OUTLINE_CHARS) {
        truncated = true;
        break;
      }
      sections.push(section);
      totalChars += section.length;
    } catch {
      // Unreadable/binary-ish file slipped past the extension filter - skip it, not fatal.
    }
  }

  if (sections.length === 0) return undefined;
  return sections.join("\n\n") + (truncated ? "\n\n[...repo map truncated]" : "");
}

/**
 * A cheap, synchronous grounding snapshot for a sandbox directory: a bounded file listing,
 * package.json facts, and a repo-map outline - no LLM call, just fs reads, so it is safe to run
 * on the hot path of a plan request. Used to give the Planner concrete facts to name real files
 * and commands in instead of inventing them (see PLANNER_SYSTEM_PROMPT_V2's grounding rule).
 * Shared between CodingAgent (always has a sandbox) and the regular chat agent's Plan Mode
 * (only when a coding-area project is in scope - see AgentRunOptions.codingSandboxRoot).
 */
export function buildRepositorySnapshot(sandboxRoot: string): Record<string, unknown> | undefined {
  if (!existsSync(sandboxRoot)) return undefined;
  const ignored = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || files.length >= 300) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || files.length >= 300) continue;
      const absolute = join(dir, entry.name);
      const relative = absolute.slice(sandboxRoot.length + 1).replace(/\\/g, "/");
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else files.push(relative);
    }
  };
  try { walk(sandboxRoot, 0); } catch { /* partial snapshot is still useful */ }
  let packageInfo: Record<string, unknown> | undefined;
  const packagePath = join(sandboxRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
      packageInfo = { name: parsed["name"], scripts: parsed["scripts"], dependencies: parsed["dependencies"], devDependencies: parsed["devDependencies"] };
    } catch { /* malformed package.json will be discovered during execution */ }
  }
  return {
    root: sandboxRoot,
    files,
    package: packageInfo,
    hasTsconfig: existsSync(join(sandboxRoot, "tsconfig.json")),
    ...(files.length > 0 ? { outline: buildRepositoryOutline(sandboxRoot, files) } : {}),
  };
}
