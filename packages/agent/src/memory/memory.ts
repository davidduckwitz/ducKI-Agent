import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";
import { extractKeywords, scoreKeywordRelevance, tokenizeText } from "@ducki/shared";

/** When true (the default), memories the agent learns on its own become immediately
 *  recallable instead of waiting in a review queue. Set to "false" to keep every
 *  automatic learning behind manual approval in the Memory UI. */
const AUTO_APPROVE_SETTING = "MEMORY_AUTO_APPROVE";

export interface MemoryEntry {
  id?: number;
  content: string;
  importance: number;
  type: "short-term" | "long-term" | "episodic" | "semantic";
  conversationId?: number;
}

export interface TaskMemoryDecision {
  shouldRemember: boolean;
  stored: boolean;
  reason: string;
  content?: string;
  importance?: number;
}

export interface ToolMemoryDecision {
  shouldRemember: boolean;
  stored: boolean;
  reason: string;
  content?: string;
  importance?: number;
}

export class MemorySystem {
  private shortTermBuffer: MemoryEntry[] = [];
  private readonly maxShortTerm = 20;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  async addShortTerm(content: string, importance = 1, conversationId?: number): Promise<void> {
    const entry: MemoryEntry = { content, importance, type: "short-term", conversationId };
    this.shortTermBuffer.push(entry);

    if (this.shortTermBuffer.length > this.maxShortTerm) {
      this.consolidate();
    }

    await this.db.addMemory({ content, importance, type: "short-term", conversationId });

    // Short-term rows are never read back by retrieval, so cap the table here (once per run, cheap)
    // instead of letting them accumulate forever as dead weight.
    await this.db.pruneShortTermMemories().catch(() => {
      // Best-effort hygiene - never let it fail a run.
    });
  }

  async addLongTerm(content: string, importance = 5, conversationId?: number): Promise<void> {
    await this.addLongTermIfNovel(content, importance, conversationId);
  }

  async addLongTermIfNovel(
    content: string,
    importance = 5,
    conversationId?: number,
    status: "approved" | "pending" = "approved"
  ): Promise<boolean> {
    const normalized = this.normalize(content);
    if (!normalized) return false;

    const existing = await this.db.getMemories(undefined, "long-term");
    const duplicate = existing.some((entry) => this.similarity(this.normalize(entry.content), normalized) >= 0.9);
    if (duplicate) {
      this.logger.debug("Skipped duplicate long-term memory", { preview: normalized.slice(0, 60) });
      return false;
    }

    const effectiveStatus = await this.resolveLearningStatus(status);
    await this.db.addMemory({
      content: normalized,
      importance,
      type: "long-term",
      conversationId,
      status: effectiveStatus,
    });
    this.logger.debug("Long-term memory added", {
      content: normalized.slice(0, 60),
      importance,
      status: effectiveStatus,
    });
    return true;
  }

  /**
   * Every retrieval path filters on status "approved". Writing automatic learnings as
   * "pending" therefore meant the agent could never read back anything it taught itself -
   * it filled a review queue nobody had to empty for the agent to keep working, so from
   * the agent's point of view it simply never learned. Auto-approval is on by default and
   * can be turned off for setups that genuinely want a human in the loop.
   */
  private async resolveLearningStatus(requested: "approved" | "pending"): Promise<"approved" | "pending"> {
    if (requested === "approved") return "approved";
    try {
      const raw = (await this.db.getSetting(AUTO_APPROVE_SETTING))?.trim().toLowerCase();
      if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return "pending";
    } catch {
      // Setting unavailable - fall through to the default, which keeps learning working.
    }
    return "approved";
  }

  async rememberFromSuccessfulTask(
    taskInput: Record<string, unknown>,
    taskResultData: unknown,
    conversationId?: number
  ): Promise<TaskMemoryDecision> {
    const action = String(taskInput["action"] ?? "").toLowerCase();
    const resultObject = this.asObject(taskResultData);
    const status = String(resultObject?.["status"] ?? "").toLowerCase();
    const resultText = String(resultObject?.["result"] ?? "").trim();
    const title = String(resultObject?.["title"] ?? "").trim();
    const taskId = resultObject?.["id"];

    const completed = action === "complete" || status === "completed";
    if (!completed) {
      return {
        shouldRemember: false,
        stored: false,
        reason: "task_not_completed",
      };
    }

    if (!title && !resultText) {
      return {
        shouldRemember: false,
        stored: false,
        reason: "missing_task_signal",
      };
    }

    const content = [
      "Task learning",
      taskId !== undefined ? `#${String(taskId)}` : undefined,
      title ? `Title: ${title}` : undefined,
      resultText ? `Result: ${resultText}` : "Result: Task completed successfully",
    ]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join(" | ");

    if (!this.shouldStoreDurableLearning(content)) {
      return { shouldRemember: false, stored: false, reason: "low_signal_content" };
    }

    const importance = resultText.length >= 80 ? 8 : 7;
    const stored = await this.addLongTermIfNovel(content, importance, conversationId, "pending");

    return {
      shouldRemember: true,
      stored,
      reason: stored ? "stored" : "duplicate",
      content,
      importance,
    };
  }

