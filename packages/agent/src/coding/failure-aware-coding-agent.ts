import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { AgentEventEmitter } from "../config/interfaces_types.js";
import { getRootLogger } from "@ducki/logger";
import { CodingAgent, type CodingAgentOptions, type CodingAttemptContext } from "./coding-agent.js";
import { CodingFailureReflector } from "./failure-reflector.js";
import type { VerifyFailureUpdate } from "./coding-run-state.js";

/** Optional failure strategy using explicit macro-loop lifecycle hooks. */
export class FailureAwareCodingAgent extends CodingAgent {
  private readonly failureReflector: CodingFailureReflector;
  constructor(provider: LLMProvider, db: DatabaseService, emitter?: AgentEventEmitter, options: CodingAgentOptions = {}) {
    super(provider, db, emitter, options);
    this.failureReflector = new CodingFailureReflector(options.explorerProvider ?? provider,
      getRootLogger().child("CodingFailureReflection"));
  }
  protected override beforeRetry({ state }: CodingAttemptContext): string {
    const reflection = state.pendingReflection;
    state.pendingReflection = undefined;
    if (!reflection) return "";
    return ["## Failure reflection — change strategy, do not repeat the last fix",
      `Diagnosis: ${reflection.diagnosis}`,
      "Avoid:", ...reflection.avoid.map(item => `- ${item}`),
      "Next actions:", ...reflection.nextActions.map(item => `- ${item}`),
      "Treat this as a diagnostic hint, not ground truth. Verify it against the repository before editing.",
    ].join("\n");
  }
  protected override async onVerificationFailed(context: CodingAttemptContext, failure: VerifyFailureUpdate): Promise<void> {
    if (!failure.shouldReflect) return;
    const reflection = await this.failureReflector.reflect({
      goal: context.goal, verifyCommand: context.verifyCommand ?? "browser verification",
      verifyError: failure.lastVerifyError ?? "", previousSummary: context.state.lastSummary,
      journal: context.state.journal, previouslyRuledOut: context.state.ruledOut,
      checkpointPatch: context.diff?.patch,
    });
    context.state.markReflectionAttempted(reflection);
    if (reflection) this.emit("decision", `Fehleranalyse: ${reflection.diagnosis}`, { reflection });
  }
}

export function createFailureAwareCodingAgent(provider: LLMProvider, db: DatabaseService,
  emitter?: AgentEventEmitter, options?: CodingAgentOptions): CodingAgent {
  return new FailureAwareCodingAgent(provider, db, emitter, options);
}
