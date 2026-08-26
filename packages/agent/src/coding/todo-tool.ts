import type { ToolExecutor, ToolResult } from "@ducki/shared";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
  note?: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "done", "blocked"]);

/**
 * The coding agent's plan, held as STRUCTURED state instead of being recovered from prose.
 *
 * Progress used to be tracked by searching the model's answer for literal markers
 * (">> PHASE: EDIT"). That fails in the two situations where knowing the progress matters most:
 * a model that paraphrases the marker produces no events at all, and a model that narrates a
 * phase it never actually performed produces events for work that did not happen. Neither can
 * occur here - a step only changes state when the model calls the tool to change it, and the UI
 * renders the same list the model is steering by.
 */
export class TodoList {
  private items: TodoItem[] = [];
  private nextId = 1;

  constructor(
    private readonly onChange?: (items: TodoItem[]) => void,
    /**
     * Fired ONLY when the checklist's STEP SET itself changes (replace()), never on a plain
     * status/note update() - a caller that wants to mirror the checklist's structure back into
     * something else (e.g. CodingAgent syncing its Plan object, see coding-agent.ts) needs to
     * react to "the steps changed" specifically, not to every status tick.
     */
    private readonly onReplace?: (items: TodoItem[]) => void
  ) {}

  reset(): void {
    this.items = [];
    this.nextId = 1;
    this.onChange?.([]);
  }

  snapshot(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * A small model often calls write more than once per run (to add a step, to reorder, or
   * because it forgot it already wrote a plan) even though the tool description says "once".
   * Reassigning fresh ids on every call would silently invalidate any id the model memorized
   * from the previous write's response or from the checklist replayed into a follow-up prompt
   * (see buildFollowUpPrompt), producing "No step with id N" on the very next update call. So an
   * entry whose title matches an existing item keeps that item's id (and its status/note unless
   * the new entry overrides them); only genuinely new titles get a fresh id.
   */
  replace(titles: Array<{ title: string; status?: string; note?: string }>): TodoItem[] {
    const previous = [...this.items];
    this.items = titles
      .filter((entry) => entry.title?.trim())
      .map((entry) => {
        const trimmedTitle = entry.title.trim();
        const existingIndex = previous.findIndex((candidate) => candidate.title === trimmedTitle);
        const existing = existingIndex >= 0 ? previous.splice(existingIndex, 1)[0] : undefined;
        const status = VALID_STATUSES.has(String(entry.status))
          ? (entry.status as TodoStatus)
          : (existing?.status ?? "pending");
        const item: TodoItem = { id: existing?.id ?? this.nextId++, title: trimmedTitle, status };
        const note = entry.note ?? existing?.note;
        if (note) item.note = note;
        return item;
      });
    this.onChange?.(this.snapshot());
    this.onReplace?.(this.snapshot());
    return this.snapshot();
  }

  update(id: number, status: TodoStatus, note?: string): TodoItem | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    item.status = status;
    if (note !== undefined) item.note = note;
    this.onChange?.(this.snapshot());
    return { ...item };
  }

  /**
   * Applies several status updates as ONE change instead of N. A model with e.g. two steps to
   * close out in the same turn had to call the tool twice (a real observed pattern: two
   * consecutive `todo:update` calls, each producing its own "Checkliste aktualisiert" + Plan-sync
   * event pair, doubling both LLM round-trips and Activity-tab noise for one logical change).
   * `onChange` fires once, after every update in the batch has been applied, so the checklist and
   * Plan panel both see the final state directly instead of two intermediate ones.
   */
  updateMany(updates: Array<{ id: number; status: TodoStatus; note?: string }>): {
    updated: TodoItem[];
    missingIds: number[];
  } {
    const updated: TodoItem[] = [];
    const missingIds: number[] = [];
    for (const { id, status, note } of updates) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) {
        missingIds.push(id);
        continue;
      }
      item.status = status;
      if (note !== undefined) item.note = note;
      updated.push({ ...item });
    }
    if (updated.length > 0) this.onChange?.(this.snapshot());
    return { updated, missingIds };
  }

  /** Compact rendering for a prompt block: short enough to send every iteration. */
  render(): string {
    if (this.items.length === 0) return "";
    const marks: Record<TodoStatus, string> = {
      pending: "[ ]",
      in_progress: "[~]",
      done: "[x]",
      blocked: "[!]",
    };
    return this.items.map((item) => `${marks[item.status]} ${item.id}. ${item.title}`).join("\n");
  }

  get openCount(): number {
    return this.items.filter((item) => item.status === "pending" || item.status === "in_progress").length;
  }

  /**
   * The step the model is currently working on, as a string id for RunJournalEntry.stepId.
   * Undefined when nothing is in_progress (before the first todo:update, or between steps) -
   * a journal entry created at that moment simply carries no stepId rather than a stale one.
   * If more than one item is somehow in_progress at once (the model updated out of order), the
   * first one wins - an approximate answer beats none, and this is a display aid, not a lock.
   */
  currentStepId(): string | undefined {
    const current = this.items.find((item) => item.status === "in_progress");
    return current ? String(current.id) : undefined;
  }
}

