import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getSessionManager } from "../lib/session-manager.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

interface CronjobSessionData {
  lastRunResults?: Record<string, unknown>;
  filteredJobs?: string[];
  monitoringEnabled?: boolean;
}

export function createCronjobsMcpTool(db: DatabaseService): ToolExecutor {
  const sessionManager = getSessionManager();

  return {
    name: "cronjobs",
    description: "Schedule and manage automated tasks - session-based cronjob management",
    definition: {
      name: "cronjobs",
      description: "Cronjob and scheduled task management with execution tracking",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "session_create",
              "session_close",
              "session_list",
              "list_cronjobs",
              "create_cronjob",
              "update_cronjob",
              "delete_cronjob",
              "run_cronjob",
              "get_cronjob",
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
            description: "Cronjob name (for create_cronjob, update_cronjob)",
          },
          schedule: {
            type: "string",
            description: "Cron expression (for create_cronjob, update_cronjob) - e.g., '0 0 * * *'",
          },
          action_type: {
            type: "string",
            enum: ["workflow", "script", "http"],
            description: "Type of action to execute (for create_cronjob, update_cronjob)",
          },
          action_config: {
            type: "object",
            description: "Action configuration (for create_cronjob, update_cronjob)",
          },
          cronjobId: {
            type: "string",
            description: "Cronjob ID (for update_cronjob, delete_cronjob, run_cronjob, get_cronjob)",
          },
          enabled: {
            type: "boolean",
            description: "Enable/disable cronjob (for update_cronjob)",
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
          case "list_cronjobs": {
            // TODO: Query cronjobs from database
            // const cronjobs = await db.query.cronjobs.findMany();

            return ok({ cronjobs: [], sessionId: session.id });
          }

          case "create_cronjob": {
            const name = String(input["name"] ?? "");
            const schedule = String(input["schedule"] ?? "");
            const actionType = String(input["action_type"] ?? "workflow");
            const actionConfig = input["action_config"] && typeof input["action_config"] === "object"
              ? (input["action_config"] as Record<string, unknown>)
              : {};

            if (!name) return fail("name is required for create_cronjob");
            if (!schedule)
              return fail("schedule (cron expression) is required for create_cronjob");

            // TODO: Create cronjob in database
            // Validate cron expression
            // Create database entry
            // Register with cron scheduler

            return ok({
              created: true,
              cronjob: {
                id: "cj_1",
                name,
                schedule,
                action_type: actionType,
                action_config: actionConfig,
                enabled: true,
              },
              sessionId: session.id,
            });
          }

          case "update_cronjob": {
            const cronjobId = String(input["cronjobId"] ?? "");
            if (!cronjobId) return fail("cronjobId is required for update_cronjob");

            // TODO: Update cronjob in database
            // Unregister old cron schedule
            // Update database entry
            // Register with new cron schedule

            return ok({ updated: true, cronjobId, sessionId: session.id });
          }

          case "delete_cronjob": {
            const cronjobId = String(input["cronjobId"] ?? "");
            if (!cronjobId) return fail("cronjobId is required for delete_cronjob");

            // TODO: Delete cronjob from database
            // Unregister from cron scheduler
            // Delete database entry

            return ok({ deleted: true, cronjobId, sessionId: session.id });
          }

          case "run_cronjob": {
            const cronjobId = String(input["cronjobId"] ?? "");
            if (!cronjobId) return fail("cronjobId is required for run_cronjob");

            // Store run result in session
            const jobResults: CronjobSessionData = {
              lastRunResults: {
                cronjobId,
                runAt: new Date().toISOString(),
              },
            };
            sessionManager.setSessionData<CronjobSessionData>(session.id, "jobContext", jobResults);

            // TODO: Execute cronjob immediately
            // Load cronjob config
            // Execute action (workflow/script/http)
            // Store result in session
            // Update last_run_at in database

            return ok({
              running: true,
              cronjobId,
              sessionId: session.id,
            });
          }

          case "get_cronjob": {
            const cronjobId = String(input["cronjobId"] ?? "");
            if (!cronjobId) return fail("cronjobId is required for get_cronjob");

            // TODO: Get cronjob from database
            // const cronjob = await db.query.cronjobs.findFirst({
            //   where: eq(cronjobs.id, cronjobId)
            // });

            return ok({ cronjob: null, sessionId: session.id });
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
