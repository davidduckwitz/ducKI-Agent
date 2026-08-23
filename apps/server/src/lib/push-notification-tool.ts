/**
 * Lets the agent send itself a browser push notification via the Cloud Voice-App (see
 * PushNotificationController::send() in the ducki-cloud-v1 repo) - useful for a long-running
 * task finishing while the user isn't looking at the Voice-App page. Lives in apps/server (not
 * packages/agent's core tools) because it depends on cloud-sync.ts's JWT-authenticated HTTP
 * client, which is app-level infrastructure the core agent package has no business depending on.
 * Registered into runtimeTools in index.ts, same way as the MCP/tasks/workflow tools.
 */
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { sendPushNotification, CloudSyncError } from "./cloud-sync.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

export function createPushNotificationTool(db: DatabaseService): ToolExecutor {
  return {
    name: "push_notification",
    description:
      "Send the user a browser push notification via the Cloud Voice-App (title + short body), delivered even if that page isn't open/focused. " +
      "Use for things worth interrupting the user for: a long task finishing, something that needs their attention. " +
      "Requires the user to have a Cloud API key connected AND have enabled notifications in the Voice-App - if either is missing, this fails gracefully (report that to the user, don't retry).",
    definition: {
      name: "push_notification",
      description: "Send a browser push notification to the user's Voice-App.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short notification title (a few words)" },
          body: { type: "string", description: "Notification body text (1-2 sentences)" },
          url: { type: "string", description: "Optional path to open on click, defaults to /voice" },
        },
        required: ["title", "body"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const title = String(input["title"] ?? "").trim();
      const body = String(input["body"] ?? "").trim();
      if (!title) return fail("'title' is required");
      if (!body) return fail("'body' is required");
      const url = typeof input["url"] === "string" ? input["url"].trim() || undefined : undefined;

      try {
        const result = await sendPushNotification(db, title, body, url);
        if (result.reason === "no_subscriptions") {
          return fail("The user has no active push subscriptions - they haven't enabled notifications in the Voice-App (bell icon).");
        }
        return ok(result);
      } catch (error) {
        if (error instanceof CloudSyncError) {
          return fail(`Push notification unavailable: ${error.message}`);
        }
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
