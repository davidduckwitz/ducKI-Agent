import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool, gitTool, shellTool, skillsTool } from "@ducki/tools";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, TOOL_CALL_FORMAT_BLOCK } from "../agent.js";
import type { AgentEventEmitter, AgentRunOptions } from "../config/interfaces_types.js";
import { AGENT_HOOK_NAMES, type AgentHook } from "../hooks/index.js";
import { ToolApprovalPolicy, AllowedActions } from "../tools/tool-approval-policy.js";
import { createScopedFilesystemTool } from "./scoped-filesystem-tool.js";

const CODING_DIRECTIVE = `You are CodingAgent, a disciplined autonomous coding agent. You edit real code and must be careful and precise.

Discipline:
1. Plan the concrete files and steps before making any change.
2. Never edit a file you have not first read via the filesystem tool's "read" action.
3. Make minimal, targeted edits - do not restructure unrelated code. Prefer the filesystem tool's "edit" action (exact text replacement) over "write" for changes to existing files; only use "write" for new files or a genuine full-file replacement.
4. After every change, verify it: re-read the file or run a build/test command via the shell tool.
5. If a verification command fails, diagnose the ACTUAL error output before retrying - do not guess or repeat the same fix blindly.
6. Use the git tool to inspect diffs/status when useful, but never push or force operations unless explicitly asked.
7. Report concisely what changed and what you verified.`;

export interface CodingAgentOptions {
  name?: string;
  systemPrompt?: string;
  /** Per-attempt tool-call iteration budget, passed through to the underlying Agent. */
  maxIterations?: number;
  /** Macro plan -> verify -> iterate budget owned by CodingAgent itself. */
  maxAttempts?: number;
  /** When set, the filesystem tool defaults every call's basePath to this root. */
  sandboxRoot?: string;
  /** Additional tools beyond the curated filesystem/git/shell/skill_manage set. */
  extraTools?: ToolExecutor[];
}

export interface CodingRunOptions {
  /** Shell command run directly (no LLM round-trip) to deterministically check success. */
  verifyCommand?: string;
  /** Overrides the instance's default macro attempt budget for this run only. */
  maxAttempts?: number;
}

export interface CodingRunResult {
  success: boolean;
  summary: string;
  attempts: number;
  conversationId?: number;
  /** The command whose exit code decided `success`, or undefined if none could be
   *  determined - in that case `success` only means "the agent finished without
   *  throwing", not "the change was proven to work". */
  verifyCommand?: string;
  /** True only when a verification command actually ran and passed. */
  verified: boolean;
}

/** Verification output is fed back into the next prompt; a full failing build log would
 *  otherwise crowd out the goal and the agent's own context. Keeps head and tail because
 *  the first error and the summary line are both diagnostic. */
