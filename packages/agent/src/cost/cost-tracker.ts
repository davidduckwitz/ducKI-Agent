import type { Logger } from "@ducki/logger";
import { TokenCounter } from "../context/token-counter.js";

/**
 * Phase 2 "Manager": a per-run cost accumulator + budget governor.
 *
 * The agent already emits per-LLM-call token usage. This class turns that
 * usage into a running € (USD) total via TokenCounter's price table and, when a
 * threshold is configured, reports when the run crosses it so the agent can
 * warn the user (and, only if the user opts in elsewhere, stop).
 *
 * Local models resolve to the zero-cost "local" price config, so a fully-local
 * setup accumulates 0 and never trips the governor — which is correct.
 */

export interface CostRecordInput {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface GovernorDecision {
  totals: CostTotals;
  thresholdUsd: number;
  /** Currently at or over the configured threshold (threshold > 0). */
  overBudget: boolean;
  /** True only on the record that first crosses the threshold — for a one-time warning. */
  justCrossed: boolean;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private calls = 0;
  private warned = false;

  /**
   * @param thresholdUsd Budget ceiling in USD; 0 disables the governor (track only).
   */
  constructor(
    private readonly thresholdUsd: number,
    private readonly logger?: Logger
  ) {}

  /** Accumulate one LLM call's usage and evaluate the budget. */
  record(input: CostRecordInput): GovernorDecision {
    const inTok = Number.isFinite(input.inputTokens) ? Math.max(0, input.inputTokens) : 0;
    const outTok = Number.isFinite(input.outputTokens) ? Math.max(0, input.outputTokens) : 0;

    const { totalCost } = TokenCounter.estimateCostFromTokens(input.model, inTok, outTok);

    this.inputTokens += inTok;
    this.outputTokens += outTok;
    this.costUsd += totalCost;
    this.calls += 1;

    const overBudget = this.thresholdUsd > 0 && this.costUsd >= this.thresholdUsd;
    const justCrossed = overBudget && !this.warned;
    if (justCrossed) {
      this.warned = true;
      this.logger?.warn("Cost governor threshold reached", {
        costUsd: Number(this.costUsd.toFixed(4)),
        thresholdUsd: this.thresholdUsd,
        calls: this.calls,
      });
    }

    return { totals: this.getTotals(), thresholdUsd: this.thresholdUsd, overBudget, justCrossed };
  }

  getTotals(): CostTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      costUsd: Number(this.costUsd.toFixed(6)),
      calls: this.calls,
    };
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
    this.calls = 0;
    this.warned = false;
  }
}
