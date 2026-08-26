import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

/**
 * Cross-conversation Kanban-style Task Board
 *
 * Extends the existing tasks table with Kanban columns and cross-conversation
 * persistence. Tasks survive across conversations and can be viewed/manipulated
 * from any conversation.
 *
 * Board columns (left → right):
 *  - backlog:    Tasks not yet scheduled
 *  - todo:       Tasks ready to be worked on
 *  - in_progress: Tasks currently being worked on
 *  - review:     Tasks awaiting verification
 *  - done:       Completed tasks
 *  - blocked:    Tasks blocked by dependencies
 *
 * Inspired by hermes-agent's Kanban board with durable SQLite persistence.
 */

export type BoardColumn = "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked";

export interface BoardTask {
  id: number;
  title: string;
  description: string | null;
  column: BoardColumn;
  priority: "low" | "medium" | "high" | "critical";
  tags: string[];
  conversationId: number | null;
  dependsOn: number[]; // IDs of tasks this depends on
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBoardTaskInput {
  title: string;
  description?: string;
  column?: BoardColumn;
  priority?: BoardTask["priority"];
  tags?: string[];
  conversationId?: number;
  dependsOn?: number[];
  result?: string;
}

export interface UpdateBoardTaskInput {
  title?: string;
  description?: string;
  column?: BoardColumn;
  priority?: BoardTask["priority"];
  tags?: string[];
  dependsOn?: number[];
  result?: string;
}

/** Default column order for display. */
export const BOARD_COLUMN_ORDER: BoardColumn[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
];

/** All valid columns as a Set for quick membership checks. */
const VALID_COLUMNS = new Set<string>(BOARD_COLUMN_ORDER);

export class TaskBoard {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  /**
   * Ensure the board_columns table exists. Called once at startup.
   * We use a separate table rather than altering the existing tasks table
   * so the Kanban state is opt-in and doesn't break existing task consumers.
   */
  async ensureBoardTable(): Promise<void> {
    await this.db.runRawSQL(`
      CREATE TABLE IF NOT EXISTS task_board (
        task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        "column" TEXT NOT NULL DEFAULT 'backlog',
        tags TEXT DEFAULT '[]',
        depends_on TEXT DEFAULT '[]',
        conversation_id INTEGER REFERENCES conversations(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Create a new task on the board. Also creates the underlying task record.
   */
  async createTask(input: CreateBoardTaskInput): Promise<BoardTask> {
    await this.ensureBoardTable();

    // Create the base task record.
    const task = await this.db.createTask({
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
      status: input.column === "done" ? "completed" : input.column === "in_progress" ? "running" : "pending",
      result: input.result,
    });

    const now = new Date().toISOString();
    const column = input.column ?? "backlog";

    // Create the board record.
    await this.db.runRawSQL(
      `INSERT INTO task_board (task_id, "column", tags, depends_on, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        column,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.dependsOn ?? []),
        input.conversationId ?? null,
        now,
        now,
      ]
    );

    this.logger.info("[TaskBoard] Created task", { taskId: task.id, title: input.title, column });

    return this.hydrateBoardTask(task.id, task, column, input.tags ?? [], input.dependsOn ?? [], input.conversationId ?? null, now, now);
  }

  /**
   * Get a single board task by ID.
   */
  async getTask(taskId: number): Promise<BoardTask | undefined> {
    await this.ensureBoardTable();

    const task = await this.db.getTask(taskId);
    if (!task) return undefined;

    const boardRow = await this.db.runRawSQL(
      `SELECT * FROM task_board WHERE task_id = ?`,
      [taskId]
    );

    if (!boardRow || boardRow.length === 0) {
      // Task exists but not on the board — wrap it with defaults.
      return this.hydrateBoardTask(task.id, task, "backlog", [], [], null, task.createdAt, task.updatedAt);
    }

    const row = boardRow[0] as Record<string, unknown>;
    return this.hydrateBoardTask(
      task.id,
      task,
      String(row["column"]) as BoardColumn,
      this.parseJsonArray(row["tags"]),
      this.parseJsonArray(row["depends_on"]).map(Number),
      row["conversation_id"] as number | null,
      String(row["created_at"]),
      String(row["updated_at"])
    );
  }