function truncateVerifyOutput(output: string, maxChars = 4000): string {
  if (output.length <= maxChars) return output;
  const head = output.slice(0, Math.floor(maxChars * 0.6));
  const tail = output.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n[... ${output.length - maxChars} Zeichen gekuerzt ...]\n${tail}`;
}

/**
 * Composes an Agent with a curated coding tool set and directive system prompt,
 * then orchestrates it through a plan -> verify -> iterate macro loop across
 * several agent.run() calls on the same conversation thread. Composition (not
 * subclassing) because Agent's tool-call loop internals are private and don't
 * need to change - only how many times, and with what follow-up, it's called.
 */
export class CodingAgent {
  private readonly agent: Agent;
  private readonly eventEmitter: AgentEventEmitter | undefined;
  private readonly defaultMaxAttempts: number;
  private readonly sandboxRoot: string | undefined;
  private filesRead = new Set<string>(); // Track files read during this run

  constructor(
    provider: LLMProvider,
    db: DatabaseService,
    eventEmitter?: AgentEventEmitter,
    options: CodingAgentOptions = {}
  ) {
    this.defaultMaxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.sandboxRoot = options.sandboxRoot;
    this.eventEmitter = eventEmitter;

    const basePrompt = options.systemPrompt ?? `${CODING_DIRECTIVE}\n\n${TOOL_CALL_FORMAT_BLOCK}`;

    // Phase 1 & 2: Register discipline hooks for CodingAgent
    const disciplineHooks: AgentHook[] = [
      {
        name: "coding-discipline-read-before-edit",
        priority: 60,
        handler: async (context: any) => {
          // beforeTool hook: enforce "read before edit" discipline
          const toolName = context.toolName as string;
          const input = context.input as Record<string, unknown>;

          if (toolName === "filesystem") {
            const action = String(input.action ?? "").toLowerCase();
            const path = String(input.path ?? "");

            // Check if editing without reading first
            if (["edit", "write", "append", "delete"].includes(action) && path) {
              const hasBeenRead = this.filesRead.has(path);
              if (!hasBeenRead && action !== "write") { // write is OK for new files
                return {
                  proceed: false,
                  reason: `Discipline violation: Must read file '${path}' before editing it. Use "read" action first.`,
                };
              }
            }

            // Track reads for future edits
            if (action === "read" && path) {
              this.filesRead.add(path);
            }
          }

          return { proceed: true };
        },
      },
    ];

    // Phase 2: Create approval policy for safe coding (restrict destructive operations)
    const codingApprovalPolicy = new ToolApprovalPolicy([
      // Only allow safe shell commands: no rm -rf, git force-push, etc.
      new AllowedActions("shell", ["ls", "pwd", "cd", "cat", "grep", "find", "npm", "yarn", "git"], "Only safe shell commands allowed in coding mode"),
    ]);

    this.agent = new Agent(provider, db, eventEmitter, {
      name: options.name ?? "CodingAgent",
      systemPrompt: basePrompt,
      maxIterations: options.maxIterations ?? 30,
      hooks: disciplineHooks,
    });

    const fsTool = options.sandboxRoot ? createScopedFilesystemTool(options.sandboxRoot) : filesystemTool;
    for (const tool of [fsTool, gitTool, shellTool, skillsTool, ...(options.extraTools ?? [])]) {
      this.agent.executor.registerTool(tool);
    }
  }

  private autoSelectCodingSkill(goal: string): string | undefined {
    const skillKeywords = {
      "test-driven-development": ["test", "tdd", "unit test", "jest", "vitest", "spec"],
      "code-review": ["review", "quality", "style", "lint", "format"],
      "debugging": ["debug", "error", "bug", "fix", "crash"],
      "planning": ["plan", "architecture", "design", "structure"],
    };

    const goalLower = goal.toLowerCase();
    for (const [skill, keywords] of Object.entries(skillKeywords)) {
      if (keywords.some(kw => goalLower.includes(kw))) {
        return skill;
      }
    }

    return undefined;
  }

  /**
   * Best-effort default so "no verifyCommand" doesn't silently mean "no check
   * at all" - falls back to a project-detected typecheck/build, or undefined
   * if nothing detectable exists (never fabricates a command that would fail
   * for unrelated reasons).
   */
  private detectDefaultVerifyCommand(): string | undefined {
    if (!this.sandboxRoot) return undefined;
    if (existsSync(join(this.sandboxRoot, "tsconfig.json"))) {
      return "npx tsc --noEmit";
    }
    const packageJsonPath = join(this.sandboxRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.["build"]) return "npm run build";
      } catch {
        // malformed package.json - nothing detectable, fall through
      }
    }
    return undefined;
  }

  get executor() {
    return this.agent.executor;
  }

  async loadConversation(conversationId: number): Promise<void> {
    return this.agent.loadConversation(conversationId);
  }

  async runOnExistingConversation(
    prompt: string,
    options: AgentRunOptions = {}
  ): Promise<{ response: string; result?: unknown }> {
    return this.agent.run(prompt, options);
  }

  async run(goal: string, opts: CodingRunOptions = {}): Promise<CodingRunResult> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.defaultMaxAttempts);
    const conversationId = await this.agent.startConversation({ name: `CodingAgent: ${goal.slice(0, 60)}` });

    const detectedSkill = this.autoSelectCodingSkill(goal);
    let verifyCommand = opts.verifyCommand;

    if (!verifyCommand && detectedSkill) {
      if (detectedSkill === "test-driven-development") {
        verifyCommand = "npm test";
      } else if (detectedSkill === "code-review") {
        verifyCommand = "npm run lint";
      }
    }

    if (!verifyCommand) {
      verifyCommand = this.detectDefaultVerifyCommand();
    }

    let lastSummary = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.emit("iteration", `Coding-Versuch ${attempt}/${maxAttempts}`, {
        attempt,
        maxAttempts,
        verifyCommand,
      });

      const prompt =
        attempt === 1
          ? this.buildInitialPrompt(goal, verifyCommand, detectedSkill)
          : this.buildFollowUpPrompt(goal, lastSummary);
      const runResult = await this.agent.run(prompt);
      lastSummary = runResult.response;

      if (!verifyCommand) {
        // Nothing to check against - report honestly that the result is unverified
        // instead of letting "no check" masquerade as a passing check.
        this.emit("decision", "Keine Verifikation moeglich - Ergebnis ist ungeprueft.", { attempt });
        return { success: true, verified: false, summary: lastSummary, attempts: attempt, conversationId };
      }

      const verifyResult = await this.agent.executor.execute("shell", {
        command: verifyCommand,
        // Without an explicit cwd the shell tool falls back to the server process's own
        // directory, so a sandboxed run would verify the wrong project entirely.
        ...(this.sandboxRoot ? { cwd: this.sandboxRoot } : {}),
      });
      if (verifyResult.success) {
        this.emit("decision", `Verifikation "${verifyCommand}" erfolgreich.`, { attempt, verifyCommand });
        return {
          success: true,
          verified: true,
          summary: lastSummary,
          attempts: attempt,
          conversationId,
          verifyCommand,
        };
      }

      const verifyError = truncateVerifyOutput(verifyResult.error ?? JSON.stringify(verifyResult.data ?? ""));
      this.emit("decision", `Verifikation "${verifyCommand}" fehlgeschlagen.`, {
        attempt,
        verifyCommand,
        error: verifyError.slice(0, 500),
      });
      lastSummary = `${lastSummary}\n\nVerification command "${verifyCommand}" failed:\n${verifyError}`;

      if (attempt === maxAttempts) {
        return {
          success: false,
          verified: false,
          summary: lastSummary,
          attempts: attempt,
          conversationId,
          verifyCommand,
        };
      }
    }

    return {
      success: false,
      verified: false,
      summary: lastSummary,
      attempts: maxAttempts,
      conversationId,
      ...(verifyCommand ? { verifyCommand } : {}),
    };
  }

  private emit(type: "iteration" | "decision", message: string, data?: Record<string, unknown>): void {
    try {
      this.eventEmitter?.emitEvent({ type, message, data, timestamp: new Date().toISOString() });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
  }

  /**
   * Turns a bare goal into an explicit phase contract. Previously the goal string was
   * handed to the agent verbatim, so "explore before editing" and "this exact command
   * decides success" existed only in the system directive - the agent had no way to know
   * which command its work would actually be judged by.
   */
  private buildInitialPrompt(goal: string, verifyCommand: string | undefined, detectedSkill: string | undefined): string {
    const parts: string[] = [`Goal: ${goal}`, ""];

    if (this.sandboxRoot) {
      parts.push(`Project root: ${this.sandboxRoot} - all paths and commands are relative to it.`, "");
    }

    parts.push(
      "Work in these phases, and state which phase you are in:",
      "1. EXPLORE - locate the relevant files and read them before changing anything.",
      "2. PLAN - name the exact files you will edit and what changes each one needs.",
      "3. EDIT - make minimal, targeted edits (prefer the filesystem tool's \"edit\" action).",
      "4. VERIFY - re-read what you changed and run the verification command below.",
      "5. REPORT - list the files you changed and what the verification showed."
    );

    if (verifyCommand) {
      parts.push(
        "",
        `Verification command: \`${verifyCommand}\`. Its exit code decides whether this run counts as successful, so make it pass - do not declare success without running it.`
      );
    } else {
      parts.push(
        "",
        "No verification command could be determined for this project. Pick the most appropriate check yourself (build, test, or type-check) via the shell tool and state which one you used."
      );
    }

    if (detectedSkill) {
      parts.push(
        "",
        `A "${detectedSkill}" skill looks relevant for this goal - load it via the skill tool before phase 3 and follow it if it applies.`
      );
    }

    return parts.join("\n");
  }

  private buildFollowUpPrompt(goal: string, previousSummaryWithVerification: string): string {
    return [
      "Your previous attempt did not pass verification. Diagnose the ACTUAL failure below and fix it - do not repeat the same approach blindly.",
      `Original goal: ${goal}`,
      "Previous attempt summary and verification output:",
      previousSummaryWithVerification,
    ].join("\n\n");
  }
}

export function createCodingAgent(
  provider: LLMProvider,
  db: DatabaseService,
  options?: CodingAgentOptions
): CodingAgent {
  return new CodingAgent(provider, db, undefined, options);
}
