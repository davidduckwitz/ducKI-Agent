import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConversationManager } from "./conversation.js";
import { MemorySystem } from "./memory.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { Reasoner } from "./reasoner.js";
import { Reflection } from "./reflection.js";
import { History } from "./history.js";
import { createWorkflowTools } from "./workflow-tools.js";
import { resolveToolAlias, resolveToolAction } from "./tool-aliases.js";

export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
  enableReflection?: boolean;
  enablePlanning?: boolean;
  enableAutoMemory?: boolean;
}

export type AgentStatus = "idle" | "running" | "paused" | "error" | "stopped";

export interface AgentRunResult {
  response: string;
  iterations: number;
  toolsUsed: string[];
  conversationId?: number;
}

export type AgentRunEventType = "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";

export interface AgentRunEvent {
  type: AgentRunEventType;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface SkillManifest {
  slug: string;
  name: string;
  description?: string;
  path: string;
}

interface SkillSummary extends SkillManifest {
  content: string;
}

interface SkillScore {
  skill: SkillManifest;
  score: number;
  overlap: number;
}

interface AgentRuntimeControls {
  maxIterations: number;
  timeoutMs: number;
  enableAutoMemory: boolean;
  enableReflection: boolean;
  reflectionMaxRetries: number;
  reasonerUseToolMinConfidence: number;
  maxConsecutiveToolFailures: number;
  maxRepeatedToolCall: number;
  enableAutoSkillSelection: boolean;
  autoSkillScoreThreshold: number;
  autoSkillMarginThreshold: number;
  autoSkillMinInputLength: number;
  autoSkillMinOverlap: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are DucKI, an intelligent AI coding and task agent. You are helpful, accurate, and professional.
Use the available tools to create and manage projects and tasks, then work them through to completion.
When a request needs execution, plan first, create or update project/task records as needed, then use tools to carry out the work.
Always think step-by-step, keep state in the database, and return concise progress updates.
Use ./shared-workspace as collaborative file area for user-provided artifacts and generated deliverables.
When you want to call a tool, emit exactly [TOOL:name({json})] with valid JSON arguments.`;

export class Agent {
  readonly name: string;
  private status: AgentStatus = "idle";
  private systemPrompt: string;
  private maxIterations: number;
  private timeoutMs: number;
  private enableReflection: boolean;
  private enablePlanning: boolean;
  private enableAutoMemory: boolean;

  private conversation: ConversationManager;
  private memory: MemorySystem;
  private planner: Planner;
  readonly executor: Executor;
  private reasoner: Reasoner;
  private reflection: Reflection;
  private history: History;
  private logger: Logger;
  private skillsRoot: string;
  private stopRequested = false;
  private readonly maxConsecutiveToolFailures = parseInt(process.env["AGENT_MAX_TOOL_FAILURES"] ?? "3");
  private readonly maxRepeatedToolCall = parseInt(process.env["AGENT_MAX_REPEATED_TOOL_CALL"] ?? "3");
  private readonly enableAutoSkillSelection =
    (process.env["AGENT_AUTO_SKILL_SELECTION"] ?? "true").toLowerCase() !== "false";
  private readonly autoSkillScoreThreshold = parseFloat(process.env["AGENT_AUTO_SKILL_THRESHOLD"] ?? "0.78");
  private readonly autoSkillMarginThreshold = parseFloat(process.env["AGENT_AUTO_SKILL_MARGIN"] ?? "0.2");
  private readonly autoSkillMinInputLength = parseInt(process.env["AGENT_AUTO_SKILL_MIN_INPUT_LEN"] ?? "20");
  private readonly autoSkillMinOverlap = parseInt(process.env["AGENT_AUTO_SKILL_MIN_OVERLAP"] ?? "2");
  private autoSkillSelectionAttempts = 0;
  private autoSkillSelections = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly db: DatabaseService,
    options: AgentOptions = {}
  ) {
    this.name = options.name ?? "DucKI";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? parseInt(process.env["AGENT_MAX_ITERATIONS"] ?? "50");
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env["AGENT_TIMEOUT_MS"] ?? "300000");
    this.enableReflection = options.enableReflection ?? (process.env["AGENT_ENABLE_REFLECTION"] ?? "true").toLowerCase() !== "false";
    this.enablePlanning = options.enablePlanning ?? true;
    this.enableAutoMemory = options.enableAutoMemory ?? (process.env["AGENT_AUTO_MEMORY"] ?? "true").toLowerCase() !== "false";

    this.logger = getRootLogger().child(`Agent:${this.name}`);
    const configuredSkillsPath = process.env["SKILLS_PATH"]?.trim();
    if (configuredSkillsPath) {
      this.skillsRoot = resolve(configuredSkillsPath);
    } else {
      const monorepoCandidate = resolve(process.cwd(), "../../skills");
      const cwdLocal = resolve(process.cwd(), "skills");
      this.skillsRoot = existsSync(monorepoCandidate) ? monorepoCandidate : existsSync(cwdLocal) ? cwdLocal : cwdLocal;
    }

    this.conversation = new ConversationManager(db, this.logger);
    this.memory = new MemorySystem(db, this.logger);
    this.planner = new Planner(provider, this.logger);
    this.executor = new Executor(this.logger);
    for (const tool of createWorkflowTools(db)) {
      this.executor.registerTool(tool);
    }
    this.reasoner = new Reasoner(provider, this.logger);
    this.reflection = new Reflection(provider, this.logger);
    this.history = new History();
  }

  async startConversation(options: { name?: string; projectId?: number } = {}): Promise<number> {
    return this.conversation.start(options);
  }

  async loadConversation(id: number): Promise<void> {
    return this.conversation.load(id);
  }

  async run(
    userInput: string,
    options: { stream?: boolean; onChunk?: (chunk: string) => void; onEvent?: (event: AgentRunEvent) => void } = {}
  ): Promise<AgentRunResult> {
    if (this.status === "running") {
      throw new Error("Agent is already running");
    }

    this.stopRequested = false;
    this.status = "running";
    const toolsUsed: string[] = [];
    let iterations = 0;
    const controls = await this.loadRuntimeControls();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent timeout")), controls.timeoutMs)
    );

    try {
      const result = await Promise.race([
        this.runLoop(userInput, toolsUsed, iterations, controls, options),
        timeoutPromise,
      ]);
      this.status = this.stopRequested ? "stopped" : "idle";
      return result;
    } catch (error) {
      this.status = "error";
      throw error;
    } finally {
      this.stopRequested = false;
    }
  }

  private normalizeToolCallText(value: string): string {
    return value
      .replaceAll('<|"|>', '"')
      .replaceAll("<|'|>", "'")
      .replace(/,\s*'([A-Za-z_][A-Za-z0-9_\-]*)'\s*:/g, ",$1:")
      .replace(/,\s*"([A-Za-z_][A-Za-z0-9_\-]*)"\s*:/g, ",$1:")
      .trim();
  }

  /**
   * Strip residual LLM special tokens from the final response so raw markup
   * is never shown to the user (e.g. Hermes <|tool_call|> fragments, im_start/end, etc.)
   */
  private sanitizeFinalResponse(text: string): string {
    return text
      // Remove any <|...|> special tokens (Hermes / ChatML markers)
      .replace(/<\|[^|>]*\|>/g, "")
      // Remove orphan XML-style tool-call tags
      .replace(/<\/?tool_calls?[^>]*>/gi, "")
      .replace(/<\/?tool_call[^>]*>/gi, "")
      // Remove leading/trailing whitespace that may remain
      .trim();
  }

  private parseFrontmatter(content: string): { name?: string; description?: string } {
    if (!content.startsWith("---")) return {};
    const end = content.indexOf("\n---", 3);
    if (end < 0) return {};
    const block = content.slice(3, end).trim();
    const result: { name?: string; description?: string } = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key === "name") result.name = value;
      if (key === "description") result.description = value;
    }
    return result;
  }

  private loadSkillManifests(): SkillManifest[] {
    if (!existsSync(this.skillsRoot)) return [];
    const dirs = readdirSync(this.skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const result: SkillManifest[] = [];

    for (const entry of dirs) {
      const slug = entry.name;
      const skillPath = join(this.skillsRoot, slug, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const content = readFileSync(skillPath, "utf8");
      const fm = this.parseFrontmatter(content);
      result.push({
        slug,
        name: fm.name ?? slug,
        description: fm.description,
        path: skillPath,
      });
    }

    return result;
  }

  private loadSkillContent(manifest: SkillManifest): SkillSummary {
    const content = readFileSync(manifest.path, "utf8");
    return {
      ...manifest,
      content,
    };
  }

  private tokenizeForMatching(value: string): string[] {
    return value
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  private scoreSkillMatch(input: string, skill: SkillManifest): number {
    const inputTokens = new Set(this.tokenizeForMatching(input));
    const skillTokens = new Set(this.tokenizeForMatching(`${skill.slug} ${skill.name} ${skill.description ?? ""}`));
    if (inputTokens.size === 0 || skillTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of inputTokens) {
      if (skillTokens.has(token)) intersection++;
    }

    const union = new Set([...inputTokens, ...skillTokens]).size;
    let score = union === 0 ? 0 : intersection / union;

    const normalizedInput = input.toLowerCase();
    if (
      skill.slug === "workflow-orchestrator" &&
      /(workflow|graph|editor|node|edge|orchestr|run|resume|pipeline)/.test(normalizedInput)
    ) {
      score += 0.45;
    }

    if (/(review|analyse|analyze|bug|risk|regression)/.test(normalizedInput) && skill.slug === "code-review") {
      score += 0.35;
    }

    if (/(test|tdd|red\s*green|spec)/.test(normalizedInput) && skill.slug === "test-driven-development") {
      score += 0.35;
    }

    if (/(plan|roadmap|milestone|strategie|strategy)/.test(normalizedInput) && skill.slug === "plan") {
      score += 0.3;
    }

    return Math.min(1, score);
  }

  private tokenOverlapCount(input: string, skill: SkillManifest): number {
    const inputTokens = new Set(this.tokenizeForMatching(input));
    const skillTokens = new Set(this.tokenizeForMatching(`${skill.slug} ${skill.name} ${skill.description ?? ""}`));
    let overlap = 0;
    for (const token of inputTokens) {
      if (skillTokens.has(token)) overlap++;
    }
    return overlap;
  }

  private rankSkillMatches(input: string, installed: SkillManifest[], alreadySelectedSlugs: Set<string>): SkillScore[] {
    return installed
      .filter((skill) => !alreadySelectedSlugs.has(skill.slug))
      .map((skill) => ({
        skill,
        score: this.scoreSkillMatch(input, skill),
        overlap: this.tokenOverlapCount(input, skill),
      }))
      .sort((a, b) => b.score - a.score);
  }

  private selectAutoSkill(
    input: string,
    installed: SkillManifest[],
    alreadySelectedSlugs: Set<string>,
    controls: AgentRuntimeControls
  ): { selected?: SkillManifest; scored: SkillScore[]; reason: string } {
    if (!controls.enableAutoSkillSelection) return { scored: [], reason: "disabled" };
    if (input.trim().length < controls.autoSkillMinInputLength) return { scored: [], reason: "input_too_short" };

    const scored = this.rankSkillMatches(input, installed, alreadySelectedSlugs);
    const best = scored[0];
    const second = scored[1];

    if (!best) return { scored, reason: "no_candidates" };
    if (best.score < controls.autoSkillScoreThreshold) return { scored, reason: "below_threshold" };
    if (best.overlap < controls.autoSkillMinOverlap) return { scored, reason: "overlap_too_low" };
    if (second && best.score - second.score < controls.autoSkillMarginThreshold) {
      return { scored, reason: "ambiguous_top_match" };
    }

    return { selected: best.skill, scored, reason: "selected" };
  }

  private extractRequestedSkillSlugs(text: string): { slugs: string[]; stripped: string } {
    const tokens = text.trimStart().split(/\s+/);
    const slugs: string[] = [];
    let idx = 0;
    while (idx < tokens.length) {
      const token = tokens[idx] ?? "";
      if (!token.startsWith("/")) break;
      const slug = token.slice(1).toLowerCase().trim();
      if (!slug || !/^[a-z0-9_-]+$/.test(slug)) break;
      slugs.push(slug);
      idx++;
      if (slugs.length >= 5) break;
    }

    if (slugs.length === 0) return { slugs: [], stripped: text };
    const stripped = tokens.slice(idx).join(" ").trim();
    return { slugs, stripped: stripped.length > 0 ? stripped : text };
  }

  private resolveToolNameAndInput(
    toolName: string,
    input: Record<string, unknown>
  ): { toolName: string; input: Record<string, unknown> } {
    const normalized = toolName.trim().toLowerCase();
    const normalizedInput: Record<string, unknown> = {
      ...input,
    };

    if (normalizedInput["project_id"] !== undefined && normalizedInput["projectId"] === undefined) {
      normalizedInput["projectId"] = normalizedInput["project_id"];
    }

    if (normalizedInput["file_path"] !== undefined && normalizedInput["path"] === undefined) {
      normalizedInput["path"] = normalizedInput["file_path"];
    }

    if (normalizedInput["old_text"] !== undefined && normalizedInput["oldText"] === undefined) {
      normalizedInput["oldText"] = normalizedInput["old_text"];
    }

    if (normalizedInput["workflow_id"] !== undefined && normalizedInput["id"] === undefined) {
      normalizedInput["id"] = normalizedInput["workflow_id"];
    }

    const aliasToolName = resolveToolAlias(normalized);
    const aliasAction = resolveToolAction(aliasToolName, normalized);

    if (aliasToolName === "filesystem" && aliasAction) {
      return {
        toolName: "filesystem",
        input: {
          ...normalizedInput,
          action: aliasAction,
          path: normalizedInput["path"] ?? normalizedInput["file_path"],
        },
      };
    }

    if (normalizedInput["command"] !== undefined && normalizedInput["action"] === undefined && normalized === "skill_manage") {
      normalizedInput["action"] = normalizedInput["command"];
    }

    const filesystemAliases = new Set(["write", "read", "append", "delete", "list", "mkdir", "exists", "stat", "move", "copy"]);

    if (filesystemAliases.has(normalized)) {
      const path = normalizedInput["path"] ?? normalizedInput["file_path"];
      return {
        toolName: "filesystem",
        input: {
          ...normalizedInput,
          action: normalized,
          path,
        },
      };
    }

    if (normalized === "http_get") {
      return {
        toolName: "http",
        input: {
          ...normalizedInput,
          action: "get",
        },
      };
    }

    if (normalized === "http_post" || normalized === "http_put" || normalized === "http_patch" || normalized === "http_delete") {
      const actionAliases: Record<string, string> = {
        http_post: "post",
        http_put: "put",
        http_patch: "patch",
        http_delete: "delete",
      };
      return {
        toolName: "http",
        input: {
          ...normalizedInput,
          action: actionAliases[normalized],
        },
      };
    }

    if (normalized === "bash" || normalized === "sh" || normalized === "zsh" || normalized === "pwsh" || normalized === "powershell" || normalized === "ps") {
      return {
        toolName: "shell",
        input: normalizedInput,
      };
    }

    if (normalized === "skill" || normalized === "skills") {
      if (normalizedInput["command"] !== undefined && normalizedInput["action"] === undefined) {
        normalizedInput["action"] = normalizedInput["command"];
      }
      return {
        toolName: "skill_manage",
        input: normalizedInput,
      };
    }

    if (normalized === "chat_history" || normalized === "conversation_history" || normalized === "history_search" || normalized === "chat-history" || normalized === "conversation-history") {
      return {
        toolName: "history",
        input: normalizedInput,
      };
    }

    if (normalized === "project" && normalizedInput["action"] === undefined) {
      if (normalizedInput["id"] !== undefined) {
        normalizedInput["action"] = "get";
      } else if (normalizedInput["name"] !== undefined) {
        normalizedInput["action"] = "create";
      } else if (normalizedInput["description"] !== undefined || normalizedInput["folder"] !== undefined) {
        normalizedInput["action"] = "update";
      } else {
        normalizedInput["action"] = "list";
      }
    }

    if (normalized === "task" && normalizedInput["action"] === undefined) {
      if (normalizedInput["id"] !== undefined) {
        normalizedInput["action"] = "get";
      } else if (normalizedInput["title"] !== undefined || normalizedInput["description"] !== undefined) {
        normalizedInput["action"] = "create";
      } else if (
        normalizedInput["status"] !== undefined ||
        normalizedInput["priority"] !== undefined ||
        normalizedInput["result"] !== undefined ||
        normalizedInput["projectId"] !== undefined ||
        normalizedInput["project_id"] !== undefined ||
        normalizedInput["subtasks"] !== undefined
      ) {
        normalizedInput["action"] = "update";
      } else {
        normalizedInput["action"] = "list";
      }
    }

    if (normalized === "task" && normalizedInput["action"] !== undefined) {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        list_all: "list",
        list_tasks: "list",
        get_all: "list",
        all: "list",
      };
      if (actionAliases[rawAction]) {
        normalizedInput["action"] = actionAliases[rawAction];
      }

      const normalizedAction = String(normalizedInput["action"] ?? "").toLowerCase();
      if (normalizedAction === "get") {
        const status = String(normalizedInput["status"] ?? "").toLowerCase();
        const hasUpdateFields = ["status", "priority", "result", "subtasks", "title", "description", "projectId", "project_id"].some(
          (key) => normalizedInput[key] !== undefined
        );
        if (hasUpdateFields) {
          if (status === "completed") {
            normalizedInput["action"] = "complete";
          } else if (status === "failed") {
            normalizedInput["action"] = "fail";
          } else if (status === "running") {
            normalizedInput["action"] = "start";
          } else {
            normalizedInput["action"] = "update";
          }
        }
      }

      const legacyTaskId = String(normalizedInput["id"] ?? "").trim().match(/^task_(\d+)$/i);
      if (legacyTaskId?.[1]) {
        normalizedInput["id"] = Number(legacyTaskId[1]);
      }
    }

    if (normalized === "workflow" && normalizedInput["action"] === undefined) {
      if (normalizedInput["id"] !== undefined) {
        normalizedInput["action"] = "get";
      } else if (normalizedInput["name"] !== undefined) {
        normalizedInput["action"] = "create";
      } else {
        normalizedInput["action"] = "list";
      }
    }

    return { toolName: normalized, input: normalizedInput };
  }

  private preflightToolInput(
    toolName: string,
    input: Record<string, unknown>
  ): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
    const normalizedName = toolName.trim().toLowerCase();
    const normalizedInput: Record<string, unknown> = { ...input };

    if (!this.executor.hasTool(normalizedName)) {
      return { ok: false, error: `Unknown tool '${normalizedName}'` };
    }

    if (normalizedName === "http" && normalizedInput["action"] === undefined && normalizedInput["url"] !== undefined) {
      normalizedInput["action"] = "get";
    }

    if (normalizedName === "filesystem") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      const path = normalizedInput["path"];
      if (!action) return { ok: false, error: "filesystem: action is required" };
      if (!path || String(path).trim().length === 0) {
        return { ok: false, error: "filesystem: path is required" };
      }
      if ((action === "write" || action === "append") && typeof normalizedInput["content"] !== "string") {
        return { ok: false, error: `filesystem:${action} requires string field 'content'` };
      }
      if (action === "move" && String(normalizedInput["destination"] ?? "").trim().length === 0) {
        return { ok: false, error: "filesystem:move requires field 'destination'" };
      }
      if (normalizedInput["basePath"] !== undefined && String(normalizedInput["basePath"]).trim().length === 0) {
        return { ok: false, error: "filesystem: basePath must not be empty when provided" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "http") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "http: action is required" };
      const url = String(normalizedInput["url"] ?? "").trim();
      const baseUrl = String(normalizedInput["baseUrl"] ?? "").trim();
      const path = String(normalizedInput["path"] ?? "").trim();
      if (!url && !(baseUrl && path)) {
        return { ok: false, error: "http: provide 'url' or both 'baseUrl' and 'path'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "shell") {
      const command = normalizedInput["command"];
      if (!command || String(command).trim().length === 0) {
        return { ok: false, error: "shell: command is required" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "project") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "project: action is required" };
      if ((action === "get" || action === "update" || action === "delete") && !Number.isFinite(Number(normalizedInput["id"]))) {
        return { ok: false, error: `project:${action} requires numeric field 'id'` };
      }
      if (action === "create" && String(normalizedInput["name"] ?? "").trim().length === 0) {
        return { ok: false, error: "project:create requires field 'name'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "task") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      const legacyTaskId = String(normalizedInput["id"] ?? "").trim().match(/^task_(\d+)$/i);
      if (legacyTaskId?.[1]) {
        normalizedInput["id"] = Number(legacyTaskId[1]);
      }
      if (!action) return { ok: false, error: "task: action is required" };
      if (["get", "update", "start", "complete", "fail", "delete"].includes(action)) {
        if (!Number.isFinite(Number(normalizedInput["id"]))) {
          return { ok: false, error: `task:${action} requires numeric field 'id'` };
        }
      }
      if (action === "create" && String(normalizedInput["title"] ?? "").trim().length === 0) {
        return { ok: false, error: "task:create requires field 'title'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "skill_manage") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        edit_skill: "rename",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (normalizedInput["skillName"] !== undefined && normalizedInput["name"] === undefined) {
        normalizedInput["name"] = normalizedInput["skillName"];
      }
      if (normalizedInput["path"] !== undefined && normalizedInput["name"] === undefined) {
        const pathValue = String(normalizedInput["path"] ?? "").replaceAll("\\", "/");
        const pathMatch = pathValue.match(/(?:^|\/)skills\/([^/]+)\.md$/i);
        if (pathMatch?.[1]) {
          normalizedInput["name"] = pathMatch[1];
        }
      }
      if (normalizedInput["oldSkillName"] !== undefined && normalizedInput["old_name"] === undefined) {
        normalizedInput["old_name"] = normalizedInput["oldSkillName"];
      }
      if (normalizedInput["newSkillName"] !== undefined && normalizedInput["new_name"] === undefined) {
        normalizedInput["new_name"] = normalizedInput["newSkillName"];
      }
      if (!action) return { ok: false, error: "skill_manage: action is required" };
      if (["view", "create", "patch", "edit", "delete", "write_file", "remove_file"].includes(action)) {
        if (String(normalizedInput["name"] ?? "").trim().length === 0) {
          return { ok: false, error: `skill_manage:${action} requires field 'name'` };
        }
      }
      if (action === "rename") {
        if (String(normalizedInput["oldSkillName"] ?? normalizedInput["old_name"] ?? normalizedInput["name"] ?? "").trim().length === 0) {
          return { ok: false, error: "skill_manage:rename requires field 'oldSkillName'" };
        }
        if (String(normalizedInput["newSkillName"] ?? normalizedInput["new_name"] ?? "").trim().length === 0) {
          return { ok: false, error: "skill_manage:rename requires field 'newSkillName'" };
        }
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "memory") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        add_memory: "add",
        query_memories: "query",
        list_memories: "list",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (!action) return { ok: false, error: "memory: action is required" };
      if (!["query", "add", "replace", "remove", "list", "batch", "pending_list", "approve"].includes(action)) {
        return { ok: false, error: `memory: unknown action '${action}'` };
      }
      if (action === "query" && String(normalizedInput["query"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:query requires field 'query'" };
      }
      if (action === "add" && String(normalizedInput["content"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:add requires field 'content'" };
      }
      if (["replace", "remove"].includes(action) && String(normalizedInput["oldText"] ?? "").trim().length === 0) {
        return { ok: false, error: `memory:${action} requires field 'oldText'` };
      }
      if (action === "replace" && String(normalizedInput["content"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:replace requires field 'content'" };
      }
      if (action === "batch") {
        if (!Array.isArray(normalizedInput["operations"]) || (normalizedInput["operations"] as unknown[]).length === 0) {
          return { ok: false, error: "memory:batch requires non-empty field 'operations'" };
        }
      }
      if (action === "approve" && String(normalizedInput["pendingId"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:approve requires field 'pendingId'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "workflow") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        create_graph: "create",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (!action) return { ok: false, error: "workflow: action is required" };
      if (!["list", "get", "create", "update", "run", "resume", "delete"].includes(action)) {
        return { ok: false, error: `workflow: unknown action '${action}'` };
      }
      if (["get", "update", "run", "resume", "delete"].includes(action)) {
        if (String(normalizedInput["id"] ?? "").trim().length === 0) {
          return { ok: false, error: `workflow:${action} requires field 'id'` };
        }
      }
      if (action === "create" && String(normalizedInput["name"] ?? "").trim().length === 0) {
        return { ok: false, error: "workflow:create requires field 'name'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "history") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "history: action is required" };
      if (!["search", "list_conversations", "get_messages", "get_conversation"].includes(action)) {
        return { ok: false, error: `history: unknown action '${action}'` };
      }
      if (["get_messages", "get_conversation"].includes(action) && !Number.isFinite(Number(normalizedInput["conversationId"]))) {
        return { ok: false, error: `history:${action} requires numeric field 'conversationId'` };
      }
      if (action === "search" && String(normalizedInput["query"] ?? "").trim().length === 0) {
        return { ok: false, error: "history:search requires field 'query'" };
      }
      return { ok: true, input: normalizedInput };
    }

    return { ok: true, input: normalizedInput };
  }

  private parseHermesArgs(rawArgs: string): Record<string, unknown> | undefined {
    const source = rawArgs;
    const out: Record<string, unknown> = {};
    let i = 0;

    const decodeTokenQuotes = (value: string): string =>
      value.replaceAll('<|"|>', '"').replaceAll("<|'|>", "'");

    const skipWs = () => {
      while (i < source.length && /\s/.test(source[i] ?? "")) i++;
    };

    const readKey = (): string | undefined => {
      skipWs();
      const start = i;
      while (i < source.length && /[A-Za-z0-9_\-]/.test(source[i] ?? "")) i++;
      const key = source.slice(start, i).trim();
      return key.length > 0 ? key : undefined;
    };

    const readDelimitedValue = (delimiter: string): string | undefined => {
      if (!source.startsWith(delimiter, i)) return undefined;
      i += delimiter.length;

      let searchFrom = i;
      while (searchFrom < source.length) {
        const end = source.indexOf(delimiter, searchFrom);
        if (end < 0) return undefined;

        const remainder = source.slice(end + delimiter.length).trimStart();
        if (remainder.length === 0 || remainder.startsWith(",")) {
          const value = source.slice(i, end);
          i = end + delimiter.length;
          return decodeTokenQuotes(value);
        }

        searchFrom = end + delimiter.length;
      }

      return undefined;
    };

    const readValue = (): unknown => {
      skipWs();

      const hermesQuoted = readDelimitedValue('<|"|>');
      if (hermesQuoted !== undefined) return hermesQuoted;

      const singleQuoted = readDelimitedValue("<|'|>");
      if (singleQuoted !== undefined) return singleQuoted;

      if ((source[i] ?? "") === '"') {
        i++;
        let value = "";
        while (i < source.length) {
          const ch = source[i] ?? "";
          if (ch === '"') {
            i++;
            break;
          }
          if (ch === "\\" && i + 1 < source.length) {
            value += source[i + 1] ?? "";
            i += 2;
            continue;
          }
          value += ch;
          i++;
        }
        return decodeTokenQuotes(value);
      }

      if ((source[i] ?? "") === "'") {
        i++;
        let value = "";
        while (i < source.length) {
          const ch = source[i] ?? "";
          if (ch === "'") {
            i++;
            break;
          }
          if (ch === "\\" && i + 1 < source.length) {
            value += source[i + 1] ?? "";
            i += 2;
            continue;
          }
          value += ch;
          i++;
        }
        return decodeTokenQuotes(value);
      }

      const start = i;
      while (i < source.length && (source[i] ?? "") !== "," && (source[i] ?? "") !== "}") i++;
      const raw = source.slice(start, i).trim();
      if (raw === "true") return true;
      if (raw === "false") return false;
      if (raw === "null") return null;
      const asNum = Number(raw);
      if (!Number.isNaN(asNum) && raw.length > 0) return asNum;
      return decodeTokenQuotes(raw).replace(/[\s"']+$/g, "");
    };

    while (i < source.length) {
      skipWs();
      if (i >= source.length) break;

      const key = readKey();
      if (!key) return undefined;
      skipWs();
      if ((source[i] ?? "") !== ":") return undefined;
      i++;

      const value = readValue();
      out[key] = value;

      skipWs();
      if ((source[i] ?? "") === ",") {
        i++;
      }
    }

    return out;
  }

  private extractHermesCall(response: string): { toolName: string; args: string } | undefined {
    const marker = "<|tool_call>call:";
    const start = response.indexOf(marker);
    if (start < 0) return undefined;

    const afterStart = response.slice(start + marker.length);
    const endMarkerA = afterStart.indexOf("<|tool_call|>");
    const endMarkerB = afterStart.indexOf("<tool_call|>");
    const endCandidates = [endMarkerA, endMarkerB].filter((n) => n >= 0);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : afterStart.length;
    const callBody = afterStart.slice(0, end).trim();

    const firstBrace = callBody.indexOf("{");
    const lastBrace = callBody.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return undefined;

    const toolName = callBody.slice(0, firstBrace).trim();
    if (!toolName || !/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(toolName)) return undefined;

    const args = callBody.slice(firstBrace + 1, lastBrace);
    return { toolName, args };
  }

  private parseLooseObject(text: string): Record<string, unknown> | undefined {
    const normalized = this.normalizeToolCallText(text);
    const candidate = normalized.startsWith("{") ? normalized : `{${normalized}}`;

    // Convert loose object keys (name: "x") into JSON keys ("name": "x").
    const jsonish = candidate.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_\-]*)(\s*:)/g, '$1"$2"$3');

    try {
      const parsed = JSON.parse(jsonish) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private extractToolCall(response: string): { toolName: string; input: Record<string, unknown> } | undefined {
    const bracketMatch = response.match(/\[TOOL:([A-Za-z_][A-Za-z0-9_\-]*)\(([^]*?)\)\]/);
    if (bracketMatch) {
      const toolName = bracketMatch[1];
      const args = this.parseLooseObject(bracketMatch[2] ?? "{}");
      if (toolName && args) {
        return this.resolveToolNameAndInput(toolName, args);
      }
      return undefined;
    }

    const hermesCall = this.extractHermesCall(response);
    if (hermesCall) {
      const args = this.parseHermesArgs(hermesCall.args) ?? this.parseLooseObject(hermesCall.args);
      if (args) {
        return this.resolveToolNameAndInput(hermesCall.toolName, args);
      }
    }

    return undefined;
  }

  private buildToolCallSignature(toolName: string, input: Record<string, unknown>): string {
    const stable = JSON.stringify(input, Object.keys(input).sort());
    return `${toolName}:${stable}`;
  }

  private deriveToolRecoveryHint(toolName: string, toolInput: Record<string, unknown>, error: string): string | undefined {
    const normalizedTool = toolName.toLowerCase();
    const normalizedError = error.toLowerCase();

    if (normalizedTool === "shell") {
      if (/(grep|sed|awk|tail|head)/.test(String(toolInput["command"] ?? "")) && /(not found|konnte nicht gefunden|wurde nicht gefunden)/.test(normalizedError)) {
        return "Shell-Hinweis: Verwende auf Windows PowerShell-kompatible Kommandos oder fuehre den Befehl via bash aus. Keine Linux-Pfade wie /home/... verwenden.";
      }
      if (/(\/home\/|\/dev\/null)/.test(String(toolInput["command"] ?? ""))) {
        return "Shell-Hinweis: Linux-Pfade erkannt. Passe Pfade auf Windows an (z. B. C:/... oder relative Workspace-Pfade).";
      }
    }

    if (normalizedTool === "task" && /unknown task action/.test(normalizedError)) {
      return "Task-Hinweis: Erlaubte Aktionen sind create, list, get, update, start, complete, fail, delete.";
    }

    if (normalizedTool === "history" && /unknown history action/.test(normalizedError)) {
      return "History-Hinweis: Erlaubte Aktionen sind search, list_conversations, get_messages, get_conversation.";
    }

    if (/unknown tool/.test(normalizedError)) {
      return "Tool-Hinweis: Pruefe den Tool-Namen gegen die verfuegbaren Tools und verwende ggf. bekannte Aliases.";
    }

    return undefined;
  }

  private parseBooleanSetting(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  }

  private parseNumberSetting(raw: string | undefined, fallback: number, min: number, max?: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = Math.max(min, max !== undefined ? Math.min(max, parsed) : parsed);
    return Math.floor(bounded);
  }

  private parseFloatSetting(raw: string | undefined, fallback: number, min: number, max?: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, max !== undefined ? Math.min(max, parsed) : parsed);
  }

  private async loadRuntimeControls(): Promise<AgentRuntimeControls> {
    const defaults: AgentRuntimeControls = {
      maxIterations: this.maxIterations,
      timeoutMs: this.timeoutMs,
      enableAutoMemory: this.enableAutoMemory,
      enableReflection: this.enableReflection,
      reflectionMaxRetries: this.enableReflection ? 1 : 0,
      reasonerUseToolMinConfidence: 0.65,
      maxConsecutiveToolFailures: this.maxConsecutiveToolFailures,
      maxRepeatedToolCall: this.maxRepeatedToolCall,
      enableAutoSkillSelection: this.enableAutoSkillSelection,
      autoSkillScoreThreshold: this.autoSkillScoreThreshold,
      autoSkillMarginThreshold: this.autoSkillMarginThreshold,
      autoSkillMinInputLength: this.autoSkillMinInputLength,
      autoSkillMinOverlap: this.autoSkillMinOverlap,
    };

    try {
      const rows = await this.db.getAllSettings();
      const map = new Map(rows.map((row) => [row.key, row.value]));
      const get = (key: string): string | undefined => {
        const v = map.get(key);
        return v === null || v === undefined || String(v).trim().length === 0 ? undefined : String(v);
      };

      return {
        maxIterations: this.parseNumberSetting(get("AGENT_MAX_ITERATIONS"), defaults.maxIterations, 1, 200),
        timeoutMs: this.parseNumberSetting(get("AGENT_TIMEOUT_MS"), defaults.timeoutMs, 5000, 3_600_000),
        enableAutoMemory: this.parseBooleanSetting(get("AGENT_AUTO_MEMORY"), defaults.enableAutoMemory),
        enableReflection: this.parseBooleanSetting(get("AGENT_ENABLE_REFLECTION"), defaults.enableReflection),
        reflectionMaxRetries: this.parseNumberSetting(get("AGENT_REFLECTION_MAX_RETRIES"), defaults.reflectionMaxRetries, 0, 3),
        reasonerUseToolMinConfidence: this.parseFloatSetting(get("AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE"), defaults.reasonerUseToolMinConfidence, 0, 1),
        maxConsecutiveToolFailures: this.parseNumberSetting(get("AGENT_MAX_TOOL_FAILURES"), defaults.maxConsecutiveToolFailures, 1, 20),
        maxRepeatedToolCall: this.parseNumberSetting(get("AGENT_MAX_REPEATED_TOOL_CALL"), defaults.maxRepeatedToolCall, 1, 20),
        enableAutoSkillSelection: this.parseBooleanSetting(get("AGENT_AUTO_SKILL_SELECTION"), defaults.enableAutoSkillSelection),
        autoSkillScoreThreshold: this.parseFloatSetting(get("AGENT_AUTO_SKILL_THRESHOLD"), defaults.autoSkillScoreThreshold, 0, 1),
        autoSkillMarginThreshold: this.parseFloatSetting(get("AGENT_AUTO_SKILL_MARGIN"), defaults.autoSkillMarginThreshold, 0, 1),
        autoSkillMinInputLength: this.parseNumberSetting(get("AGENT_AUTO_SKILL_MIN_INPUT_LEN"), defaults.autoSkillMinInputLength, 1, 2000),
        autoSkillMinOverlap: this.parseNumberSetting(get("AGENT_AUTO_SKILL_MIN_OVERLAP"), defaults.autoSkillMinOverlap, 0, 20),
      };
    } catch {
      return defaults;
    }
  }

  private async runLoop(
    userInput: string,
    toolsUsed: string[],
    iterations: number,
    controls: AgentRuntimeControls,
    options: { stream?: boolean; onChunk?: (chunk: string) => void; onEvent?: (event: AgentRunEvent) => void }
  ): Promise<AgentRunResult> {
    const emit = (
      type: AgentRunEventType,
      message: string,
      data?: Record<string, unknown>
    ) => {
      const timestamp = new Date().toISOString();
      options.onEvent?.({ type, message, data, timestamp });

      // Persist event timeline so reloaded chats can render tool/reasoning history.
      if (this.conversation.id !== undefined) {
        void this.db
          .addMessage({
            conversationId: this.conversation.id,
            role: "event",
            content: message,
            toolResult: JSON.stringify({ eventType: type, data, timestamp }),
          })
          .catch(() => {
            // Ignore event persistence errors to avoid interrupting the run loop.
          });
      }
    };

    const rememberSuccessfulTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolResult: ToolResult
    ): Promise<void> => {
      if (!controls.enableAutoMemory) return;
      if (!toolResult.success) return;

      try {
        const decision = await this.memory.rememberFromSuccessfulTool(
          toolName,
          toolInput,
          toolResult.data,
          this.conversation.id
        );

        if (decision.stored) {
          emit("reasoning", "Memory aktualisiert aus erfolgreichem Tool-Erfolg.", {
            source: "tool_success",
            toolName,
            reason: decision.reason,
            importance: decision.importance,
            contentPreview: decision.content?.slice(0, 200),
          });
          return;
        }

        if (decision.shouldRemember) {
          emit("reasoning", "Memory-Eintrag verworfen (bereits bekannt).", {
            source: "tool_success",
            toolName,
            reason: decision.reason,
            contentPreview: decision.content?.slice(0, 200),
          });
        }
      } catch (error) {
        this.logger.warn("Automatic tool memory update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const installedSkillManifests = this.loadSkillManifests();
    const { slugs: requestedSkillSlugs, stripped: effectiveInput } = this.extractRequestedSkillSlugs(userInput);
    const requestedSkills = requestedSkillSlugs
      .map((slug) => installedSkillManifests.find((skill) => skill.slug === slug))
      .filter((skill): skill is SkillManifest => Boolean(skill));

    const workflowOrchestratorRequested = requestedSkillSlugs.includes("workflow-orchestrator");
    const prioritizedRequestedSkillManifests = workflowOrchestratorRequested
      ? [
          ...requestedSkills.filter((skill) => skill.slug === "workflow-orchestrator"),
          ...requestedSkills.filter((skill) => skill.slug !== "workflow-orchestrator"),
        ]
      : requestedSkills;

    const selectedSlugs = new Set(prioritizedRequestedSkillManifests.map((skill) => skill.slug));
    const autoSkillSelection = this.selectAutoSkill(effectiveInput, installedSkillManifests, selectedSlugs, controls);
    const autoSkill = autoSkillSelection.selected;
    this.autoSkillSelectionAttempts++;
    if (autoSkill) this.autoSkillSelections++;
    const activeSkillManifests = autoSkill
      ? [...prioritizedRequestedSkillManifests, autoSkill]
      : prioritizedRequestedSkillManifests;
    const activeSkills = activeSkillManifests.map((skill) => this.loadSkillContent(skill));
    const activeSkillSlugs = activeSkills.map((skill) => skill.slug);
    const workflowOrchestratorActive = activeSkillSlugs.includes("workflow-orchestrator");

    if (activeSkills.length > 0) {
      emit(
        "reasoning",
        `Skills geladen: ${activeSkills.map((s) => s.slug).join(", ")}`,
        { skills: activeSkills.map((s) => ({ slug: s.slug, name: s.name })) }
      );
    }

    if (autoSkill) {
      emit("decision", "Skill auto-selected after relevance check", {
        skill: autoSkill.slug,
        threshold: controls.autoSkillScoreThreshold,
        marginThreshold: controls.autoSkillMarginThreshold,
        minOverlap: controls.autoSkillMinOverlap,
      });
    } else if (autoSkillSelection.reason !== "disabled") {
      emit("decision", "No auto skill selected", {
        reason: autoSkillSelection.reason,
        threshold: controls.autoSkillScoreThreshold,
        marginThreshold: controls.autoSkillMarginThreshold,
        minOverlap: controls.autoSkillMinOverlap,
      });
    }

    if (autoSkillSelection.scored.length > 0) {
      emit("decision", "Skill relevance ranking", {
        top: autoSkillSelection.scored.slice(0, 3).map((item) => ({
          slug: item.skill.slug,
          score: Number(item.score.toFixed(3)),
          overlap: item.overlap,
        })),
      });
      const hitRate = this.autoSkillSelectionAttempts > 0
        ? this.autoSkillSelections / this.autoSkillSelectionAttempts
        : 0;
      emit("decision", "Auto skill hit rate", {
        attempts: this.autoSkillSelectionAttempts,
        selected: this.autoSkillSelections,
        hitRate: Number(hitRate.toFixed(3)),
      });
    }

    if (workflowOrchestratorActive && activeSkills.length > 1) {
      emit("guardrail", "Skill priority applied", {
        prioritized: "workflow-orchestrator",
        alsoLoaded: activeSkills.filter((s) => s.slug !== "workflow-orchestrator").map((s) => s.slug),
      });
    }

    // Add user message
    const userMessage: LLMMessage = { role: "user", content: effectiveInput };
    await this.conversation.addMessage(userMessage);
    this.history.add(userMessage);

    const memoryContext = await this.memory.buildSystemContext(this.conversation.id);
    const availableTools = this.executor.listTools();
    const toolContext = availableTools.length > 0
      ? `\n\n## Available Tools\n${availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`
      : "";
    const planContext = this.enablePlanning
      ? await this.planner.createPlan(effectiveInput, availableTools.map((tool) => tool.name))
      : undefined;
    if (planContext) {
      emit("plan", `Plan erstellt mit ${planContext.steps.length} Schritt(en).`, {
        complexity: planContext.estimatedComplexity,
        steps: planContext.steps.map((step) => ({ id: step.id, title: step.title })),
      });
    }
    const installedSkillsContext = installedSkillManifests.length > 0
      ? `\n\n## Installed Skills\n${installedSkillManifests
          .map((skill) => `- ${skill.slug}: ${skill.description ?? "No description"}`)
          .join("\n")}`
      : "";

