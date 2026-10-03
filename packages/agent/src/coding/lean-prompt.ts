import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider } from "@ducki/providers";
import type { ReasoningEffort } from "@ducki/shared";

/**
 * Coding system prompt modeled on what opencode / Claude Code give the model: a concrete
 * workflow, code conventions, tool policy and an environment block - instead of a handful of
 * abstract invariants. Deliberately provider-neutral (no tool-call syntax, no model-specific
 * wording) so it works for Claude, OpenAI, OpenRouter and local models alike.
 *
 * Everything in here is fixed for the duration of a run (date without time, no counters), so
 * the prompt stays byte-identical across iterations and remains servable from the prompt cache.
 */
export interface LeanCodingPromptOptions {
  sandboxRoot?: string;
  platform: NodeJS.Platform;
  /** yyyy-mm-dd */
  date: string;
  isGitRepo: boolean;
  allowGitCommit: boolean;
  /** Contents of the project's AGENTS.md / CLAUDE.md, when present. */
  projectInstructions?: { file: string; content: string };
  /** Preview URL for static web projects (browser tool), when the server exposes one. */
  previewUrl?: string;
}

const LEAN_CODING_CORE = `You are a coding agent working inside a single project. You modify, run and verify real code using the tools you have been given.

# Doing tasks
1. Understand first. Search (filesystem grep/glob) and read the relevant files before changing anything. For a broad question about the codebase, use the explore tool instead of reading many files yourself.
2. For work with several distinct steps, write a short todo list with the todo tool, keep exactly one step in_progress, and mark each step done as soon as it is actually finished. Skip the todo list for small, single-step changes.
3. Implement with small, targeted edits. Read a file before editing it and copy oldString exactly as it appears after the "<n>: " line prefix - the line numbers are display-only and never part of the file. Prefer editing existing files over creating new ones.
4. Verify. After an edit, look at the diagnostics in the tool result and fix reported errors before moving on. Then run the project's own checks (build, type-check, tests, lint) with the shell tool. Never claim something works without having run it.
5. When a command or check fails, read the actual error output, find the cause in the code, and fix that cause. Do not retry the same action unchanged; if an approach failed twice, step back and choose a different one.
6. Finish with a short summary: what changed (files), what you verified and how, and anything you could not verify.

# Code conventions
- Match the existing style, naming, formatting and structure of the surrounding code.
- Never assume a library is available: check package.json (or the equivalent manifest) and existing imports before using it.
- Look at neighbouring components/modules to follow the project's patterns for new code.
- Do not add comments that merely restate the code. Do not leave placeholders, TODOs or stubbed-out logic in place of a real implementation.
- Never introduce code that logs or exposes secrets or keys.

# Tool usage
- Use the dedicated filesystem actions (read, grep, glob, outline, edit, write) for file work instead of shell commands like cat, sed or echo.
- Independent read-only calls (several reads or searches) can be issued together in one response.
- A tool error message names the corrective action - follow it instead of repeating the call.
- Output text only to communicate with the user; never use tools or code comments to talk to the user.
- Never guess file contents, command output or tool parameters - look them up.

# Tone
Be concise and direct. No emojis unless asked. State facts and results, not intentions.`;

function environmentBlock(options: LeanCodingPromptOptions): string {
  const shellNote =
    options.platform === "win32"
      ? "Windows - the shell tool runs commands through cmd.exe (Unix-style commands are routed to bash when Git Bash is installed). Use Windows-compatible commands, or the filesystem tool for file work."
      : `${options.platform} - the shell tool runs commands through sh.`;
  return [
    "# Environment",
    "<env>",
    `  Project root: ${options.sandboxRoot ?? "(not sandboxed)"}`,
    `  Is git repo: ${options.isGitRepo ? "yes" : "no"}`,
    `  Platform: ${shellNote}`,
    `  Today's date: ${options.date}`,
    "</env>",
    ...(options.sandboxRoot
      ? ["All tools are already scoped to the project root: always use paths relative to it, never absolute paths."]
      : []),
  ].join("\n");
}

