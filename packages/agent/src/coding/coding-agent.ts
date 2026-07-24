import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool, gitTool, shellTool, skillsTool } from "@ducki/tools";
import { Agent, TOOL_CALL_FORMAT_BLOCK } from "../agent.js";
import type { AgentEventEmitter } from "../config/interfaces_types.js";
import { createScopedFilesystemTool } from "./scoped-filesystem-tool.js";

const CODING_DIRECTIVE = `You are CodingAgent, a disciplined autonomous coding agent. You edit real code and must be careful and precise.

Discipline:
1. Plan the concrete files and steps before making any change.
2. Never edit a file you have not first read via the filesystem tool's "read" action.
3. Make minimal, targeted edits - do not restructure unrelated code.
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
  private readonly defaultMaxAttempts: number;

  constructor(
    provider: LLMProvider,
    db: DatabaseService,
    eventEmitter?: AgentEventEmitter,
    options: CodingAgentOptions = {}
  ) {
    this.defaultMaxAttempts = Math.max(1, options.maxAttempts ?? 4);

    this.agent = new Agent(provider, db, eventEmitter, {
      name: options.name ?? "CodingAgent",
      systemPrompt: options.systemPrompt ?? `${CODING_DIRECTIVE}\n\n${TOOL_CALL_FORMAT_BLOCK}`,
      maxIterations: options.maxIterations ?? 30,
    });

    const fsTool = options.sandboxRoot ? createScopedFilesystemTool(options.sandboxRoot) : filesystemTool;
    for (const tool of [fsTool, gitTool, shellTool, skillsTool, ...(options.extraTools ?? [])]) {
      this.agent.executor.registerTool(tool);
    }
  }

  get executor() {
    return this.agent.executor;
  }

  async run(goal: string, opts: CodingRunOptions = {}): Promise<CodingRunResult> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.defaultMaxAttempts);
    const conversationId = await this.agent.startConversation({ name: `CodingAgent: ${goal.slice(0, 60)}` });

    let lastSummary = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = attempt === 1 ? goal : this.buildFollowUpPrompt(goal, lastSummary);
      const runResult = await this.agent.run(prompt);
      lastSummary = runResult.response;

      if (!opts.verifyCommand) {
        return { success: true, summary: lastSummary, attempts: attempt, conversationId };
      }

      const verifyResult = await this.agent.executor.execute("shell", { command: opts.verifyCommand });
      if (verifyResult.success) {
        return { success: true, summary: lastSummary, attempts: attempt, conversationId };
      }

      const verifyError = verifyResult.error ?? JSON.stringify(verifyResult.data ?? "");
      lastSummary = `${lastSummary}\n\nVerification command "${opts.verifyCommand}" failed:\n${verifyError}`;

      if (attempt === maxAttempts) {
        return { success: false, summary: lastSummary, attempts: attempt, conversationId };
      }
    }

    return { success: false, summary: lastSummary, attempts: maxAttempts, conversationId };
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
