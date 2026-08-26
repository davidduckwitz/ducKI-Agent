/**
 * Bot Handoff Service
 *
 * Structured task handoffs between bots in a group chat. A bot can formally
 * assign a task to another bot with a status, priority, and acceptance criteria.
 * Tracks ownership, status, and handoff history.
 *
 * Task encoding: `createdBy: "bot:<source>→<target>"` carries both the
 * assigning bot and the assigned-to bot in one DB column, so open-handoff
 * lookups and done-pattern matching work without joining against messages.
 *
 * Patterns detected:
 *  "@botB übernimm X"   → creates task
 *  "@botB erledigt"     → marks task completed (optional trailing text = result)
 *  "@botB blocked by X" → marks task blocked
 */
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("BotHandoff");

export interface HandoffTask {
  taskId: number;
  title: string;
  assignedBy: string; // bot slug
  assignedTo: string; // bot slug
  conversationId: number;
  status: "pending" | "accepted" | "in_progress" | "completed" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  acceptanceCriteria?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

const HANDOFF_ASSIGN_RE = /@([a-z0-9][a-z0-9-]*)\s+(?:übernimm|bearbeite|kümmere dich um|mach|erledige|take over|handle|take care of|do|work on)\s+(.+)/i;
const HANDOFF_DONE_RE = /@([a-z0-9][a-z0-9-]*)\s+(?:ist\s+)?(?:erledigt|fertig|done|abgeschlossen|completed|finished)\b[.!]?\s*(.*)/i;
const HANDOFF_BLOCKED_RE = /@([a-z0-9][a-z0-9-]*)\s+(?:ist\s+)?(?:blockiert|blocked|geblockt|hängt|stuck)\b[.!]?\s*(?:durch|by)?\s*(.*)/i;

/** Tag stored in `tasks.createdBy`: "bot:<source>→<target>". */
const TASK_CREATED_BY_PREFIX = "bot:";
const TASK_ARROW = "→";

/**
 * Conversation scoping: every handoff task carries `conversationId:<id>` in its description, so
 * multiple group chats keep separate task boards (previously ALL open handoffs from EVERY chat
 * leaked into every other chat's context).
 */
const CONVERSATION_TAG_RE = /conversationId:(\d+)/;

function encodeConversationTag(conversationId: number): string {
  return `conversationId:${conversationId}`;
}

function conversationIdOfTask(task: { description?: string | null }): number | undefined {
  const match = task.description?.match(CONVERSATION_TAG_RE);
  return match ? Number(match[1]) : undefined;
}

function isBotHandoffAssignMessage(content: string, taskId: number): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: string; action?: string; taskId?: number };
    return parsed.type === "bot_handoff" && parsed.action === "assign" && parsed.taskId === taskId;
  } catch {
    return false;
  }
}

function encodeCreatedBy(sourceSlug: string, targetSlug: string): string {
  return `${TASK_CREATED_BY_PREFIX}${sourceSlug}${TASK_ARROW}${targetSlug}`;
}

function decodeCreatedBy(raw: string): { source: string; target: string } | null {
  if (!raw.startsWith(TASK_CREATED_BY_PREFIX)) return null;
  const inner = raw.slice(TASK_CREATED_BY_PREFIX.length);
  const idx = inner.indexOf(TASK_ARROW);
  if (idx < 0) return { source: inner, target: "" }; // legacy
  return { source: inner.slice(0, idx), target: inner.slice(idx + 1) };
}

