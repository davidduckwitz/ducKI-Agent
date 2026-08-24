/**
 * Background Review Fork (Post-Turn Learning)
 * 
 * After every agent turn, spawns a background review that analyzes the turn,
 * identifies durable learnings (environment facts, workflow patterns), and
 * proposes memory entries or skill updates through the write-approval gate.
 * 
 * Ported from Hermes Agent's "Background Review Fork" pattern:
 * - Runs on a cheaper model by default (configurable)
 * - Uses a compact digest of recent turns, not the full transcript
 * - Proposes memory additions to MEMORY.md and USER.md
 * - Proposes skill creations/patches for repeated workflows
 * - All proposals go through the write-approval gate
 */
import type { DatabaseService } from "@ducki/database";
import type { LLMProvider } from "@ducki/providers";
import { createProvider } from "@ducki/providers";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("BackgroundReview");

export const BG_REVIEW_ENABLED_SETTING = "BG_REVIEW_ENABLED";
export const BG_REVIEW_PROVIDER_SETTING = "BG_REVIEW_PROVIDER";
export const BG_REVIEW_MODEL_SETTING = "BG_REVIEW_MODEL";

// Default: use a fast, cheap model for the review
const DEFAULT_REVIEW_PROVIDER = "openrouter";
const DEFAULT_REVIEW_MODEL = "google/gemini-2.0-flash-001";
const DEFAULT_ENABLED = true;

const REVIEW_SYSTEM_PROMPT = `You are a background learning review agent. Analyze the conversation turn below and identify durable learnings.

Output a JSON object with:
{
  "memory": { "entries": [] },     // entries to ADD to agent memory (environment facts, conventions, lessons)
  "userProfile": { "entries": [] },// entries to ADD to user profile (preferences, style, habits)
  "skillProposals": [              // workflows worth capturing as skills
    {
      "name": "kebab-case-name",
      "description": "One-line description",
      "category": "category-name",
      "suggestedContent": "Skill content in markdown (headings: When to Use, Procedure, Pitfalls, Verification)"
    }
  ],
  "summary": "One-line summary of what was learned in this turn"
}

Rules:
- Only propose CLEAR, DURABLE learnings. Skip trivial/obvious facts.
- Memory entries: single-line key facts about the environment, conventions, or lessons.
- User profile entries: user preferences, communication style, pet peeves.
- Skill proposals: only for multi-step workflows that were actually performed and will be repeated.
- If nothing worth remembering happened, return empty arrays.
- Limit each entry to 200 chars maximum.
- Never duplicate facts already visible in the conversation context.`;

interface ReviewOutput {
  memory: { entries: string[] };
  userProfile: { entries: string[] };
  skillProposals: Array<{
    name: string;
    description: string;
    category: string;
    suggestedContent: string;
  }>;
  summary: string;
}

export class BackgroundReviewFork {
  private reviewProvider: LLMProvider | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly mainProvider: LLMProvider
  ) {}

  private async getReviewProvider(): Promise<LLMProvider> {
    if (this.reviewProvider) return this.reviewProvider;

    const providerName = (await this.db.getSetting(BG_REVIEW_PROVIDER_SETTING)) || DEFAULT_REVIEW_PROVIDER;
    const modelId = (await this.db.getSetting(BG_REVIEW_MODEL_SETTING)) || DEFAULT_REVIEW_MODEL;

    try {
      this.reviewProvider = createProvider({
        name: providerName as any,
        model: modelId,
      });
    } catch {
      // Fall back to main provider if review provider is unreachable
      logger.warn("Review provider creation failed, falling back to main provider");
      this.reviewProvider = this.mainProvider;
    }

    return this.reviewProvider;
  }

  private async isEnabled(): Promise<boolean> {
    const setting = await this.db.getSetting(BG_REVIEW_ENABLED_SETTING);
    if (setting === undefined) return DEFAULT_ENABLED;
    return setting.toLowerCase() !== "false";
  }

  /**
   * Runs the background review after a turn completes. Does NOT block the caller
   * - fires the review asynchronously and lets it complete on its own time.
   *
   * @param userInput - what the user asked
   * @param finalResponse - what the agent replied
   * @param conversationId - the conversation to associate proposals with
   */
  async runAfterTurn(
    userInput: string,
    finalResponse: string,
    conversationId: number
  ): Promise<void> {
    if (!(await this.isEnabled())) {
      logger.debug("Background review disabled, skipping");
      return;
    }

    // Fire and forget - the caller should never wait for this.
    void this.runReviewInternal(userInput, finalResponse, conversationId).catch((error) => {
      logger.warn("Background review failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async runReviewInternal(
    userInput: string,
    finalResponse: string,
    conversationId: number
  ): Promise<void> {
    const provider = await this.getReviewProvider();

    // Compact digest: just the user prompt and final answer, not the full tool loop.
    const digest = [
      "User:",
      userInput.slice(0, 2000),
      "",
      "Assistant (final answer):",
      finalResponse.slice(0, 4000),
    ].join("\n");

    let response: string;
    try {
      const result = await provider.generate([
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: digest },
      ]);
      response = result.content;
    } catch (error) {
      logger.warn("Review LLM call failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Parse the JSON output
    let review: ReviewOutput;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.debug("No JSON found in review output");
        return;
      }
      review = JSON.parse(jsonMatch[0]) as ReviewOutput;
    } catch {
      logger.debug("Could not parse review JSON output");
      return;
    }

    let staged = 0;

    // Stage memory entries
    for (const entry of review.memory?.entries ?? []) {
      if (!entry.trim()) continue;
      await this.db.addPendingWrite({
        type: "memory_add",
        target: "memory",
        content: entry.trim(),
        conversationId,
      });
      staged++;
    }

    // Stage user profile entries
    for (const entry of review.userProfile?.entries ?? []) {
      if (!entry.trim()) continue;
      await this.db.addPendingWrite({
        type: "memory_add",
        target: "user",
        content: entry.trim(),
        conversationId,
      });
      staged++;
    }

    // Stage skill proposals
    for (const proposal of review.skillProposals ?? []) {
      if (!proposal.name?.trim() || !proposal.suggestedContent?.trim()) continue;

      const skillContent = [
        "---",
        `name: ${proposal.name}`,
        `description: ${proposal.description || ""}`,
        proposal.category ? `category: ${proposal.category}` : "",
        "---",
        "",
        proposal.suggestedContent,
      ]
        .filter(Boolean)
        .join("\n");

      await this.db.addPendingWrite({
        type: "skill_create",
        target: proposal.name,
        content: skillContent,
        conversationId,
      });
      staged++;
    }

    if (staged > 0 || review.summary) {
      logger.info("Background review complete", {
        conversationId,
        summary: review.summary,
        stagedWrites: staged,
        memoryEntries: review.memory?.entries?.length ?? 0,
        skillProposals: review.skillProposals?.length ?? 0,
      });
    }
  }
}