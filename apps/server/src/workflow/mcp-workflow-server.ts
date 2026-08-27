import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getSessionManager } from "../lib/session-manager.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

interface WorkflowSessionData {
  currentWorkflowId?: string;
  executionState?: Record<string, unknown>;
  executionStartTime?: number;
  nodeResults?: Record<string, unknown>;
}

export function createWorkflowMcpTool(db: DatabaseService): ToolExecutor {
  const sessionManager = getSessionManager();

  return {
    name: "workflow",
    description: "Manage workflows and automation nodes - session-based execution",
    definition: {
      name: "workflow",
      description: "Workflow and automation management with execution context",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "session_create",
              "session_close",
              "session_list",
              "list_workflows",
              "create_workflow",
              "run_workflow",
              "update_workflow",
              "delete_workflow",
              "get_workflow",
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
          name: {
            type: "string",
            description: "Workflow name (for create_workflow, update_workflow)",
          },
          description: {
            type: "string",
            description: "Workflow description (for create_workflow, update_workflow)",
          },
          nodes: {
            type: "array",
            description: "Workflow nodes/steps (for create_workflow, update_workflow)",
            items: { type: "object", description: "Workflow node/step definition" },
          },
          workflowId: {
            type: "string",
            description: "Workflow ID (for run_workflow, update_workflow, delete_workflow, get_workflow)",
          },
          input: {
            type: "object",
            description: "Workflow input data (for run_workflow)",
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
          case "list_workflows": {
            // TODO: Query workflows from database
            // const workflows = await db.query.workflows.findMany();

            return ok({ workflows: [], sessionId: session.id });
          }

          case "create_workflow": {
            const name = String(input["name"] ?? "");
            const description = input["description"]
              ? String(input["description"])
              : "";
            const nodes = Array.isArray(input["nodes"]) ? input["nodes"] : [];

            if (!name) return fail("name is required for create_workflow");
            if (nodes.length === 0) return fail("at least one node is required");

            // TODO: Create workflow in database
            // const newWorkflow = await db.insert(workflows).values({
            //   name, description, nodes
            // });

            return ok({
              created: true,
              workflow: { id: "wf_1", name, description, nodes },
              sessionId: session.id,
            });
          }

          case "run_workflow": {
            const workflowId = String(input["workflowId"] ?? "");
            if (!workflowId) return fail("workflowId is required for run_workflow");

            const workflowInput = input["input"] && typeof input["input"] === "object"
              ? (input["input"] as Record<string, unknown>)
              : {};

            // Initialize execution state in session
            const executionState: WorkflowSessionData = {
              currentWorkflowId: workflowId,
              executionStartTime: Date.now(),
              executionState: workflowInput,
              nodeResults: {},
            };
            sessionManager.setSessionData<WorkflowSessionData>(
              session.id,
              "executionContext",
              executionState
            );

            // TODO: Run workflow execution
            // 1. Load workflow from database
            // 2. Execute nodes sequentially/in parallel
            // 3. Update session state as nodes complete
            // 4. Handle errors and rollback if needed

            const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            return ok({
              running: true,
              workflowId,
              executionId,
              sessionId: session.id,
            });
          }

          case "update_workflow": {
            const workflowId = String(input["workflowId"] ?? "");
            if (!workflowId) return fail("workflowId is required for update_workflow");

            // TODO: Update workflow in database
            // await db.update(workflows)
            //   .set({ ...input })
            //   .where(eq(workflows.id, workflowId));

            return ok({ updated: true, workflowId, sessionId: session.id });
          }

          case "delete_workflow": {
            const workflowId = String(input["workflowId"] ?? "");
            if (!workflowId) return fail("workflowId is required for delete_workflow");

            // TODO: Delete workflow from database
            // await db.delete(workflows).where(eq(workflows.id, workflowId));

            return ok({ deleted: true, workflowId, sessionId: session.id });
          }

          case "get_workflow": {
            const workflowId = String(input["workflowId"] ?? "");
            if (!workflowId) return fail("workflowId is required for get_workflow");

            // TODO: Get workflow from database
            // const workflow = await db.query.workflows.findFirst({
            //   where: eq(workflows.id, workflowId)
            // });

            return ok({ workflow: null, sessionId: session.id });
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