export class BotHandoffService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Scopes a handoff task to a conversation. Tasks created after conversation-tagging shipped
   * carry the `conversationId:<id>` tag directly. Tasks created before that (no tag) are matched
   * by finding the "bot_handoff" assign message that references this task id in the given
   * conversation's own message log, then the tag is backfilled onto the task so this lookup
   * only has to happen once per legacy task - without this, every handoff pending before the
   * tag was introduced would be permanently invisible/unresolvable.
   */
  private async isTaskInConversation(
    task: { id: number; description?: string | null },
    conversationId: number
  ): Promise<boolean> {
    const tagged = conversationIdOfTask(task);
    if (tagged !== undefined) return tagged === conversationId;

    const messages = await this.db.getMessages(conversationId);
    const owningMessage = messages.find(
      (m) => m.role === "system" && isBotHandoffAssignMessage(m.content, task.id)
    );
    if (!owningMessage) return false;

    await this.db.updateTask(task.id, {
      description: [task.description?.trim() || "", encodeConversationTag(conversationId)].filter(Boolean).join(" "),
    });
    return true;
  }

  /** Parse a message for handoff patterns: assign, done, and blocked.
   *  Returns the tasks that were created or updated during this call. */
  async processMessageForHandoffs(
    message: string,
    authorBotSlug: string,
    conversationId: number,
    participants: string[]
  ): Promise<HandoffTask[]> {
    const results: HandoffTask[] = [];

    // --- Assignment: "@botB übernimm X" ---
    const assignMatch = HANDOFF_ASSIGN_RE.exec(message);
    if (assignMatch) {
      const targetSlug = assignMatch[1]!.toLowerCase();
      const taskDescription = assignMatch[2]!.trim();

      if (participants.includes(targetSlug)) {
        const task = await this.db.createTask({
          title: taskDescription.slice(0, 200),
          description: `Assigned by @${authorBotSlug} to @${targetSlug} in group chat ${encodeConversationTag(conversationId)}`,
          projectId: undefined,
          priority: "medium",
          status: "pending",
          subtasks: undefined,
          result: undefined,
          createdBy: encodeCreatedBy(authorBotSlug, targetSlug),
        });

        await this.db.addMessage({
          conversationId,
          role: "system",
          content: JSON.stringify({
            type: "bot_handoff",
            action: "assign",
            taskId: task.id,
            fromBot: authorBotSlug,
            toBot: targetSlug,
            description: taskDescription,
          }),
          metadata: JSON.stringify({ internal: true, handoff: true }),
        });

        results.push({
          taskId: task.id,
          title: task.title,
          assignedBy: authorBotSlug,
          assignedTo: targetSlug,
          conversationId,
          status: "pending",
          priority: "medium",
          acceptanceCriteria: taskDescription,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });

        logger.info("Bot handoff created", {
          taskId: task.id,
          from: authorBotSlug,
          to: targetSlug,
          description: taskDescription.slice(0, 80),
        });
      } else {
        logger.debug("Handoff target not in chat", { targetSlug, participants });
      }
    }

    // --- Completion: "@botB erledigt" ---
    const doneMatch = HANDOFF_DONE_RE.exec(message);
    if (doneMatch) {
      const targetSlug = doneMatch[1]!.toLowerCase();
      const resultText = doneMatch[2]?.trim() || undefined;

      // Find pending tasks assigned TO targetSlug (means targetSlug is the
      // bot being told "you're done"), matched by `createdBy` encoding.
      const matched = await this.findHandoffTaskByTarget(targetSlug, "pending", conversationId);
      if (matched) {
        const doneTask = await this.db.updateTask(matched.id, {
          status: "completed",
          result: resultText ?? `Erledigt von @${authorBotSlug}`,
        });
        if (doneTask) {
          const decoded = decodeCreatedBy(doneTask.createdBy ?? "");
          results.push({
            taskId: doneTask.id,
            title: doneTask.title,
            assignedBy: decoded?.source ?? "",
            assignedTo: decoded?.target ?? targetSlug,
            conversationId,
            status: "completed",
            priority: (doneTask.priority as HandoffTask["priority"]) || "medium",
            result: doneTask.result ?? undefined,
            createdAt: doneTask.createdAt,
            updatedAt: doneTask.updatedAt,
          });

          await this.db.addMessage({
            conversationId,
            role: "system",
            content: JSON.stringify({
              type: "bot_handoff",
              action: "complete",
              taskId: doneTask.id,
              fromBot: authorBotSlug,
              toBot: targetSlug,
              result: resultText,
            }),
            metadata: JSON.stringify({ internal: true, handoff: true }),
          });

          logger.info("Bot handoff completed", {
            taskId: doneTask.id,
            completedBy: authorBotSlug,
            target: targetSlug,
          });
        }
      }
    }

    // --- Blocked: "@botB blockiert durch X" ---
    const blockedMatch = HANDOFF_BLOCKED_RE.exec(message);
    if (blockedMatch) {
      const targetSlug = blockedMatch[1]!.toLowerCase();
      const reason = blockedMatch[2]?.trim() || undefined;

      const matched = await this.findHandoffTaskByTarget(targetSlug, "pending", conversationId);
      if (matched) {
        const blockedTask = await this.db.updateTask(matched.id, {
          status: "blocked",
          result: reason ?? `Blockiert von @${authorBotSlug}`,
        });
        if (blockedTask) {
          const decoded = decodeCreatedBy(blockedTask.createdBy ?? "");
          results.push({
            taskId: blockedTask.id,
            title: blockedTask.title,
            assignedBy: decoded?.source ?? "",
            assignedTo: decoded?.target ?? targetSlug,
            conversationId,
            status: "blocked",
            priority: (blockedTask.priority as HandoffTask["priority"]) || "medium",
            result: blockedTask.result ?? undefined,
            createdAt: blockedTask.createdAt,
            updatedAt: blockedTask.updatedAt,
          });
        }
      }
    }

    return results;
  }

  /**
   * Find the first pending task assigned TO a specific bot slug.
   * Uses the `createdBy: "bot:<source>→<target>"` encoding.
   */
  private async findHandoffTaskByTarget(
    targetSlug: string,
    status: string,
    conversationId: number
  ): Promise<{ id: number; createdBy: string | null } | null> {
    const allTasks = await this.db.listTasks();
    const suffix = `${TASK_ARROW}${targetSlug}`;
    for (const t of allTasks) {
      if (!t.createdBy?.startsWith(TASK_CREATED_BY_PREFIX)) continue;
      if (!t.createdBy.endsWith(suffix)) continue;
      if (t.status !== status) continue;
      if (!(await this.isTaskInConversation(t, conversationId))) continue;
      return { id: t.id, createdBy: t.createdBy };
    }
    return null;
  }

  private toHandoffTask(t: { id: number; title: string; createdBy: string | null; status: string; priority: string | null; result?: string | null; createdAt: string; updatedAt: string }, conversationId: number): HandoffTask {
    const decoded = decodeCreatedBy(t.createdBy ?? "");
    return {
      taskId: t.id,
      title: t.title,
      assignedBy: decoded?.source ?? "",
      assignedTo: decoded?.target ?? "",
      conversationId,
      status: (t.status as HandoffTask["status"]) || "pending",
      priority: (t.priority as HandoffTask["priority"]) || "medium",
      result: t.result ?? undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /**
   * Get all open handoff tasks for a conversation. Filtered by the conversationId tag so one
   * group chat never sees another chat's open handoffs.
   */
  async getOpenHandoffs(conversationId: number): Promise<HandoffTask[]> {
    const allTasks = await this.db.listTasks();
    const candidates = allTasks.filter(
      (t) => t.createdBy?.startsWith(TASK_CREATED_BY_PREFIX) && t.status !== "completed"
    );
    const owned: typeof candidates = [];
    for (const t of candidates) {
      if (await this.isTaskInConversation(t, conversationId)) owned.push(t);
    }
    return owned.map((t) => this.toHandoffTask(t, conversationId));
  }

  /**
   * Kanban-lite: the full task board for one group chat - all handoff tasks (open AND
   * completed), newest first - so a later exchange can resume where a previous one left off.
   */
  async listHandoffTasks(conversationId: number): Promise<HandoffTask[]> {
    const allTasks = await this.db.listTasks();
    const candidates = allTasks.filter((t) => t.createdBy?.startsWith(TASK_CREATED_BY_PREFIX));
    const owned: typeof candidates = [];
    for (const t of candidates) {
      if (await this.isTaskInConversation(t, conversationId)) owned.push(t);
    }
    return owned
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((t) => this.toHandoffTask(t, conversationId));
  }

  /** Build a context summary of open handoffs for injection into bot prompts. */
  async getHandoffContext(conversationId: number): Promise<string> {
    const open = await this.getOpenHandoffs(conversationId);
    if (open.length === 0) return "";

    const lines = ["=== Open Task Handoffs ==="];
    for (const h of open) {
      lines.push(
        `  #${h.taskId} [${h.status}] @${h.assignedBy} → @${h.assignedTo}: ${h.title}`
      );
    }
    lines.push(
      "Use '@botname done' to signal completion, '@botname blocked by X' to flag blockers."
    );
    return lines.join("\n");
  }
}