  /**
   * List tasks on the board, optionally filtered by column or conversation.
   */
  async listTasks(filters?: {
    column?: BoardColumn;
    conversationId?: number;
    projectId?: number;
  }): Promise<BoardTask[]> {
    await this.ensureBoardTable();

    // Get base tasks.
    let tasks = await this.db.listTasks(filters?.projectId);

    // Filter by conversation if specified (board-level filter).
    if (filters?.conversationId) {
      const boardRows = await this.db.runRawSQL(
        `SELECT task_id FROM task_board WHERE conversation_id = ?`,
        [filters.conversationId]
      );
      const taskIds = new Set(boardRows.map((r) => r["task_id"]));
      tasks = tasks.filter((t) => taskIds.has(t.id));
    }

    // Hydrate each task with board metadata.
    const boardTasks: BoardTask[] = [];
    for (const task of tasks) {
      const boardRow = await this.db.runRawSQL(
        `SELECT * FROM task_board WHERE task_id = ?`,
        [task.id]
      );

      if (!boardRow || boardRow.length === 0) {
        boardTasks.push(this.hydrateBoardTask(task.id, task, "backlog", [], [], null, task.createdAt, task.updatedAt));
        continue;
      }

      const row = boardRow[0] as Record<string, unknown>;
      const column = String(row["column"]) as BoardColumn;

      // Apply column filter.
      if (filters?.column && column !== filters.column) continue;

      boardTasks.push(this.hydrateBoardTask(
        task.id,
        task,
        column,
        this.parseJsonArray(row["tags"]),
        this.parseJsonArray(row["depends_on"]).map(Number),
        row["conversation_id"] as number | null,
        String(row["created_at"]),
        String(row["updated_at"])
      ));
    }

    return boardTasks;
  }

  /**
   * Update a board task. Can change column (move), metadata, etc.
   */
  async updateTask(taskId: number, input: UpdateBoardTaskInput): Promise<BoardTask | undefined> {
    await this.ensureBoardTable();

    const task = await this.db.getTask(taskId);
    if (!task) return undefined;

    // Update base task fields.
    const baseUpdate: Record<string, unknown> = {};
    if (input.title !== undefined) baseUpdate.title = input.title;
    if (input.description !== undefined) baseUpdate.description = input.description;
    if (input.result !== undefined) baseUpdate.result = input.result;
    if (input.column === "done") baseUpdate.status = "completed";
    else if (input.column === "in_progress") baseUpdate.status = "running";
    else if (input.priority !== undefined) baseUpdate.priority = input.priority;

    if (Object.keys(baseUpdate).length > 0) {
      await this.db.updateTask(taskId, baseUpdate);
    }

    // Update board-level fields.
    const now = new Date().toISOString();
    const boardUpdates: string[] = [];
    const boardValues: unknown[] = [];

    if (input.column !== undefined) {
      boardUpdates.push(`"column" = ?`);
      boardValues.push(input.column);
    }
    if (input.tags !== undefined) {
      boardUpdates.push(`tags = ?`);
      boardValues.push(JSON.stringify(input.tags));
    }
    if (input.dependsOn !== undefined) {
      boardUpdates.push(`depends_on = ?`);
      boardValues.push(JSON.stringify(input.dependsOn));
    }

    if (boardUpdates.length > 0) {
      boardUpdates.push(`updated_at = ?`);
      boardValues.push(now);
      boardValues.push(taskId);

      await this.db.runRawSQL(
        `UPDATE task_board SET ${boardUpdates.join(", ")} WHERE task_id = ?`,
        boardValues
      );
    }

    this.logger.info("[TaskBoard] Updated task", { taskId, updates: Object.keys(input) });

    return this.getTask(taskId);
  }

