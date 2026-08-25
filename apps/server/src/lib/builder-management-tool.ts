import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";

function ok(data: unknown): ToolResult { return { success: true, data }; }
function fail(error: string): ToolResult { return { success: false, data: null, error }; }

export function createBuilderManagementTool(db: DatabaseService): ToolExecutor {
  return {
    name: "builder_management",
    description: "Plan, create, validate and monitor sandboxed plugins or loader-compatible skills. Use only when the user asks to create a reusable plugin/skill, or when autonomous builder mode was explicitly enabled. New plugins are created disabled for manual approval.",
    definition: {
      name: "builder_management",
      description: "Internal API for the system-owned plugin and skill builders.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["capabilities", "preview", "create", "status"] },
          kind: { type: "string", enum: ["plugin", "skill"] },
          spec: { type: "object", description: "Structured builder specification. Call capabilities first for the exact contract." },
          runId: { type: "string", description: "Plugin builder run id for status." },
          trigger: { type: "string", enum: ["user-request", "autonomous"], description: "Required for create. autonomous is allowed only when enabled in settings." },
        },
        required: ["action"],
      },
    },
    async execute(input): Promise<ToolResult> {
      const action = String(input.action ?? "");
      const kind = String(input.kind ?? "");
      if (action === "capabilities") return ok({
        mode: (await db.getSetting("BUILDER_AGENT_MODE") ?? "manual").trim().toLowerCase(),
        plugin: {
          asynchronous: true,
          createdDisabled: true,
          archetypes: ["data-source", "storage-tool", "widget", "llm-provider"],
          flow: ["preview", "create", "status"],
          note: "The system creates and locks the scaffold; an isolated coding agent may edit only declared files, then authoritative validation runs.",
        },
        skill: {
          asynchronous: false,
          contract: {
            name: "lowercase kebab-case, max 64",
            description: "20-1024 chars describing what and when",
            instructions: "Markdown body only, min 40 chars; system owns YAML frontmatter",
            compatibility: "optional, max 500 chars",
            resources: "optional [{path under references|scripts|assets, content}], max 20",
          },
          note: "The exact loader validator checks the assembled SKILL.md and directory-name match before atomic installation.",
        },
      });
      if (kind !== "plugin" && kind !== "skill") return fail("kind must be plugin or skill");
      if (action === "status" && kind !== "plugin") return fail("status is only needed for asynchronous plugin builds");
      if ((action === "preview" || action === "create") && (!input.spec || typeof input.spec !== "object")) return fail("spec is required");
      if (action === "create") {
        const trigger = String(input.trigger ?? "");
        if (trigger !== "user-request" && trigger !== "autonomous") return fail("trigger is required for create: user-request or autonomous");
        const mode = (await db.getSetting("BUILDER_AGENT_MODE") ?? "manual").trim().toLowerCase();
        if (trigger === "autonomous" && mode !== "autonomous") return fail("Autonomous builder use is disabled; suggest the plugin or skill to the user first");
      }
      const port = Number.parseInt(process.env.PORT ?? "3001", 10);
      const path = action === "status"
        ? `/api/plugins/builder/runs/${encodeURIComponent(String(input.runId ?? ""))}`
        : kind === "plugin"
          ? action === "preview" ? "/api/plugins/builder/preview" : "/api/plugins/create-run"
          : action === "preview" ? "/api/skills/builder/preview" : "/api/skills/builder/create";
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, action === "status" ? undefined : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.spec),
        });
        const payload = await response.json() as { success?: boolean; data?: unknown; error?: string };
        if (!response.ok || payload.success === false) return fail(payload.error ?? `Builder API returned HTTP ${response.status}`);
        return ok(payload.data ?? payload);
      } catch (error) {
        return fail(`Builder API unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