    const requestedSkillsContext = activeSkills.length > 0
      ? `\n\n## Loaded Skills\n${activeSkills
          .map((skill) => `### ${skill.slug}\n${skill.content}`)
          .join("\n\n")}`
      : "";

    const baseSystemPrompt =
      this.systemPrompt +
      installedSkillsContext +
      requestedSkillsContext +
      toolContext +
      (planContext ? `\n\n## Working Plan\n${JSON.stringify(planContext, null, 2)}` : "") +
      memoryContext +
      "\n\n## Task Rules\n- Create a project before creating project-specific tasks when the work should be tracked long-term.\n- Mark a task running before execution and completed or failed when finished.\n- Persist results in the database so the UI can show progress.\n- Use tools whenever state must change.\n- Never repeat the exact same tool call more than once without changing input or strategy.\n- If a tool fails, correct parameters based on the error before retrying.\n- If /workflow-orchestrator is loaded, first drive the workflow lifecycle (list/get/create/update/run/resume) before unrelated tools.\n- For stable user or workflow facts, use memory tool actions to recall or curate durable memory.";

    let finalResponse = "";
    let consecutiveToolFailures = 0;
    const repeatedToolCalls = new Map<string, number>();

    while (iterations < controls.maxIterations) {
      if (this.stopRequested) {
        emit("reasoning", "Run wurde vom Benutzer gestoppt.");
        break;
      }

      iterations++;
      this.logger.debug("Agent iteration", { iteration: iterations });
      emit("iteration", `Iteration ${iterations}`);

      const dynamicMemorySignals = [
        effectiveInput,
        ...activeSkillSlugs,
        ...toolsUsed.slice(-3),
      ];
      const dynamicMemoryContext = await this.memory.buildDynamicContext(dynamicMemorySignals, this.conversation.id, 5);
      if (dynamicMemoryContext) {
        emit("reasoning", "Memory-Kontext abgerufen.", {
          signals: dynamicMemorySignals.slice(0, 5),
        });
      }

      const systemMessage: LLMMessage = {
        role: "system",
        content: `${baseSystemPrompt}${dynamicMemoryContext}`,
      };

      const messages: LLMMessage[] = [systemMessage, ...this.conversation.getMessages()];

      // Generate response
      let response: string;
      if (options.stream && this.provider.supportsStreaming()) {
        // Buffer stream internally so tool-call markup is not forwarded to the UI.
        const result = await this.provider.generateStream(messages, {});
        response = result.content;
      } else {
        const result = await this.provider.generate(messages);
        response = result.content;
      }

      finalResponse = response;

      emit("decision", "LLM response received", {
        iteration: iterations,
        responseLength: response.length,
        hasToolCallMarker: /\[TOOL:/.test(response) || response.includes("<|tool_call>call:"),
      });

      // Add assistant message
      const assistantMessage: LLMMessage = { role: "assistant", content: response };
      await this.conversation.addMessage(assistantMessage);
      this.history.add(assistantMessage);

      let parsedToolCall = this.extractToolCall(response);
      if (!parsedToolCall) {
        const reasoning = await this.reasoner.reason(
          [...messages, assistantMessage],
          availableTools.map((tool) => tool.name),
          `User request: ${effectiveInput}`
        );
        emit("reasoning", "Reasoner decision", {
          action: reasoning.action,
          confidence: reasoning.confidence,
          toolName: reasoning.toolName,
          thinking: reasoning.thinking.slice(0, 240),
        });

        if (
          reasoning.action === "use_tool" &&
          reasoning.toolName &&
          reasoning.toolInput &&
          reasoning.confidence >= controls.reasonerUseToolMinConfidence
        ) {
          parsedToolCall = this.resolveToolNameAndInput(reasoning.toolName, reasoning.toolInput);
          emit("decision", "Reasoner proposed tool execution", {
            toolName: parsedToolCall.toolName,
            confidence: reasoning.confidence,
            threshold: controls.reasonerUseToolMinConfidence,
          });
        } else if (
          (reasoning.action === "respond" || reasoning.action === "ask_clarification") &&
          reasoning.response?.trim() &&
          reasoning.confidence >= controls.reasonerUseToolMinConfidence
        ) {
          finalResponse = reasoning.response;
          if (options.stream && options.onChunk && finalResponse.length > 0) {
            options.onChunk(finalResponse);
          }
          emit("reasoning", "Reasoner provided direct response", {
            action: reasoning.action,
            confidence: reasoning.confidence,
            threshold: controls.reasonerUseToolMinConfidence,
          });
          break;
        }
      }

      if (!parsedToolCall) {
        emit("reasoning", "Antwort generiert", {
          preview: response.slice(0, 280),
        });
        if (options.stream && options.onChunk && response.length > 0) {
          options.onChunk(response);
        }
        break; // No tool calls, we're done
      }

      if (workflowOrchestratorRequested && iterations <= 2 && parsedToolCall.toolName !== "workflow") {
        const enforcedResult: ToolResult = {
          success: false,
          data: null,
          error:
            "Policy violation: with /workflow-orchestrator, start by using workflow actions (list/get/create/update/run/resume) before unrelated tools.",
        };
        emit("guardrail", "Workflow policy enforced", {
          expectedTool: "workflow",
          attemptedTool: parsedToolCall.toolName,
          iteration: iterations,
        });

        const toolResultMessage: LLMMessage = {
          role: "tool",
          content: JSON.stringify(enforcedResult),
          toolCallId: `call_${iterations}`,
        };
        await this.conversation.addMessage(toolResultMessage);
        this.history.add(toolResultMessage, parsedToolCall.toolName);
        consecutiveToolFailures++;
        continue;
      }

      const signature = this.buildToolCallSignature(parsedToolCall.toolName, parsedToolCall.input);
      const seen = (repeatedToolCalls.get(signature) ?? 0) + 1;
      repeatedToolCalls.set(signature, seen);
      if (seen > controls.maxRepeatedToolCall) {
        emit("guardrail", "Repeated tool call blocked", {
          toolName: parsedToolCall.toolName,
          repetition: seen,
          max: controls.maxRepeatedToolCall,
        });
        finalResponse =
          "Ich stoppe hier, weil derselbe Tool-Aufruf mehrfach wiederholt wurde. Ich kann den Ablauf jetzt mit angepassten Parametern fortsetzen, wenn du kurz bestätigst, welche Variante gewuenscht ist.";
        break;
      }

      emit("tool_call", `Tool-Aufruf: ${parsedToolCall.toolName}`, {
        toolName: parsedToolCall.toolName,
        input: parsedToolCall.input,
      });

      try {
        const preflight = this.preflightToolInput(parsedToolCall.toolName, parsedToolCall.input);
        const toolResult = preflight.ok
          ? await this.executor.execute(parsedToolCall.toolName, preflight.input)
          : { success: false, data: null, error: preflight.error };
        toolsUsed.push(parsedToolCall.toolName);
        emit("tool_result", `Tool-Ergebnis: ${parsedToolCall.toolName}`, {
          toolName: parsedToolCall.toolName,
          success: toolResult.success,
          error: toolResult.error,
        });

        const toolResultMessage: LLMMessage = {
          role: "tool",
          content: JSON.stringify(toolResult),
          toolCallId: `call_${iterations}`,
        };
        await this.conversation.addMessage(toolResultMessage);
        this.history.add(toolResultMessage, parsedToolCall.toolName);
        await rememberSuccessfulTool(parsedToolCall.toolName, parsedToolCall.input, toolResult);
        if (toolResult.success) {
          consecutiveToolFailures = 0;
        } else {
          consecutiveToolFailures++;
          const recoveryHint = this.deriveToolRecoveryHint(
            parsedToolCall.toolName,
            parsedToolCall.input,
            String(toolResult.error ?? "")
          );
          if (recoveryHint) {
            const hintMessage: LLMMessage = {
              role: "system",
              content: recoveryHint,
            };
            await this.conversation.addMessage(hintMessage);
            this.history.add(hintMessage);
            emit("decision", "Self-repair hint injected", {
              toolName: parsedToolCall.toolName,
              hint: recoveryHint,
            });
          }
          emit("decision", "Tool execution failed", {
            toolName: parsedToolCall.toolName,
            consecutiveToolFailures,
            maxConsecutiveToolFailures: controls.maxConsecutiveToolFailures,
          });
          if (consecutiveToolFailures >= controls.maxConsecutiveToolFailures) {
            emit("guardrail", "Stopping after repeated tool failures", {
              consecutiveToolFailures,
              maxConsecutiveToolFailures: controls.maxConsecutiveToolFailures,
            });
            finalResponse =
              "Ich habe die Ausfuehrung gestoppt, weil mehrere Tool-Fehler hintereinander aufgetreten sind. Ich kann als naechstes eine gezielte Fehlerbehebung starten.";
            break;
          }
        }
      } catch {
        emit("tool_result", `Tool fehlgeschlagen: ${parsedToolCall.toolName}`, {
          toolName: parsedToolCall.toolName,
          success: false,
        });
        break;
      }

      if (this.stopRequested) {
        emit("reasoning", "Tool-Ausführung abgeschlossen, Stop-Anfrage berücksichtigt.");
        break;
      }
    }

    if (controls.enableReflection && controls.reflectionMaxRetries > 0 && finalResponse.trim().length > 0) {
      for (let reflectionAttempt = 1; reflectionAttempt <= controls.reflectionMaxRetries; reflectionAttempt++) {
        const reflectionResult = await this.reflection.evaluate(
          effectiveInput,
          this.sanitizeFinalResponse(finalResponse),
          `toolsUsed=${toolsUsed.join(",")}; iterations=${iterations}`
        );

        emit("decision", "Reflection evaluation complete", {
          attempt: reflectionAttempt,
          quality: reflectionResult.quality,
          shouldRetry: reflectionResult.shouldRetry,
          issues: reflectionResult.issues.slice(0, 3),
        });

        if (!reflectionResult.shouldRetry) break;

        const improved = reflectionResult.improvedResponse?.trim();
        if (!improved || improved === finalResponse.trim()) {
          emit("guardrail", "Reflection retry skipped", {
            reason: !improved ? "no_improved_response" : "same_response",
            attempt: reflectionAttempt,
          });
          break;
        }

        finalResponse = improved;
      }
    }

    // Add to memory
    await this.memory.addShortTerm(
      `User: ${userInput.slice(0, 100)} | Agent: ${finalResponse.slice(0, 100)}`,
      2,
      this.conversation.id
    );

    return {
      response: this.sanitizeFinalResponse(finalResponse),
      iterations,
      toolsUsed,
      conversationId: this.conversation.id,
    };
  }

  stop(): void {
    if (this.status === "running") {
      this.stopRequested = true;
      this.logger.info("Agent stop requested");
      return;
    }
    this.status = "stopped";
    this.logger.info("Agent stopped");
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getHistory(): History {
    return this.history;
  }
}
