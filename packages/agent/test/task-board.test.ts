import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TaskBoard,
  BOARD_COLUMN_ORDER,
  type BoardColumn,
  type CreateBoardTaskInput,
} from "../src/task-board/task-board.js";

// ── Mock DatabaseService ────────────────────────────────────────────────────

function makeMockDb() {
  let nextTaskId = 1;
  const tasks = new Map<number, any>();
  const boardRows = new Map<number, any>();

  return {
    createTask: vi.fn(async (data: any) => {
      const id = nextTaskId++;
      const task = {
        id,
        title: data.title,
        description: data.description ?? null,
        status: data.status ?? "pending",
        priority: data.priority ?? "medium",
        subtasks: data.subtasks ?? null,
        result: data.result ?? null,
        parentTaskId: data.parentTaskId ?? null,
        createdBy: data.createdBy ?? null,
        projectId: data.projectId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, task);
      return task;
    }),
    getTask: vi.fn(async (id: number) => tasks.get(id)),
    listTasks: vi.fn(async (projectId?: number) => {
      const all = Array.from(tasks.values());
      if (projectId !== undefined) return all.filter((t) => t.projectId === projectId);
      return all;
    }),
    updateTask: vi.fn(async (id: number, data: any) => {
      const task = tasks.get(id);
      if (!task) return undefined;
      Object.assign(task, data, { updatedAt: new Date().toISOString() });
      return task;
    }),
    deleteTask: vi.fn(async (id: number) => {
      tasks.delete(id);
      boardRows.delete(id);
    }),
    runRawSQL: vi.fn(async (sql: string, args?: unknown[]) => {
      // Simulate task_board operations
      if (sql.includes("CREATE TABLE")) return [];
      if (sql.includes("INSERT INTO task_board")) {
        const taskId = args?.[0] as number;
        boardRows.set(taskId, {
          task_id: taskId,
          column: args?.[1] ?? "backlog",
          tags: args?.[2] ?? "[]",
          depends_on: args?.[3] ?? "[]",
          conversation_id: args?.[4] ?? null,
          created_at: args?.[5] ?? new Date().toISOString(),
          updated_at: args?.[6] ?? new Date().toISOString(),
        });
        return [];
      }
      if (sql.includes("SELECT * FROM task_board WHERE task_id = ?")) {
        const taskId = args?.[0] as number;
        const row = boardRows.get(taskId);
        return row ? [row] : [];
      }
      if (sql.includes("SELECT task_id FROM task_board WHERE conversation_id = ?")) {
        const convId = args?.[0] as number;
        return Array.from(boardRows.values())
          .filter((r) => r.conversation_id === convId)
          .map((r) => ({ task_id: r.task_id }));
      }
      if (sql.includes("UPDATE task_board")) {
        const taskId = args?.[args!.length - 1] as number;
        const row = boardRows.get(taskId);
        if (row) {
          // Parse SET clauses
          const setPart = sql.split("SET")[1]?.split("WHERE")[0] ?? "";
          const fields = setPart.split(",").map((s) => s.trim().split("=")[0].replace(/"/g, "").trim());
          for (let i = 0; i < fields.length; i++) {
            const val = args?.[i];
            if (val !== undefined) row[fields[i]] = val;
          }
          row.updated_at = new Date().toISOString();
        }
        return [];
      }
      if (sql.includes("DELETE FROM task_board")) {
        const taskId = args?.[0] as number;
        boardRows.delete(taskId);
        return [];
      }
      return [];
    }),
    // Expose for test assertions
    _tasks: tasks,
    _boardRows: boardRows,
  };
}

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("TaskBoard", () => {
  let db: ReturnType<typeof makeMockDb>;
  let logger: ReturnType<typeof makeFakeLogger>;
  let board: TaskBoard;

  beforeEach(() => {
    db = makeMockDb();
    logger = makeFakeLogger();
    board = new TaskBoard(db as any, logger);
  });

  describe("createTask", () => {
    it("creates a task with default backlog column", async () => {
      const task = await board.createTask({ title: "Test task" });
      expect(task.id).toBe(1);
      expect(task.title).toBe("Test task");
      expect(task.column).toBe("backlog");
      expect(task.priority).toBe("medium");
      expect(task.tags).toEqual([]);
      expect(task.dependsOn).toEqual([]);
    });

    it("creates a task in a specific column", async () => {
      const task = await board.createTask({ title: "In progress task", column: "in_progress" });
      expect(task.column).toBe("in_progress");
    });

    it("creates a task with tags and dependencies", async () => {
      const task = await board.createTask({
        title: "Dependent task",
        tags: ["frontend", "urgent"],
        dependsOn: [1, 2],
      });
      expect(task.tags).toEqual(["frontend", "urgent"]);
      expect(task.dependsOn).toEqual([1, 2]);
    });

    it("creates a task linked to a conversation", async () => {
      const task = await board.createTask({
        title: "Conversation task",
        conversationId: 42,
      });
      expect(task.conversationId).toBe(42);
    });
  });

  describe("getTask", () => {
    it("returns a board task by ID", async () => {
      await board.createTask({ title: "Find me" });
      const found = await board.getTask(1);
      expect(found).toBeDefined();
      expect(found!.title).toBe("Find me");
      expect(found!.column).toBe("backlog");
    });

    it("returns undefined for non-existent task", async () => {
      const found = await board.getTask(999);
      expect(found).toBeUndefined();
    });
  });

  describe("listTasks", () => {
    it("lists all tasks", async () => {
      await board.createTask({ title: "Task 1" });
      await board.createTask({ title: "Task 2" });
      const tasks = await board.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it("filters by column", async () => {
      await board.createTask({ title: "Backlog", column: "backlog" });
      await board.createTask({ title: "In progress", column: "in_progress" });
      const backlog = await board.listTasks({ column: "backlog" });
      expect(backlog).toHaveLength(1);
      expect(backlog[0].title).toBe("Backlog");
    });

    it("filters by conversation", async () => {
      await board.createTask({ title: "Conv A", conversationId: 1 });
      await board.createTask({ title: "Conv B", conversationId: 2 });
      const convATasks = await board.listTasks({ conversationId: 1 });
      expect(convATasks).toHaveLength(1);
      expect(convATasks[0].title).toBe("Conv A");
    });
  });

  describe("updateTask", () => {
    it("updates task title", async () => {
      await board.createTask({ title: "Old title" });
      const updated = await board.updateTask(1, { title: "New title" });
      expect(updated!.title).toBe("New title");
    });

    it("updates task column (move)", async () => {
      await board.createTask({ title: "Movable" });
      const moved = await board.updateTask(1, { column: "in_progress" });
      expect(moved!.column).toBe("in_progress");
    });

    it("updates tags", async () => {
      await board.createTask({ title: "Tagged" });
      const updated = await board.updateTask(1, { tags: ["new-tag"] });
      expect(updated!.tags).toEqual(["new-tag"]);
    });
  });

  describe("moveTask", () => {
    it("moves task to new column", async () => {
      await board.createTask({ title: "Mover" });
      const moved = await board.moveTask(1, "todo");
      expect(moved!.column).toBe("todo");
    });

    it("rejects invalid column", async () => {
      await board.createTask({ title: "Invalid" });
      await expect(board.moveTask(1, "invalid" as BoardColumn)).rejects.toThrow("Invalid column");
    });
  });

  describe("getBoard", () => {
    it("returns tasks grouped by column", async () => {
      await board.createTask({ title: "Backlog 1", column: "backlog" });
      await board.createTask({ title: "Todo 1", column: "todo" });
      await board.createTask({ title: "Done 1", column: "done" });

      const b = await board.getBoard();
      expect(b.backlog).toHaveLength(1);
      expect(b.todo).toHaveLength(1);
      expect(b.done).toHaveLength(1);
      expect(b.in_progress).toHaveLength(0);
    });
  });

  describe("getBoardSummary", () => {
    it("returns a formatted summary string", async () => {
      await board.createTask({ title: "Task A", column: "todo", priority: "high" });
      await board.createTask({ title: "Task B", column: "in_progress" });

      const summary = await board.getBoardSummary();
      expect(summary).toContain("## Task Board");
      expect(summary).toContain("TODO");
      expect(summary).toContain("IN PROGRESS");
      expect(summary).toContain("Task A");
      expect(summary).toContain("Task B");
    });

    it("returns minimal string for empty board", async () => {
      const summary = await board.getBoardSummary();
      expect(summary).toBe("## Task Board");
    });
  });

  describe("deleteTask", () => {
    it("deletes a task from the board", async () => {
      await board.createTask({ title: "Deletable" });
      const deleted = await board.deleteTask(1);
      expect(deleted).toBe(true);
      const found = await board.getTask(1);
      expect(found).toBeUndefined();
    });
  });
});

describe("BOARD_COLUMN_ORDER", () => {
  it("has 6 columns", () => {
    expect(BOARD_COLUMN_ORDER).toHaveLength(6);
  });

  it("starts with backlog and ends with blocked", () => {
    expect(BOARD_COLUMN_ORDER[0]).toBe("backlog");
    expect(BOARD_COLUMN_ORDER[BOARD_COLUMN_ORDER.length - 1]).toBe("blocked");
  });
});
