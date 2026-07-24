import type { DatabaseService } from "@ducki/database";
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { browserTool } from "@ducki/tools";
import { previewSplit, commitSplit } from "../tasks/task-split-service.js";

type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type TaskPriority = "low" | "medium" | "high" | "critical";

type MemoryTarget = "memory" | "user";
type MemoryAction = "query" | "add" | "replace" | "remove" | "list" | "batch" | "pending_list" | "approve";

interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
}

interface PendingMemoryWrite {
  id: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface GatewayConfig {
  id: string;
  portal: "discord" | "telegram" | "slack" | "signal" | "custom";
  name: string;
  enabled: boolean;
  channelHint?: string;
  authToken?: string;
  webhookSecret?: string;
}

const MEMORY_PENDING_WRITES_SETTING = "MEMORY_PENDING_WRITES";

function targetToType(target: MemoryTarget): "long-term" | "semantic" {
  return target === "user" ? "semantic" : "long-term";
}

function targetLimit(target: MemoryTarget): number {
  const raw = target === "user" ? process.env["USER_MEMORY_CHAR_LIMIT"] : process.env["AGENT_MEMORY_CHAR_LIMIT"];
  const fallback = target === "user" ? 1375 : 2200;
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function contentSize(entries: Array<{ content: string }>): number {
  if (entries.length === 0) return 0;
  return entries.map((entry) => entry.content).join("\n§\n").length;
}

function asMemoryTarget(value: unknown): MemoryTarget {
  return String(value ?? "memory").toLowerCase() === "user" ? "user" : "memory";
}

function parseMemoryOperations(value: unknown): MemoryOperation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const action = String(record["action"] ?? "").toLowerCase();
      if (!["add", "replace", "remove"].includes(action)) return undefined;
      const op: MemoryOperation = {
        action: action as MemoryOperation["action"],
      };
      if (record["content"] !== undefined) {
        op.content = String(record["content"] ?? "").trim();
      }
      if (record["oldText"] !== undefined) {
        op.oldText = String(record["oldText"] ?? "").trim();
      }
      return op;
    })
    .filter((item): item is MemoryOperation => item !== undefined);
}

