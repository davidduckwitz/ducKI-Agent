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

  constructor(private readonly onChange?: (items: TodoItem[]) => void) {}

  reset(): void {
    this.items = [];
    this.nextId = 1;
    this.onChange?.([]);
  }

  snapshot(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  replace(titles: Array<{ title: string; status?: string; note?: string }>): TodoItem[] {
    this.items = titles
      .filter((entry) => entry.title?.trim())
      .map((entry) => {
        const status = VALID_STATUSES.has(String(entry.status)) ? (entry.status as TodoStatus) : "pending";
        const item: TodoItem = { id: this.nextId++, title: entry.title.trim(), status };
        if (entry.note) item.note = entry.note;
        return item;
      });
    this.onChange?.(this.snapshot());
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
        "and never mark a step done before its change is actually verified.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["write", "update", "list"],
            description:
              "write: replace the whole checklist with a new list of steps. " +
              "update: change one step's status. list: read the current checklist back.",
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
          id: { type: "number", description: "For update: the step id shown in the checklist." },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done", "blocked"],
            description: "For update: the step's new status.",
          },
          note: { type: "string", description: "For update: one short line on what happened (e.g. why it is blocked)." },
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