export function createTodoTool(list: TodoList): ToolExecutor {
  return {
    name: "todo",
    description: "Track the steps of the current coding task and their status.",
    definition: {
      name: "todo",
      description:
        "Maintain the plan for this task as a checklist. Call action:'write' ONCE after exploring, with the " +
        "concrete steps you intend to take. Then call action:'update' to mark a step in_progress before you " +
        "start it and done as soon as it is verified. This is the record the user sees - keep it accurate, " +
        "and never mark a step done before its change is actually verified. If you are closing out more than " +
        "one step in the same turn, pass `updates` (a list) instead of `id`/`status` and do it in ONE call - " +
        "do not call this tool twice in a row for two separate steps.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["write", "update", "list"],
            description:
              "write: replace the whole checklist with a new list of steps. " +
              "update: change one step's status (or several, via `updates`). list: read the current checklist back.",
          },
          items: {
            type: "array",
            description: "For write: the steps, in the order you will do them.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "What this step does, in one short sentence." },
                status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
              },
              required: ["title"],
            },
          },
          id: { type: "number", description: "For update (single step): the step id shown in the checklist." },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done", "blocked"],
            description: "For update (single step): the step's new status.",
          },
          note: { type: "string", description: "For update (single step): one short line on what happened (e.g. why it is blocked)." },
          updates: {
            type: "array",
            description:
              "For update: change SEVERAL steps in one call instead of calling this tool once per step. " +
              "Use this instead of `id`/`status` whenever more than one step changes in the same turn.",
            items: {
              type: "object",
              properties: {
                id: { type: "number", description: "The step id shown in the checklist." },
                status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
                note: { type: "string", description: "One short line on what happened (e.g. why it is blocked)." },
              },
              required: ["id", "status"],
            },
          },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "list").toLowerCase();

      if (action === "list") {
        return { success: true, data: { items: list.snapshot(), open: list.openCount } };
      }

      if (action === "write") {
        const raw = input["items"];
        if (!Array.isArray(raw) || raw.length === 0) {
          return {
            success: false,
            data: null,
            error: 'items required for write: [{"title": "Read the router and find the handler"}, ...]',
          };
        }
        const items = list.replace(
          raw.map((entry) => {
            const record = (entry ?? {}) as Record<string, unknown>;
            const result: { title: string; status?: string; note?: string } = {
              title: String(record["title"] ?? ""),
            };
            if (typeof record["status"] === "string") result.status = record["status"];
            if (typeof record["note"] === "string") result.note = record["note"];
            return result;
          })
        );
        return { success: true, data: { items, open: list.openCount } };
      }

      if (action === "update") {
        const rawUpdates = input["updates"];
        if (Array.isArray(rawUpdates) && rawUpdates.length > 0) {
          const parsed: Array<{ id: number; status: TodoStatus; note?: string }> = [];
          const invalid: unknown[] = [];
          for (const entry of rawUpdates) {
            const record = (entry ?? {}) as Record<string, unknown>;
            const id = Number(record["id"]);
            const status = String(record["status"] ?? "");
            if (!Number.isFinite(id) || !VALID_STATUSES.has(status)) {
              invalid.push(entry);
              continue;
            }
            const note = typeof record["note"] === "string" ? (record["note"] as string) : undefined;
            parsed.push({ id, status: status as TodoStatus, note });
          }
          if (parsed.length === 0) {
            return {
              success: false,
              data: null,
              error: `updates must be a non-empty list of {"id": number, "status": "${[...VALID_STATUSES].join('"|"')}"}`,
            };
          }
          const { updated, missingIds } = list.updateMany(parsed);
          return {
            success: updated.length > 0,
            data: { updatedItems: updated, items: list.snapshot(), open: list.openCount },
            ...(missingIds.length > 0 || invalid.length > 0
              ? {
                  error: [
                    missingIds.length > 0 ? `No step with id ${missingIds.join(", ")}.` : undefined,
                    invalid.length > 0 ? `${invalid.length} update(s) had a missing/invalid id or status and were skipped.` : undefined,
                  ].filter(Boolean).join(" "),
                }
              : {}),
          };
        }

        const id = Number(input["id"]);
        const status = String(input["status"] ?? "");
        if (!Number.isFinite(id)) {
          return { success: false, data: null, error: "id required for update (the number shown in the checklist)" };
        }
        if (!VALID_STATUSES.has(status)) {
          return {
            success: false,
            data: null,
            error: `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
          };
        }
        const note = typeof input["note"] === "string" ? (input["note"] as string) : undefined;
        const updated = list.update(id, status as TodoStatus, note);
        if (!updated) {
          return {
            success: false,
            data: null,
            error: `No step with id ${id}. Current checklist:\n${list.render() || "(empty - call action:'write' first)"}`,
          };
        }
        return { success: true, data: { item: updated, items: list.snapshot(), open: list.openCount } };
      }

      return { success: false, data: null, error: `Unknown action: ${action}. Use write, update or list.` };
    },
  };
}