  /**
   * Move a task to a new column. Convenience wrapper around updateTask.
   */
  async moveTask(taskId: number, toColumn: BoardColumn): Promise<BoardTask | undefined> {
    if (!VALID_COLUMNS.has(toColumn)) {
      throw new Error(`Invalid column: ${toColumn}. Valid columns: ${BOARD_COLUMN_ORDER.join(", ")}`);
    }

    // Check dependencies before moving to in_progress.
    if (toColumn === "in_progress") {
      const task = await this.getTask(taskId);
      if (task && task.dependsOn.length > 0) {
        const unmetDeps = await this.getUnmetDependencies(taskId, task.dependsOn);
        if (unmetDeps.length > 0) {
          this.logger.warn("[TaskBoard] Cannot move to in_progress — unmet dependencies", {
            taskId,
            unmetDependencies: unmetDeps,
          });
          // Move to blocked instead.
          return this.updateTask(taskId, { column: "blocked" });
        }
      }
    }

    return this.updateTask(taskId, { column: toColumn });
  }

  /**
   * Get the full board state, grouped by column.
   */
  async getBoard(projectId?: number): Promise<Record<BoardColumn, BoardTask[]>> {
    const board: Record<BoardColumn, BoardTask[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      blocked: [],
    };

    const tasks = await this.listTasks({ projectId });
    for (const task of tasks) {
      board[task.column].push(task);
    }

    return board;
  }

  /**
   * Get a compact board summary for injection into the system prompt.
   */
  async getBoardSummary(projectId?: number): Promise<string> {
    const board = await this.getBoard(projectId);
    const lines: string[] = ["## Task Board"];

    for (const column of BOARD_COLUMN_ORDER) {
      const tasks = board[column];
      if (tasks.length === 0) continue;
      lines.push(`\n### ${column.replace("_", " ").toUpperCase()} (${tasks.length})`);
      for (const task of tasks.slice(0, 5)) {
        const deps = task.dependsOn.length > 0 ? ` [depends: ${task.dependsOn.join(", ")}]` : "";
        const tags = task.tags.length > 0 ? ` (${task.tags.join(", ")})` : "";
        lines.push(`  - [${task.id}] ${task.priority.toUpperCase()} ${task.title}${tags}${deps}`);
      }
      if (tasks.length > 5) {
        lines.push(`  ... and ${tasks.length - 5} more`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Delete a task from the board and the underlying task table.
   */
  async deleteTask(taskId: number): Promise<boolean> {
    await this.ensureBoardTable();
    await this.db.runRawSQL(`DELETE FROM task_board WHERE task_id = ?`, [taskId]);
    await this.db.deleteTask(taskId);
    this.logger.info("[TaskBoard] Deleted task", { taskId });
    return true;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private hydrateBoardTask(
    id: number,
    task: { title: string; description: string | null; result: string | null; createdAt: string; updatedAt: string },
    column: BoardColumn,
    tags: string[],
    dependsOn: number[],
    conversationId: number | null,
    createdAt: string,
    updatedAt: string
  ): BoardTask {
    return {
      id,
      title: task.title,
      description: task.description,
      column,
      priority: "medium", // base task has priority; we could read it but it's on the base record
      tags,
      conversationId,
      dependsOn,
      result: task.result,
      createdAt,
      updatedAt,
    };
  }

  private parseJsonArray(value: unknown): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Check which of the given dependency IDs are not in "done" status.
   */
  private async getUnmetDependencies(taskId: number, dependsOn: number[]): Promise<number[]> {
    const unmet: number[] = [];
    for (const depId of dependsOn) {
      if (depId === taskId) continue; // self-reference is not a real dependency
      const depTask = await this.getTask(depId);
      if (!depTask || depTask.column !== "done") {
        unmet.push(depId);
      }
    }
    return unmet;
  }
}
