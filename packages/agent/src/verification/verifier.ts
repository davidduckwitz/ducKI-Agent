import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import {
  EMPTY_VERIFY_RESULT,
  type VerifyCheckResult,
  type VerifyConstraint,
  type VerifyResult,
  type VerifyShellExecutor,
} from "./verify-types.js";

/**
 * Verifier — the Phase 1 "Critic".
 *
 * Where Reflection asks "is this response good?" and returns a fuzzy quality
 * score, the Verifier asks "does this response satisfy each concrete
 * requirement?" and returns a per-constraint pass/fail checklist plus a compact
 * list of failing points that a fix pass can act on.
 *
 * Two check families:
 *  - LLM-checked (requirement / logic-assertion / style): a single evaluation
 *    call grades every LLM-checkable constraint at once.
 *  - Executable (shell-check / unit-test): run via an injected shell executor.
 *    When no executor is wired in, these are reported as "skipped" (never
 *    silently passed) so the caller knows verification was partial.
 *
 * The module deliberately does NOT run arbitrary shell commands itself — it
 * delegates to whatever sandboxed executor the agent injects, keeping the blast
 * radius of code execution inside the agent's existing tool sandbox.
 */
export class Verifier {
  private readonly shellTimeoutMs = 30000;

  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger,
    private readonly shell?: VerifyShellExecutor
  ) {}

  /**
   * Derive a small checklist of requirement constraints from the user's request.
   * Used when the caller has no explicit constraints. Best-effort: on any
   * failure it returns an empty list and the caller can skip verification.
   */
  async deriveConstraints(originalRequest: string): Promise<VerifyConstraint[]> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You extract concrete, checkable acceptance criteria from a user request.
Return ONLY JSON: {"constraints":[{"description":"..."}]}
Rules:
- 2 to 5 constraints, each a single verifiable requirement.
- Phrase each as a testable statement ("The response includes X", "The code handles Y").
- No preamble, no markdown.`,
      },
      { role: "user", content: `Request:\n${originalRequest.substring(0, 4000)}` },
    ];

    try {
      const response = await this.provider.generate(messages, { temperature: 0.2, maxTokens: 600 });
      const parsed = this.parseJSON<{ constraints?: { description?: string }[] }>(response.content);
      const items = parsed?.constraints ?? [];
      return items
        .map((c) => c.description?.trim())
        .filter((d): d is string => !!d && d.length > 3)
        .slice(0, 5)
        .map((description, idx) => ({
          id: `c_${idx + 1}`,
          kind: "requirement" as const,
          description,
        }));
    } catch (error) {
      this.logger.debug("Constraint derivation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Verify a response against a set of constraints.
   * Executable constraints run first (fast, deterministic); LLM-checkable
   * constraints are graded together in one call.
   */
  async verify(
    originalRequest: string,
    agentResponse: string,
    constraints: VerifyConstraint[]
  ): Promise<VerifyResult> {
    if (constraints.length === 0) return { ...EMPTY_VERIFY_RESULT };

    const checks: VerifyCheckResult[] = [];

    const executable = constraints.filter((c) => c.kind === "shell-check" || c.kind === "unit-test");
    const llmChecked = constraints.filter((c) => c.kind !== "shell-check" && c.kind !== "unit-test");

    for (const constraint of executable) {
      checks.push(await this.runExecutable(constraint));
    }

    let tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    if (llmChecked.length > 0) {
      const { results, usage } = await this.runLlmChecks(originalRequest, agentResponse, llmChecked);
      checks.push(...results);
      tokenUsage = usage;
    }

    const failures = checks
      .filter((c) => c.status === "failed")
      .map((c) => `[${c.kind}] ${c.description}${c.detail ? ` — ${c.detail}` : ""}`);

    const passed = checks.every((c) => c.status !== "failed");

    return {
      passed,
      checks,
      failures,
      shouldFix: failures.length > 0,
      inputTokens: tokenUsage?.inputTokens,
      outputTokens: tokenUsage?.outputTokens,
      totalTokens: tokenUsage?.totalTokens,
    };
  }

  private async runExecutable(constraint: VerifyConstraint): Promise<VerifyCheckResult> {
    const base = { constraintId: constraint.id, kind: constraint.kind, description: constraint.description };

    if (!this.shell || !constraint.command) {
      return {
        ...base,
        status: "skipped",
        detail: !this.shell ? "no shell executor wired in" : "no command provided",
      };
    }

    try {
      const { exitCode, stdout, stderr } = await this.shell.run(constraint.command, this.shellTimeoutMs);
      if (exitCode !== 0) {
        return { ...base, status: "failed", detail: `exit ${exitCode}: ${(stderr || stdout).slice(0, 300)}` };
      }
      if (constraint.expectContains && !stdout.includes(constraint.expectContains)) {
        return { ...base, status: "failed", detail: `stdout missing expected "${constraint.expectContains}"` };
      }
      return { ...base, status: "passed" };
    } catch (error) {
      return { ...base, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async runLlmChecks(
    originalRequest: string,
    agentResponse: string,
    constraints: VerifyConstraint[]
  ): Promise<{
    results: VerifyCheckResult[];
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  }> {
    const checklist = constraints.map((c) => `- id=${c.id}: ${c.description}`).join("\n");

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a strict verification checker. For each constraint decide if the response satisfies it.
Return ONLY JSON: {"results":[{"id":"...","status":"passed|failed","detail":"short reason if failed"}]}
Be strict: mark "failed" if the constraint is not clearly met. Do not invent constraints.`,
      },
      {
        role: "user",
        content: `Original request:\n${originalRequest.substring(0, 3000)}

Constraints to check:
${checklist}

Agent response:
${agentResponse.substring(0, 6000)}

Return JSON only.`,
      },
    ];

    try {
      const response = await this.provider.generate(messages, { temperature: 0.1, maxTokens: 1200 });
      const parsed = this.parseJSON<{ results?: { id?: string; status?: string; detail?: string }[] }>(
        response.content
      );
      const graded = new Map((parsed?.results ?? []).map((r) => [r.id, r]));

      const results: VerifyCheckResult[] = constraints.map((c) => {
        const g = graded.get(c.id);
        const status = g?.status === "passed" ? "passed" : g?.status === "failed" ? "failed" : "skipped";
        return {
          constraintId: c.id,
          kind: c.kind,
          description: c.description,
          status,
          detail: status === "passed" ? undefined : g?.detail ?? "not evaluated by checker",
        };
      });

      return {
        results,
        usage: {
          inputTokens: response.usage.promptTokens,
          outputTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
        },
      };
    } catch (error) {
      this.logger.warn("LLM verification failed, marking checks skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        results: constraints.map((c) => ({
          constraintId: c.id,
          kind: c.kind,
          description: c.description,
          status: "skipped" as const,
          detail: "verification call failed",
        })),
      };
    }
  }

  private parseJSON<T>(content: string): T | null {
    try {
      const cleaned = content
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/, "")
        .replace(/```\s*$/, "")
        .trim();
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}