  async rememberFromSuccessfulTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResultData: unknown,
    conversationId?: number
  ): Promise<ToolMemoryDecision> {
    const normalizedTool = toolName.trim().toLowerCase();
    if (normalizedTool === "task") {
      return this.rememberFromSuccessfulTask(toolInput, toolResultData, conversationId);
    }

    if (normalizedTool === "workflow") {
      const action = String(toolInput["action"] ?? "").toLowerCase();
      const result = this.asObject(toolResultData);
      const workflowId = String(result?.["id"] ?? result?.["workflowId"] ?? toolInput["id"] ?? "").trim();
      const status = String(result?.["status"] ?? "").toLowerCase();

      if (!action) {
        return {
          shouldRemember: false,
          stored: false,
          reason: "missing_workflow_signal",
        };
      }

      if (!["create", "update", "run", "resume"].includes(action)) {
        return {
          shouldRemember: false,
          stored: false,
          reason: "workflow_action_not_eligible",
        };
      }

      const content = [
        "Workflow learning",
        workflowId ? `Id: ${workflowId}` : undefined,
        `Action: ${action}`,
        status ? `Status: ${status}` : undefined,
      ]
        .filter((part): part is string => Boolean(part && part.trim().length > 0))
        .join(" | ");

      if (!this.shouldStoreLearning(content, 25)) {
        return {
          shouldRemember: false,
          stored: false,
          reason: "low_signal_content",
        };
      }

      const importance = action === "run" || action === "resume" ? 7 : 6;
      const stored = await this.addLongTermIfNovel(content, importance, conversationId, "pending");
      return {
        shouldRemember: true,
        stored,
        reason: stored ? "stored" : "duplicate",
        content,
        importance,
      };
    }

    if (normalizedTool === "skill_manage") {
      const action = String(toolInput["action"] ?? "").toLowerCase();
      const skillName = String(toolInput["name"] ?? "").trim();
      if (!action || !skillName) {
        return {
          shouldRemember: false,
          stored: false,
          reason: "missing_skill_signal",
        };
      }

      const content = `Skill workflow | Skill: ${skillName} | Action: ${action} | Successful pattern captured`;
      if (!this.shouldStoreLearning(content, 25)) {
        return {
          shouldRemember: false,
          stored: false,
          reason: "low_signal_content",
        };
      }
      const stored = await this.addLongTermIfNovel(content, 6, conversationId, "pending");
      return {
        shouldRemember: true,
        stored,
        reason: stored ? "stored" : "duplicate",
        content,
        importance: 6,
      };
    }

    return {
      shouldRemember: false,
      stored: false,
      reason: "tool_not_eligible",
    };
  }

  private consolidate(): void {
    this.shortTermBuffer = this.shortTermBuffer
      .sort((a, b) => b.importance - a.importance)
      .slice(0, Math.floor(this.maxShortTerm / 2));
  }

  /**
   * Relevance lookup for a free-text query. Previously a whole-query substring match,
   * which only ever hit when a memory happened to contain the user's exact wording -
   * for anything longer than a single word that is effectively never.
   */
  async getRelevantContext(query: string, limit = 5): Promise<string[]> {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];

    const longTerm = await this.db.getMemories(undefined, "long-term", "approved");
    return longTerm
      .map((m) => ({ content: m.content, score: scoreKeywordRelevance(m.content, keywords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.content);
  }

  async buildSystemContext(conversationId?: number): Promise<string> {
    const scoped = await this.getKnowledgePool(conversationId, true);
    const global = await this.getKnowledgePool(undefined, true);
    const combined: string[] = [];

    for (const item of [...scoped, ...global]) {
      const normalized = this.normalize(item);
      if (!normalized) continue;
      if (combined.some((existing) => this.similarity(existing, normalized) >= 0.9)) continue;
      combined.push(normalized);
      if (combined.length >= 8) break;
    }

    if (combined.length === 0) return "";
    return `\n\n## Relevant Memory\n${combined.map((content) => `- ${content}`).join("\n")}`;
  }

  async buildDynamicContext(signals: string[], conversationId?: number, limit = 6): Promise<string> {
    const signalText = this.normalize(signals.join(" "));
    if (!signalText) return "";

    const scoped = await this.getKnowledgePool(conversationId, true);
    const global = await this.getKnowledgePool(undefined, true);
    const scored = [...scoped, ...global]
      .map((content) => {
        const normalized = this.normalize(content);
        const score = this.similarity(signalText, normalized) + this.profileBoost(signalText, normalized);
        return { content: normalized, score };
      })
      .filter((item) => item.content.length > 0 && item.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked: string[] = [];
    for (const item of scored) {
      if (picked.some((existing) => this.similarity(existing, item.content) >= 0.9)) continue;
      picked.push(item.content);
      if (picked.length >= limit) break;
    }

    if (picked.length === 0) return "";
    return `\n\n## Retrieved Memory\n${picked.map((content) => `- ${content}`).join("\n")}`;
  }

  async buildDynamicContextWithKeywords(
    keywords: string[],
    conversationId?: number,
    limit = 6
  ): Promise<string> {
    if (keywords.length === 0) return "";

    const results = await this.db.searchMemories(keywords, conversationId, "long-term", "approved", limit);

    if (results.length === 0) return "";
    return `\n\n## Retrieved Memory (Keywords: ${keywords.join(", ")})\n${results.map(r => `- ${r.content}`).join("\n")}`;
  }

  summarizeConversation(messages: LLMMessage[]): string {
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
    const assistantMessages = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content.slice(0, 100));

    return `User discussed: ${userMessages.slice(-3).join("; ")}. Agent responded about: ${assistantMessages.slice(-3).join("; ")}`;
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private async getKnowledgePool(conversationId: number | undefined, includeSemantic: boolean): Promise<string[]> {
    const longTerm = await this.db.getMemories(conversationId, "long-term", "approved");
    const semantic = includeSemantic ? await this.db.getMemories(conversationId, "semantic", "approved") : [];
    return [...longTerm, ...semantic].map((entry) => entry.content);
  }

  private profileBoost(signal: string, content: string): number {
    const userFocus = /user|human|preference|style|tone|behavior/.test(signal.toLowerCase());
    const isProfile = /\[profile:agent_behavior\]|\[profile:human_info\]/i.test(content);
    if (userFocus && isProfile) return 0.2;
    return 0;
  }

  private shouldStoreLearning(content: string, minLength: number): boolean {
    const normalized = this.normalize(content);
    if (normalized.length < minLength) return false;
    return this.shouldStoreDurableLearning(normalized);
  }

  // Scaffolding labels of the agent's self-generated "learnings". A memory built only from these plus a
  // status word ("Self-Reflection Learning | Quality: good | Issues: -") is process telemetry, not
  // durable knowledge, and used to flood the retrieved memory pool with noise.
  private static readonly TELEMETRY_LABELS =
    /\b(self-reflection learning|post-iteration learning|boundary assessment|skill workflow|workflow learning|task learning|quality|issues?|improvements?|suggestions?|status|action|for future|successful pattern captured)\b/gi;

  /**
   * A learning is worth keeping only if, once the templated scaffolding is stripped, enough real
   * content words remain. This filters pure process/telemetry auto-learnings while keeping ones that
   * carry actual substance (a concrete task result, a specific reflection suggestion, etc.).
   */
  private isLowSignalLearning(content: string): boolean {
    const normalized = this.normalize(content);
    if (normalized.length < 40) return true;
    if (/(successful pattern captured|completed successfully|action:\s*list)\s*$/i.test(normalized)) return true;
    const stripped = normalized
      .replace(MemorySystem.TELEMETRY_LABELS, " ")
      .replace(/[|#:.\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const substantiveTokens = tokenizeText(stripped, { removeStopwords: true, minLength: 3 });
    return substantiveTokens.length < 4;
  }

  private shouldStoreDurableLearning(content: string): boolean {
    return !this.isLowSignalLearning(content);
  }

  /**
   * Stores an auto-generated learning only if it clears the durable-signal bar. Use this (not
   * addLongTermIfNovel) for anything the agent writes about its own process - reflection, boundary
   * assessments, tool/workflow outcomes - so low-signal telemetry never enters the retrieved pool.
   */
  async addDurableLearningIfNovel(
    content: string,
    importance = 5,
    conversationId?: number,
    status: "approved" | "pending" = "pending"
  ): Promise<boolean> {
    if (!this.shouldStoreDurableLearning(content)) {
      this.logger.debug("Skipped low-signal learning", { preview: this.normalize(content).slice(0, 60) });
      return false;
    }
    return this.addLongTermIfNovel(content, importance, conversationId, status);
  }

  private normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    // Unicode-aware tokenization: the previous /[^a-z0-9]+/ split treated every umlaut as
    // a word boundary, so "Ausführung" became ["ausf","hrung"] and two German memories
    // saying the same thing looked unrelated - defeating duplicate detection.
    const aTokens = new Set(tokenizeText(a, { removeStopwords: false }));
    const bTokens = new Set(tokenizeText(b, { removeStopwords: false }));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) intersection++;
    }

    const union = new Set([...aTokens, ...bTokens]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
