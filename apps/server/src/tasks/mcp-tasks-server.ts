import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getSessionManager } from "../lib/session-manager.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

interface TaskSessionData {
  selectedBoardId?: string;
  filteredStatus?: string;
  lastQuery?: Record<string, unknown>;
}

export function createTasksMcpTool(db: DatabaseService): ToolExecutor {
  const sessionManager = getSessionManager();

  return {
    name: "tasks",
    description: "Manage tasks and kanban board - session-based task operations",
    definition: {
      name: "tasks",
      description: "Task and kanban board management with session context",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "session_create",
              "session_close",
              "session_list",
              "list_tasks",
              "create_task",
              "update_task",
              "delete_task",
              "get_task",
              "list_boards",
            ],
            description: "Action to perform",
          },
          sessionId: {
            type: "string",
            description: "Session ID (auto-created from agentId if not provided)",
          },
          agentId: {
            type: "string",
            description: "Agent ID for implicit session management",
          },
          title: {
            type: "string",
            description: "Task title (for create_task, update_task)",
          },
          description: {
            type: "string",
            description: "Task description (for create_task, update_task)",
          },
          status: {
            type: "string",
            enum: ["todo", "in_progress", "done"],
            description: "Task status (for create_task, update_task)",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Task priority (for create_task, update_task)",
          },
          taskId: {
            type: "number",
            description: "Task ID (for update_task, delete_task, get_task)",
          },
          boardId: {
            type: "string",
            description: "Board ID (for filtering tasks)",
          },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      const sessionId = input["sessionId"] ? String(input["sessionId"]) : undefined;
      const agentId = input["agentId"] ? String(input["agentId"]) : undefined;

      try {
        // Session management actions
        if (action === "session_create") {
          const session = sessionManager.getOrCreateSession(sessionId, agentId);
          return ok({
            sessionCreated: true,
            sessionId: session.id,
            agentId: session.agentId,
          });
        }

        if (action === "session_close") {
          if (!sessionId && !agentId) {
            return fail("sessionId or agentId required for session_close");
          }
          const id = sessionId || agentId;
          const closed = sessionManager.closeSession(id!);
          return ok({ sessionClosed: closed, sessionId: id });
        }

        if (action === "session_list") {
          const sessions = sessionManager.listSessions();
          return ok({
            sessions: sessions.map((s) => ({
              id: s.id,
              agentId: s.agentId,
              createdAt: new Date(s.createdAt).toISOString(),
              lastAccessedAt: new Date(s.lastAccessedAt).toISOString(),
            })),
          });
        }

        // All other actions require a session
        const actualSessionId = sessionId || agentId;
        if (!actualSessionId) {
          return fail("sessionId or agentId required for this action");
        }

        const session = sessionManager.getOrCreateSession(sessionId, agentId);

        switch (action) {
          case "list_tasks": {
            const boardId = input["boardId"] ? String(input["boardId"]) : undefined;

            // Store query context in session
            const taskData: TaskSessionData = {
              selectedBoardId: boardId,
              lastQuery: input,
            };
            sessionManager.setSessionData<TaskSessionData>(session.id, "taskContext", taskData);

            // TODO: Query tasks from database
            // const tasks = await db.query.tasks.findMany({
            //   where: boardId ? eq(tasks.boardId, boardId) : undefined,
            // });

            return ok({ tasks: [], sessionId: session.id });
          }

          case "create_task": {
            const title = String(input["title"] ?? "");
            const description = input["description"]
              ? String(input["description"])
              : "";
            const status = String(input["status"] ?? "todo");
            const priority = String(input["priority"] ?? "medium");
            const boardId = input["boardId"] ? String(input["boardId"]) : undefined;

            if (!title) return fail("title is required for create_task");

            // TODO: Create task in database
            // const newTask = await db.insert(tasks).values({
            //   title, description, status, priority, boardId
            // });

            return ok({
              created: true,
              task: { id: 1, title, description, status, priority, boardId },
              sessionId: session.id,
            });
          }

          case "update_task": {
            const taskId = Number(input["taskId"] ?? 0);
            if (!taskId) return fail("taskId is required for update_task");

            // TODO: Update task in database
            // const updated = await db.update(tasks)
            //   .set({ ...input })
            //   .where(eq(tasks.id, taskId));

            return ok({ updated: true, taskId, sessionId: session.id });
          }

          case "delete_task": {
            const taskId = Number(input["taskId"] ?? 0);
            if (!taskId) return fail("taskId is required for delete_task");

            // TODO: Delete task from database
            // await db.delete(tasks).where(eq(tasks.id, taskId));

            return ok({ deleted: true, taskId, sessionId: session.id });
          }

          case "get_task": {
            const taskId = Number(input["taskId"] ?? 0);
            if (!taskId) return fail("taskId is required for get_task");

            // TODO: Get task from database
            // const task = await db.query.tasks.findFirst({
            //   where: eq(tasks.id, taskId)
            // });

            return ok({ task: null, sessionId: session.id });
          }

          case "list_boards": {
            // TODO: List all kanban boards
            // const boards = await db.query.boards.findMany();

            return ok({ boards: [], sessionId: session.id });
          }

          default:
            return fail(`Unknown action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