export function buildLeanCodingSystemPrompt(options: LeanCodingPromptOptions): string {
  const sections = [LEAN_CODING_CORE, environmentBlock(options)];

  sections.push(
    options.allowGitCommit
      ? "# Git\nYou may stage and commit your own changes when useful. Never push, force, or rewrite history."
      : "# Git\nNever stage, commit, push or run destructive git operations - the controller checkpoints your changes itself."
  );

  if (options.previewUrl) {
    sections.push(
      "# Browser preview\n" +
        `Static web pages of this project are served at ${options.previewUrl} - open that URL with the browser tool (never file://). ` +
        "After an interaction, inspect a fresh snapshot or result before concluding anything. Project assets must use relative URLs."
    );
  }

  if (options.projectInstructions) {
    sections.push(
      `# Project instructions (${options.projectInstructions.file})\n` +
        "These are the project's own rules. Follow them; they take precedence over the general conventions above.\n\n" +
        options.projectInstructions.content
    );
  }

  return sections.join("\n\n");
}

/** Upper bound for an AGENTS.md / CLAUDE.md pulled into the system prompt. */
const PROJECT_INSTRUCTIONS_MAX_CHARS = 20000;
const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];

/** The first of AGENTS.md / CLAUDE.md found in the project root (same precedence as opencode). */
export function loadProjectInstructions(root: string | undefined): { file: string; content: string } | undefined {
  if (!root) return undefined;
  for (const file of PROJECT_INSTRUCTION_FILES) {
    const path = join(root, file);
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const raw = readFileSync(path, "utf8").trim();
      if (!raw) continue;
      const content = raw.length > PROJECT_INSTRUCTIONS_MAX_CHARS
        ? `${raw.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n\n[... ${file} truncated at ${PROJECT_INSTRUCTIONS_MAX_CHARS} characters]`
        : raw;
      return { file, content };
    } catch {
      // Unreadable file - behave as if it were absent.
    }
  }
  return undefined;
}

/** First user turn of a lean run: the goal plus the one fact the model cannot discover itself. */
export function buildLeanGoalPrompt(goal: string, verifyCommand: string | undefined, projectContext: string): string {
  const parts = [goal.trim()];
  parts.push(
    verifyCommand
      ? `When you are done, the controller runs \`${verifyCommand}\` to check the result. Run it yourself before you finish and make it pass.`
      : "No verification command was detected for this project. Pick the most appropriate check yourself (build, type-check or tests) and run it before you finish."
  );
  if (projectContext) parts.push(projectContext);
  return parts.join("\n\n");
}

/** Follow-up turn after the controller's own verification failed - appended to the same conversation. */
export function buildLeanVerifyFailurePrompt(verifyCommand: string, output: string, identicalToPrevious: boolean): string {
  return [
    `The controller ran \`${verifyCommand}\` and it failed:`,
    output,
    identicalToPrevious
      ? "This is the SAME error as after your previous fix - that change did not affect it. Re-read the failing code and take a different approach."
      : "Find the cause in the code and fix it, then run the check again yourself before you finish.",
  ].join("\n\n");
}

/**
 * Whether a configured reasoning effort is safe to send to this provider/model. Reasoning
 * parameters are rejected by models that do not support them (Anthropic 400s on `thinking` for
 * Claude 3.x, OpenAI 400s on `reasoning_effort` for non-reasoning models), and LM Studio switches
 * to a different API (Responses) as soon as an effort is set - so local providers only get it
 * when explicitly enabled.
 */
export function providerSupportsCodingThinking(provider: Pick<LLMProvider, "name" | "model">, allowLocal: boolean): boolean {
  const model = (provider.model ?? "").toLowerCase();
  switch (provider.name) {
    case "claude":
      return !/claude-(?:instant|2|3-(?:5-)?(?:opus|sonnet|haiku))/.test(model);
    case "openrouter":
      // OpenRouter normalises `reasoning` and ignores it for models without reasoning support.
      return true;
    case "openai":
      return /^(?:o[134](?:-|$)|gpt-[5-9])/.test(model);
    case "lmstudio":
    case "ollama":
      return allowLocal;
    default:
      return false;
  }
}

export function parseThinkingEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh"
    ? normalized
    : fallback;
}