function parseJsonArray(value: string | null | undefined): unknown[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serializeSubtasks(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

function mapTask(task: Awaited<ReturnType<DatabaseService["getTask"]>>) {
  if (!task) return task;
  return {
    ...task,
    subtasks: parseJsonArray(task.subtasks as string | null | undefined),
  };
}

function mapTasks(tasks: Awaited<ReturnType<DatabaseService["listTasks"]>>) {
  return tasks.map((task) => mapTask(task));
}

function parseTaskId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const legacy = raw.match(/^task_(\d+)$/i);
  if (legacy?.[1]) {
    const parsed = Number(legacy[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeGatewayPortal(value: unknown): GatewayConfig["portal"] {
  const normalized = String(value ?? "custom").trim().toLowerCase();
  if (normalized === "discord" || normalized === "telegram" || normalized === "slack" || normalized === "signal") {
    return normalized;
  }
  return "custom";
}

function parseGatewayConfigs(rawValue: string | undefined): GatewayConfig[] {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item, index) => ({
        id: String(item["id"] ?? `gateway_${index + 1}`),
        portal: normalizeGatewayPortal(item["portal"]),
        name: String(item["name"] ?? "Messaging Gateway").trim() || "Messaging Gateway",
        enabled: item["enabled"] !== false,
        channelHint: item["channelHint"] ? String(item["channelHint"]).trim() : undefined,
        authToken: item["authToken"] ? String(item["authToken"]).trim() : undefined,
        webhookSecret: item["webhookSecret"] ? String(item["webhookSecret"]).trim() : undefined,
      }));
  } catch {
    return [];
  }
}

function resolveDiscordBotToken(config: GatewayConfig): string | undefined {
  const cfgToken = config.authToken?.trim();
  if (cfgToken) return cfgToken;
  const envToken = process.env["DISCORD_BOT_TOKEN"]?.trim();
  return envToken || undefined;
}

function isHttpUrl(value: string | undefined): boolean {
  const raw = String(value ?? "").trim();
  return /^https?:\/\//i.test(raw);
}

function gatewayConversationPrefix(config: GatewayConfig): string {
  return `[${config.portal}] ${config.name}`;
}

function buildGatewayConversationName(config: GatewayConfig, externalConversationId: string): string {
  const hint = config.channelHint?.trim() || externalConversationId.trim();
  return `${gatewayConversationPrefix(config)} · ${hint}`;
}

async function resolveGatewayConversationId(
  db: DatabaseService,
  config: GatewayConfig,
  externalConversationId: string
): Promise<number> {
  const prefix = gatewayConversationPrefix(config);
  const conversations = await db.listConversations();
  const matches = conversations.filter((conversation) =>
    conversation.name.startsWith(prefix) && conversation.name.includes(externalConversationId)
  );

  if (matches.length > 0) {
    const newest = matches.reduce((latest, current) => (current.id > latest.id ? current : latest));
    return newest.id;
  }

  const created = await db.createConversation({
    name: buildGatewayConversationName(config, externalConversationId),
  });
  return created.id;
}

async function appendGatewayOutboundMessage(
  db: DatabaseService,
  config: GatewayConfig,
  externalConversationId: string,
  content: string
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  try {
    const conversationId = await resolveGatewayConversationId(db, config, externalConversationId);
    await db.addMessage({
      conversationId,
      role: "assistant",
      content: trimmed,
      metadata: JSON.stringify({
        source: "gateway",
        type: "outbound_tool_send",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
      }),
    });
  } catch {
    // Outbound send should not fail just because conversation persistence fails.
  }
}

export function createWorkflowTools(db: DatabaseService): ToolExecutor[] {
  void db;
  const memoryTool: ToolExecutor = {
    name: "memory",
    description: "Recall and curate persistent memories (query, add, replace, remove, list)",
    definition: {
      name: "memory",
      description: "Manage persistent memory entries in the database",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["query", "query_memories", "add", "replace", "remove", "list", "list_memories", "batch", "pending_list", "approve"],
          },
          target: {
            type: "string",
            enum: ["memory", "user"],
            description: "memory=agent behavior/workflow facts, user=human profile/preferences",
          },
          type: {
            type: "string",
            enum: ["short-term", "long-term", "episodic", "semantic"],
            description: "Memory type (default: long-term)",
          },
          conversationId: { type: "number", description: "Optional conversation scope" },
          content: { type: "string", description: "Content to add or replacement content" },
          oldText: { type: "string", description: "Unique substring to replace/remove" },
          query: { type: "string", description: "Search query for query action" },
          limit: { type: "number", description: "Max records for query/list" },
          importance: { type: "number", description: "Importance for add action (1-10)" },
          operations: {
            type: "array",
            description: "Atomic batch operations. Preferred for multiple memory updates.",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["add", "replace", "remove"] },
                content: { type: "string" },
                oldText: { type: "string" },
              },
              required: ["action"],
            },
          },
          pendingId: { type: "string", description: "Pending write id for approve action" },
          approved: { type: "boolean", description: "Approve and apply a staged write" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawAction = String(input["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, MemoryAction> = {
        query_memories: "query",
        list_memories: "list",
      };
      const action = actionAliases[rawAction] ?? (rawAction as MemoryAction);
      const target = asMemoryTarget(input["target"]);
      const type = String(input["type"] ?? targetToType(target)).toLowerCase();
      const conversationIdRaw = input["conversationId"];
      const conversationId = conversationIdRaw !== undefined ? Number(conversationIdRaw) : undefined;
      const scopedConversationId = Number.isFinite(conversationId ?? Number.NaN) ? Number(conversationId) : undefined;
      const limitRaw = Number(input["limit"] ?? 10);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;
      const gateEnabled = (process.env["MEMORY_WRITE_APPROVAL"] ?? "false").toLowerCase() === "true";
      const operations = parseMemoryOperations(input["operations"]);

      const loadPendingWrites = async (): Promise<PendingMemoryWrite[]> => {
        const raw = await db.getSetting(MEMORY_PENDING_WRITES_SETTING);
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter((item) => item && typeof item === "object")
            .map((item) => item as Record<string, unknown>)
            .filter((item) => typeof item["id"] === "string" && typeof item["createdAt"] === "string")
            .map((item) => ({
              id: String(item["id"]),
              createdAt: String(item["createdAt"]),
              payload: (item["payload"] as Record<string, unknown>) ?? {},
            }));
        } catch {
          return [];
        }
      };

      const savePendingWrites = async (entries: PendingMemoryWrite[]): Promise<void> => {
        await db.setSetting(MEMORY_PENDING_WRITES_SETTING, JSON.stringify(entries));
      };

      const stageWrite = async (payload: Record<string, unknown>): Promise<ToolResult> => {
        const pending = await loadPendingWrites();
        const id = `mem_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
        pending.push({ id, createdAt: new Date().toISOString(), payload });
        await savePendingWrites(pending.slice(-200));
        return ok({ success: true, staged: true, pendingId: id, message: "Memory write staged. Approve with action=approve." });
      };

      const findMatch = (
        entries: Awaited<ReturnType<DatabaseService["getMemories"]>>,
        oldText: string
      ) => {
        const matches = entries.filter((entry) => entry.content.includes(oldText));
        if (matches.length === 0) return { error: `No memory matched '${oldText}'` };
        const unique = new Set(matches.map((entry) => entry.content));
        if (unique.size > 1) return { error: `oldText '${oldText}' matched multiple memories; be more specific` };
        const match = matches[0];
        if (!match?.id) return { error: "Matched memory has no id" };
        return { match };
      };

      const applyOperations = async (ops: MemoryOperation[]): Promise<ToolResult> => {
        if (ops.length === 0) return fail("operations is required and must include at least one valid operation");

        const current = await db.getMemories(Number.isFinite(conversationId) ? conversationId : undefined, type);
        const working: Array<{
          id: number;
          content: string;
          importance: number;
          type: string;
          conversationId: number | null;
          createdAt: string;
        }> = [...current].map((entry) => ({
          id: entry.id,
          content: entry.content,
          importance: entry.importance,
          type: entry.type,
          conversationId: entry.conversationId ?? null,
          createdAt: entry.createdAt,
        }));

        for (const op of ops) {
          if (op.action === "add") {
            if (!op.content) return fail("batch add requires content");
            working.push({
              id: -1,
              content: op.content,
              importance: 5,
              type,
              conversationId: scopedConversationId ?? null,
              createdAt: new Date().toISOString(),
            });
            continue;
          }

          if (op.action === "replace") {
            if (!op.oldText) return fail("batch replace requires oldText");
            if (!op.content) return fail("batch replace requires content");
            const matches = working.filter((entry) => entry.content.includes(op.oldText ?? ""));
            if (matches.length === 0) return fail(`batch replace: no memory matched '${op.oldText}'`);
            const unique = new Set(matches.map((entry) => entry.content));
            if (unique.size > 1) return fail(`batch replace: '${op.oldText}' matched multiple memories`);
            const idx = working.findIndex((entry) => entry.content === matches[0]?.content);
            if (idx < 0) return fail(`batch replace: failed to locate matched memory '${op.oldText}'`);
            const existing = working[idx];
            if (!existing) return fail(`batch replace: failed to locate matched memory '${op.oldText}'`);
            working[idx] = {
              ...existing,
              content: op.content,
            };
            continue;
          }

          if (op.action === "remove") {
            if (!op.oldText) return fail("batch remove requires oldText");
            const matches = working.filter((entry) => entry.content.includes(op.oldText ?? ""));
            if (matches.length === 0) return fail(`batch remove: no memory matched '${op.oldText}'`);
            const unique = new Set(matches.map((entry) => entry.content));
            if (unique.size > 1) return fail(`batch remove: '${op.oldText}' matched multiple memories`);
            const idx = working.findIndex((entry) => entry.content === matches[0]?.content);
            if (idx < 0) return fail(`batch remove: failed to locate matched memory '${op.oldText}'`);
            working.splice(idx, 1);
          }
        }

        const projected = contentSize(working.map((entry) => ({ content: entry.content })));
        const budget = targetLimit(target);
        if (projected > budget) {
          return fail(`Memory budget exceeded for target '${target}': ${projected}/${budget} chars`);
        }

        for (const op of ops) {
          if (op.action === "add") {
            const importanceRaw = Number(input["importance"] ?? 5);
            const importance = Number.isFinite(importanceRaw) ? Math.max(1, Math.min(10, Math.floor(importanceRaw))) : 5;
            await db.addMemory({
              content: String(op.content ?? ""),
              importance,
              type,
              conversationId: scopedConversationId,
            });
            continue;
          }

          const currentEntries = await db.getMemories(scopedConversationId, type);
          const oldText = String(op.oldText ?? "").trim();
          const found = findMatch(currentEntries, oldText);
          if ("error" in found) return fail(found.error ?? "Unknown memory lookup error");
          const match = found.match;
          if (!match?.id) return fail("Matched memory has no id");

          if (op.action === "replace") {
            await db.deleteMemory(match.id);
            await db.addMemory({
              content: String(op.content ?? ""),
              importance: match.importance,
              type: match.type,
              conversationId: match.conversationId ?? scopedConversationId,
            });
            continue;
          }

          if (op.action === "remove") {
            await db.deleteMemory(match.id);
          }
        }

        return ok({ success: true, applied: ops.length, usage: `${projected}/${budget}` });
      };

      try {
        if (action === "pending_list") {
          return ok(await loadPendingWrites());
        }

        if (action === "approve") {
          const pendingId = String(input["pendingId"] ?? "").trim();
          if (!pendingId) return fail("pendingId is required for approve action");
          const approved = Boolean(input["approved"] ?? true);
          const pending = await loadPendingWrites();
          const idx = pending.findIndex((entry) => entry.id === pendingId);
          if (idx < 0) return fail(`Pending write '${pendingId}' not found`);
          const selected = pending[idx];
          pending.splice(idx, 1);
          await savePendingWrites(pending);
          if (!approved) return ok({ success: true, approved: false, pendingId, discarded: true });

          const selectedAction = String(selected?.payload?.["action"] ?? "").toLowerCase();
          if (selectedAction === "batch") {
            return await applyOperations(parseMemoryOperations(selected?.payload?.["operations"]));
          }
          const singleOp: MemoryOperation = {
            action: selectedAction as MemoryOperation["action"],
            content: selected?.payload?.["content"] !== undefined ? String(selected.payload.content ?? "") : undefined,
            oldText: selected?.payload?.["oldText"] !== undefined ? String(selected.payload.oldText ?? "") : undefined,
          };
          return await applyOperations([singleOp]);
        }

        switch (action) {
          case "list": {
            const memories = await db.getMemories(Number.isFinite(conversationId) ? conversationId : undefined, type);
            const usage = contentSize(memories.map((entry) => ({ content: entry.content })));
            return ok({ entries: memories.slice(0, limit), usage: `${usage}/${targetLimit(target)}`, target, type });
          }
          case "query": {
            const query = String(input["query"] ?? "").trim().toLowerCase();
            if (!query) return fail("query is required");
            const memories = await db.getMemories(Number.isFinite(conversationId) ? conversationId : undefined, type);
            const filtered = memories.filter((entry) => entry.content.toLowerCase().includes(query)).slice(0, limit);
            return ok(filtered);
          }
          case "add": {
            const content = String(input["content"] ?? "").trim();
            if (!content) return fail("content is required");
            if (gateEnabled) {
              return await stageWrite({ action: "add", target, type, content, conversationId, importance: input["importance"] });
            }
            return await applyOperations([{ action: "add", content }]);
          }
          case "replace": {
            const oldText = String(input["oldText"] ?? "").trim();
            const content = String(input["content"] ?? "").trim();
            if (!oldText) return fail("oldText is required");
            if (!content) return fail("content is required");
            if (gateEnabled) {
              return await stageWrite({ action: "replace", target, type, oldText, content, conversationId });
            }
            return await applyOperations([{ action: "replace", oldText, content }]);
          }
          case "remove": {
            const oldText = String(input["oldText"] ?? "").trim();
            if (!oldText) return fail("oldText is required");
            if (gateEnabled) {
              return await stageWrite({ action: "remove", target, type, oldText, conversationId });
            }
            return await applyOperations([{ action: "remove", oldText }]);
          }
          case "batch": {
            if (operations.length === 0) return fail("batch requires operations[]");
            if (gateEnabled) {
              return await stageWrite({ action: "batch", target, type, operations, conversationId, importance: input["importance"] });
            }
            return await applyOperations(operations);
          }
          default:
            return fail(`Unknown memory action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const projectTool: ToolExecutor = {
    name: "project",
    description: "Create, list, inspect, update, and delete projects",
    definition: {
      name: "project",
      description: "Project management operations",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "list_projects", "list_tasks", "get", "update", "delete"],
          },
          id: { type: "number", description: "Project id" },
          name: { type: "string", description: "Project name" },
          description: { type: "string", description: "Project description" },
          folder: { type: "string", description: "Project folder path" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawAction = String(input["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        list_tasks: "list",
        list_projects: "list",
      };
      const action = actionAliases[rawAction] ?? rawAction;

      try {
        switch (action) {
          case "create": {
            const name = String(input["name"] ?? "").trim();
            if (!name) return fail("Project name is required");
            const project = await db.createProject({
              name,
              description: input["description"] ? String(input["description"]) : undefined,
              folder: input["folder"] ? String(input["folder"]) : undefined,
            });
            return ok(project);
          }
          case "list":
            return ok(await db.listProjects());
          case "get": {
            const id = Number(input["id"]);
            if (!Number.isFinite(id)) return fail("Valid project id is required");
            const project = await db.getProject(id);
            return project ? ok(project) : fail(`Project ${id} not found`);
          }
          case "update": {
            const id = Number(input["id"]);
            if (!Number.isFinite(id)) return fail("Valid project id is required");
            const project = await db.updateProject(id, {
              name: input["name"] ? String(input["name"]) : undefined,
              description: input["description"] ? String(input["description"]) : undefined,
              folder: input["folder"] ? String(input["folder"]) : undefined,
            });
            return project ? ok(project) : fail(`Project ${id} not found`);
          }
          case "delete": {
            const id = Number(input["id"]);
            if (!Number.isFinite(id)) return fail("Valid project id is required");
            await db.deleteProject(id);
            return ok({ deleted: true, id });
          }
          default:
            return fail(`Unknown project action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const taskTool: ToolExecutor = {
    name: "task",
    description: "Create, list, inspect, update, and complete tasks",
    definition: {
      name: "task",
      description: "Task lifecycle operations",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "get", "update", "start", "complete", "fail", "delete", "split"],
          },
          id: { type: "number", description: "Task id" },
          projectId: { type: "number", description: "Project id" },
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          result: { type: "string", description: "Task result or completion summary" },
          subtasks: { description: "JSON array or array of subtasks" },
          dryRun: { type: "boolean", description: "split: preview only (default true), false commits real subtask rows" },
          ownerTag: { type: "string", description: "split: ownership tag for created subtasks, defaults to task_split:<id>" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "");

      try {
        switch (action) {
          case "split": {
            const parsedId = parseTaskId(input["id"]);
            if (!Number.isFinite(parsedId)) return fail("Valid task id is required");
            const id = Number(parsedId);
            const dryRun = input["dryRun"] !== false;
            const ownerTag = String(input["ownerTag"] ?? `task_split:${id}`);

            const preview = await previewSplit(db, id);
            if (dryRun) {
              return ok({
                dryRun: true,
                parentTaskId: id,
                complexity: preview.complexity,
                subtasks: preview.subtasks,
              });
            }

            const created = await commitSplit(db, preview.parentTask, preview.subtasks, ownerTag);
            return ok({
              dryRun: false,
              parentTaskId: id,
              ownerTag,
              subtasks: mapTasks(created),
            });
          }
          case "create": {
            const title = String(input["title"] ?? "").trim();
            if (!title) return fail("Task title is required");
            const priority = String(input["priority"] ?? "medium") as TaskPriority;
            const task = await db.createTask({
              title,
              description: input["description"] ? String(input["description"]) : undefined,
              projectId: input["projectId"] !== undefined ? Number(input["projectId"]) : undefined,
              priority,
              status: "pending",
              subtasks: serializeSubtasks(input["subtasks"]),
              result: input["result"] ? String(input["result"]) : undefined,
            });
            return ok(mapTask(task));
          }
          case "list": {
            const projectId = input["projectId"] !== undefined ? Number(input["projectId"]) : undefined;
            const tasks = await db.listTasks(Number.isFinite(projectId) ? projectId : undefined);
            return ok(mapTasks(tasks));
          }
          case "get": {
            const parsedId = parseTaskId(input["id"]);
            if (!Number.isFinite(parsedId)) return fail("Valid task id is required");
            const id = Number(parsedId);
            const task = await db.getTask(id);
            return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
          }
          case "update": {
            const parsedId = parseTaskId(input["id"]);
            if (!Number.isFinite(parsedId)) return fail("Valid task id is required");
            const id = Number(parsedId);
            const task = await db.updateTask(id, {
              projectId: input["projectId"] !== undefined ? Number(input["projectId"]) : undefined,
              title: input["title"] ? String(input["title"]) : undefined,
              description: input["description"] ? String(input["description"]) : undefined,
              status: input["status"] ? (String(input["status"]) as TaskStatus) : undefined,
              priority: input["priority"] ? (String(input["priority"]) as TaskPriority) : undefined,
              subtasks: input["subtasks"] !== undefined ? serializeSubtasks(input["subtasks"]) : undefined,
              result: input["result"] ? String(input["result"]) : undefined,
            });
            return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
          }
          case "start":
          case "complete":
          case "fail": {
            const parsedId = parseTaskId(input["id"]);
            if (!Number.isFinite(parsedId)) return fail("Valid task id is required");
            const id = Number(parsedId);
            const result = input["result"] ? String(input["result"]) : undefined;
            const task = await db.updateTask(id, {
              status: action === "start" ? "running" : action === "complete" ? "completed" : "failed",
              result,
            });
            return task ? ok(mapTask(task)) : fail(`Task ${id} not found`);
          }
          case "delete": {
            const parsedId = parseTaskId(input["id"]);
            if (!Number.isFinite(parsedId)) return fail("Valid task id is required");
            const id = Number(parsedId);
            await db.deleteTask(id);
            return ok({ deleted: true, id });
          }
          default:
            return fail(`Unknown task action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const historyTool: ToolExecutor = {
    name: "history",
    description: "Search and inspect older conversations and messages",
    definition: {
      name: "history",
      description: "Conversation history search and retrieval",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "list_conversations", "get_messages", "get_conversation"],
          },
          conversationId: { type: "number", description: "Conversation id for get_messages/get_conversation" },
          query: { type: "string", description: "Search text for message content" },
          projectId: { type: "number", description: "Optional project filter for conversation listing" },
          limit: { type: "number", description: "Result limit (default: 20)" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      const limitRaw = Number(input["limit"] ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 20;

      try {
        switch (action) {
          case "list_conversations": {
            const projectIdRaw = input["projectId"];
            const projectId = projectIdRaw !== undefined ? Number(projectIdRaw) : undefined;
            const conversations = await db.listConversations(Number.isFinite(projectId) ? projectId : undefined);
            return ok(conversations.slice(0, limit));
          }
          case "get_conversation": {
            const conversationId = Number(input["conversationId"]);
            if (!Number.isFinite(conversationId)) return fail("history:get_conversation requires numeric conversationId");
            const conversation = await db.getConversation(conversationId);
            return conversation ? ok(conversation) : fail(`Conversation ${conversationId} not found`);
          }
          case "get_messages": {
            const conversationId = Number(input["conversationId"]);
            if (!Number.isFinite(conversationId)) return fail("history:get_messages requires numeric conversationId");
            const messages = await db.getMessages(conversationId);
            return ok(messages.slice(-limit));
          }
          case "search": {
            const query = String(input["query"] ?? "").trim().toLowerCase();
            if (!query) return fail("history:search requires query");

            const projectIdRaw = input["projectId"];
            const projectId = projectIdRaw !== undefined ? Number(projectIdRaw) : undefined;
            const conversations = await db.listConversations(Number.isFinite(projectId) ? projectId : undefined);

            const results: Array<{
              conversationId: number;
              conversationName: string;
              messageId: number;
              role: string;
              content: string;
              createdAt: string;
            }> = [];

            for (const conversation of conversations) {
              const messages = await db.getMessages(conversation.id);
              for (const message of messages) {
                if (!String(message.content ?? "").toLowerCase().includes(query)) continue;
                results.push({
                  conversationId: conversation.id,
                  conversationName: conversation.name,
                  messageId: message.id,
                  role: message.role,
                  content: message.content,
                  createdAt: message.createdAt,
                });
                if (results.length >= limit) {
                  return ok(results);
                }
              }
            }

            return ok(results);
          }
          default:
            return fail(`Unknown history action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const gatewayTool: ToolExecutor = {
    name: "gateway",
    description: "List gateway configs and send outbound messages via configured portals (Discord/Telegram/Webhook)",
    definition: {
      name: "gateway",
      description: "Gateway operations for outbound messaging",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_configs", "send"],
          },
          portal: {
            type: "string",
            enum: ["discord", "telegram", "slack", "signal", "custom"],
            description: "Optional portal filter",
          },
          configId: { type: "string", description: "Optional explicit gateway config id" },
          externalConversationId: { type: "string", description: "Target id (Discord channel id, Telegram chat id, etc.)" },
          channelId: { type: "string", description: "Alias for externalConversationId" },
          message: { type: "string", description: "Message content to send" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      const failWithDiagnostic = (
        error: string,
        diagnostic: Record<string, unknown>
      ): ToolResult => ({
        success: false,
        data: {
          diagnostic,
        },
        error,
      });

      try {
        const configs = parseGatewayConfigs(await db.getSetting("MESSAGING_GATEWAYS"));
        const enabled = configs.filter((cfg) => cfg.enabled);

        if (action === "list_configs") {
          return ok(
            enabled.map((cfg) => ({
              id: cfg.id,
              portal: cfg.portal,
              name: cfg.name,
              enabled: cfg.enabled,
              defaultTarget: cfg.channelHint,
              outboundReady:
                cfg.portal === "discord"
                  ? Boolean(resolveDiscordBotToken(cfg) || isHttpUrl(cfg.webhookSecret))
                  : cfg.portal === "telegram"
                    ? Boolean(cfg.authToken)
                    : Boolean(isHttpUrl(cfg.webhookSecret) || isHttpUrl(cfg.authToken)),
            }))
          );
        }

        if (action !== "send") {
          return fail(`Unknown gateway action: ${action}`);
        }

        const message = String(input["message"] ?? "").trim();
        if (!message) {
          return failWithDiagnostic("gateway:send requires field 'message'", {
            code: "missing_message",
            hint: "Provide input.message",
          });
        }

        const portalFilter = normalizeGatewayPortal(input["portal"]);
        const configId = String(input["configId"] ?? "").trim();
        const config = configId
          ? enabled.find((cfg) => cfg.id === configId)
          : enabled.find((cfg) => (input["portal"] ? cfg.portal === portalFilter : true));

        if (!config) {
          return failWithDiagnostic("No matching enabled gateway config found. Use gateway action=list_configs first.", {
            code: "config_not_found",
            requestedPortal: input["portal"] ? portalFilter : undefined,
            requestedConfigId: configId || undefined,
            enabledConfigs: enabled.map((cfg) => ({ id: cfg.id, portal: cfg.portal, name: cfg.name })),
          });
        }

        const explicitTarget = String(input["externalConversationId"] ?? input["channelId"] ?? "").trim();
        const target = explicitTarget || String(config.channelHint ?? "").trim();
        if (!target) {
          return failWithDiagnostic("No target id provided. Set externalConversationId/channelId or configure channelHint in gateway config.", {
            code: "missing_target",
            configId: config.id,
            portal: config.portal,
            defaultTarget: config.channelHint,
          });
        }

        if (config.portal === "discord") {
          const configToken = String(config.authToken ?? "").trim();
          const envToken = String(process.env["DISCORD_BOT_TOKEN"] ?? "").trim();
          const tokenSource = configToken ? "config.authToken" : envToken ? "env.DISCORD_BOT_TOKEN" : "none";
          const botToken = resolveDiscordBotToken(config);
          if (botToken) {
            const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(target)}/messages`, {
              method: "POST",
              headers: {
                Authorization: `Bot ${botToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ content: message }),
            });
            if (!response.ok) {
              return failWithDiagnostic(`Discord send failed: HTTP ${response.status}`, {
                code: "discord_http_error",
                configId: config.id,
                portal: config.portal,
                target,
                transport: "bot_api",
                tokenSource,
                status: response.status,
              });
            }
            await appendGatewayOutboundMessage(db, config, target, message);
            return ok({ sent: true, portal: config.portal, configId: config.id, target, transport: "bot_api", tokenSource });
          }

          if (isHttpUrl(config.webhookSecret)) {
            const response = await fetch(String(config.webhookSecret), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: message }),
            });
            if (!response.ok) {
              return failWithDiagnostic(`Discord webhook send failed: HTTP ${response.status}`, {
                code: "discord_webhook_http_error",
                configId: config.id,
                portal: config.portal,
                target,
                transport: "webhook",
                status: response.status,
              });
            }
            await appendGatewayOutboundMessage(db, config, target, message);
            return ok({ sent: true, portal: config.portal, configId: config.id, target, transport: "webhook" });
          }

          return failWithDiagnostic("Discord gateway requires DISCORD_BOT_TOKEN/authToken or webhookSecret webhook URL.", {
            code: "discord_transport_not_configured",
            configId: config.id,
            portal: config.portal,
            hasEnvBotToken: Boolean(process.env["DISCORD_BOT_TOKEN"]?.trim()),
            hasConfigBotToken: Boolean(config.authToken),
            hasWebhookUrl: Boolean(isHttpUrl(config.webhookSecret)),
            tokenSource,
          });
        }

        if (config.portal === "telegram") {
          const botToken = String(config.authToken ?? "").trim();
          if (!botToken) {
            return failWithDiagnostic("Telegram gateway requires authToken (bot token).", {
              code: "telegram_token_missing",
              configId: config.id,
              portal: config.portal,
            });
          }
          const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: target, text: message }),
          });
          if (!response.ok) {
            return failWithDiagnostic(`Telegram send failed: HTTP ${response.status}`, {
              code: "telegram_http_error",
              configId: config.id,
              portal: config.portal,
              target,
              status: response.status,
            });
          }
          await appendGatewayOutboundMessage(db, config, target, message);
          return ok({ sent: true, portal: config.portal, configId: config.id, target, transport: "bot_api" });
        }

        const webhook = isHttpUrl(config.webhookSecret)
          ? String(config.webhookSecret)
          : isHttpUrl(config.authToken)
            ? String(config.authToken)
            : "";

        if (!webhook) {
          return failWithDiagnostic(`Gateway portal '${config.portal}' has no outbound webhook configured.`, {
            code: "webhook_not_configured",
            configId: config.id,
            portal: config.portal,
            hasWebhookSecretUrl: Boolean(isHttpUrl(config.webhookSecret)),
            hasAuthTokenUrl: Boolean(isHttpUrl(config.authToken)),
          });
        }

        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            portal: config.portal,
            configId: config.id,
            externalConversationId: target,
            replyText: message,
          }),
        });
        if (!response.ok) {
          return failWithDiagnostic(`Webhook send failed: HTTP ${response.status}`, {
            code: "webhook_http_error",
            configId: config.id,
            portal: config.portal,
            target,
            status: response.status,
          });
        }
        await appendGatewayOutboundMessage(db, config, target, message);
        return ok({ sent: true, portal: config.portal, configId: config.id, target, transport: "webhook" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failWithDiagnostic(message, {
          code: "gateway_send_exception",
          action,
        });
      }
    },
  };

  return [browserTool, memoryTool, projectTool, taskTool, historyTool, gatewayTool];
}