import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import type { Executor } from "../executor/executor.js";
import type { CodingAgent } from "../coding/coding-agent.js";

export type MultiAgentRole = "manager" | "research" | "coding" | "review" | "browser";
export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed";
export type WorkflowStatus = "draft" | "running" | "completed" | "failed";
export type WorkflowNodeKind = "agent" | "tool_call";

export interface WorkflowNode {
  id: string;
  title: string;
  kind?: WorkflowNodeKind; // defaults to "agent" when absent (back-compat with saved graphs)
  role: MultiAgentRole; // ignored for tool_call nodes
  prompt: string; // ignored for tool_call nodes
  toolName?: string; // required when kind === "tool_call"
  toolInput?: Record<string, unknown>; // raw values, may contain "{{nodeId.result}}" tokens
  resultData?: unknown; // structured ToolResult.data, tool_call nodes only
  dependsOn?: string[];
  status: WorkflowNodeStatus;
  result?: string;
  taskId?: number;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowGraph {
  id: string;
  name: string;
  goal: string;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface WorkflowRunSummary {
  workflowId: string;
  status: WorkflowStatus;
  completedNodes: number;
  failedNodes: number;
  updatedAt: string;
}

const WORKFLOW_PREFIX = "workflow.graph.";

const ROLE_PROMPTS: Record<MultiAgentRole, string> = {
  manager:
    "You are the manager agent. Break goals down, prioritize, and provide clear execution instructions and acceptance criteria.",
  research:
    "You are the research agent. Gather evidence, compare options, identify risks, and produce concise technical findings.",
  coding:
    "You are the coding agent. Produce implementation-level plans and concrete code-oriented outcomes.",
  review:
    "You are the review agent. Validate quality, correctness, edge cases, and regression risks.",
  browser:
    "You are the browser agent. Focus on interaction flows, UI behavior, and externally verifiable outcomes.",
};

function nowIso(): string {
  return new Date().toISOString();
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeWorkflow(input: Partial<WorkflowGraph> & Pick<WorkflowGraph, "id" | "name">): WorkflowGraph {
  const createdAt = input.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const edges = input.edges ?? [];

  const inferredDepends = new Map<string, string[]>();
  for (const edge of edges) {
    if (!inferredDepends.has(edge.target)) inferredDepends.set(edge.target, []);
    inferredDepends.get(edge.target)?.push(edge.source);
  }

  const nodes = (input.nodes ?? []).map((node, index) => ({
    id: node.id,
    title: node.title,
    kind: node.kind ?? "agent",
    role: node.role,
    prompt: node.prompt,
    toolName: node.toolName,
    toolInput: node.toolInput,
    resultData: node.resultData,
    dependsOn: uniq(node.dependsOn ?? inferredDepends.get(node.id) ?? []),
    status: node.status ?? "pending",
    result: node.result,
    taskId: node.taskId,
    position: node.position ?? { x: 80 + index * 260, y: 120 },
  }));

  return {
    id: input.id,
    name: input.name,
    goal: input.goal ?? "",
    status: input.status ?? "draft",
    nodes,
    edges,
    createdAt,
    updatedAt,
    lastRunAt: input.lastRunAt,
  };
}

export interface WorkflowEngineOptions {
  logger?: Logger;
  codingAgentFactory?: () => CodingAgent;
}

export class WorkflowEngine {
  private logger: Logger;
  private codingAgentFactory?: () => CodingAgent;

  constructor(
    private readonly provider: LLMProvider,
    private readonly db: DatabaseService,
    private readonly executor?: Executor,
    options?: WorkflowEngineOptions
  ) {
    this.logger = options?.logger ?? getRootLogger().child("WorkflowEngine");
    this.codingAgentFactory = options?.codingAgentFactory;
  }

  private settingKey(id: string): string {
    return `${WORKFLOW_PREFIX}${id}`;
  }

  async listWorkflows(): Promise<WorkflowGraph[]> {
    const settings = await this.db.getAllSettings();
    return settings
      .filter((entry) => entry.key.startsWith(WORKFLOW_PREFIX))
      .map((entry) => {
        try {
          const parsed = JSON.parse(entry.value) as WorkflowGraph;
          return normalizeWorkflow(parsed);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is WorkflowGraph => Boolean(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWorkflow(id: string): Promise<WorkflowGraph | undefined> {
    const value = await this.db.getSetting(this.settingKey(id));
    if (!value) return undefined;
    try {
      return normalizeWorkflow(JSON.parse(value) as WorkflowGraph);
    } catch {
      return undefined;
    }
  }

  async saveWorkflow(input: Partial<WorkflowGraph> & Pick<WorkflowGraph, "id" | "name">): Promise<WorkflowGraph> {
    const existing = await this.getWorkflow(input.id);
    const workflow = normalizeWorkflow({
      ...existing,
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt,
    });
    await this.db.setSetting(this.settingKey(workflow.id), JSON.stringify(workflow));
    return workflow;
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.db.deleteSetting(this.settingKey(id));
  }

  private pickNextNode(workflow: WorkflowGraph): WorkflowNode | undefined {
    return workflow.nodes.find((node) => {
      if (node.status !== "pending") return false;
      const deps = node.dependsOn ?? [];
      return deps.every((depId) => {
        const dep = workflow.nodes.find((n) => n.id === depId);
        return dep?.status === "completed";
      });
    });
  }

  private pickNextNodeBatch(workflow: WorkflowGraph): WorkflowNode[] {
    const batch: WorkflowNode[] = [];
    const processed = new Set<string>();

    for (const node of workflow.nodes) {
      if (processed.has(node.id)) continue;
      if (node.status !== "pending") continue;

      const deps = node.dependsOn ?? [];
      if (!deps.every((depId) => {
        const dep = workflow.nodes.find((n) => n.id === depId);
        return dep?.status === "completed";
      })) {
        continue;
      }

      batch.push(node);
      processed.add(node.id);

      // Stop if we've found enough nodes to parallelize
      if (batch.length >= 4) break;
    }

    return batch;
  }

  private buildRoleSystemPrompt(role: MultiAgentRole): string {
    const tools = this.executor?.listTools() ?? [];
    const toolContext = tools.length
      ? `\nAvailable tools:\n${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`
      : "";
    return `${ROLE_PROMPTS[role]}${toolContext}\nReturn a concise but concrete output.`;
  }

  /**
   * Substitutes "{{nodeId.result}}" tokens in a tool_call node's toolInput with
   * the referenced node's output. A string that is *exactly* one token yields
   * the typed resultData (falling back to the text result); a string that
   * merely contains the token gets it interpolated as text. Recurses into
   * nested objects/arrays so structured parameters can reference prior nodes.
   */
  private resolveTemplateTokens(value: unknown, workflow: WorkflowGraph): unknown {
    if (typeof value === "string") {
      const exactMatch = value.trim().match(/^\{\{\s*([A-Za-z0-9_-]+)\.result\s*\}\}$/);
      if (exactMatch) {
        const targetId = exactMatch[1];
        const target = workflow.nodes.find((n) => n.id === targetId);
        return target ? target.resultData ?? target.result : undefined;
      }
      return value.replace(/\{\{\s*([A-Za-z0-9_-]+)\.result\s*\}\}/g, (_match, targetId: string) => {
        const target = workflow.nodes.find((n) => n.id === targetId);
        return target ? String(target.result ?? "") : "";
      });
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveTemplateTokens(item, workflow));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.resolveTemplateTokens(val, workflow);
      }
      return result;
    }
    return value;
  }

  private async executeToolCallNode(
    workflow: WorkflowGraph,
    node: WorkflowNode
  ): Promise<{ resultText: string; resultData?: unknown; success: boolean }> {
    if (!this.executor) {
      return { resultText: "WorkflowEngine has no Executor configured for tool_call nodes", success: false };
    }
    if (!node.toolName) {
      return { resultText: "tool_call node is missing 'toolName'", success: false };
    }

    const resolvedInput = this.resolveTemplateTokens(node.toolInput ?? {}, workflow) as Record<string, unknown>;
    const result = await this.executor.execute(node.toolName, resolvedInput);

    if (result.success) {
      return { resultText: JSON.stringify(result.data ?? null), resultData: result.data, success: true };
    }
    return { resultText: result.error ?? "Tool call failed", success: false };
  }

  private async executeNode(workflow: WorkflowGraph, node: WorkflowNode): Promise<void> {
    node.status = "running";
    workflow.status = "running";
    workflow.lastRunAt = nowIso();
    workflow.updatedAt = nowIso();
    await this.saveWorkflow(workflow);

    const dbTask = await this.db.createTask({
      title: `[${workflow.name}] ${node.title}`,
      description: node.prompt || `Tool call: ${node.toolName ?? "unknown"}`,
      projectId: undefined,
      priority: "medium",
      status: "running",
      subtasks: undefined,
      result: undefined,
    });
    node.taskId = dbTask.id;
    await this.saveWorkflow(workflow);

    try {
      const kind = node.kind ?? "agent";

      if (kind === "tool_call") {
        const outcome = await this.executeToolCallNode(workflow, node);
        if (!outcome.success) {
          throw new Error(outcome.resultText);
        }
        node.result = outcome.resultText;
        node.resultData = outcome.resultData;
        node.status = "completed";
        await this.db.updateTask(dbTask.id, {
          status: "completed",
          result: outcome.resultText,
        });
        return;
      }

      const previousResults = workflow.nodes
        .filter((n) => n.id !== node.id && n.result)
        .map((n) => `- ${n.title}: ${n.result}`)
        .join("\n");

      let responseContent: string;
      if (node.role === "coding" && this.codingAgentFactory) {
        const codingAgent = this.codingAgentFactory();
        const runResult = await codingAgent.run(node.prompt);
        if (!runResult.success) {
          throw new Error(runResult.summary || "CodingAgent run did not succeed");
        }
        responseContent = runResult.summary;
      } else {
        const response = await this.provider.generate([
          { role: "system", content: this.buildRoleSystemPrompt(node.role) },
          {
            role: "user",
            content: [
              `Workflow Goal: ${workflow.goal || workflow.name}`,
              `Current Node: ${node.title}`,
              `Node Prompt: ${node.prompt}`,
              previousResults ? `Previous Results:\n${previousResults}` : "Previous Results: none",
            ].join("\n\n"),
          },
        ]);
        responseContent = response.content;
      }

      node.result = responseContent;
      node.status = "completed";
      await this.db.updateTask(dbTask.id, {
        status: "completed",
        result: responseContent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      node.result = message;
      node.status = "failed";
      await this.db.updateTask(dbTask.id, {
        status: "failed",
        result: message,
      });
      throw error;
    } finally {
      workflow.updatedAt = nowIso();
      await this.saveWorkflow(workflow);
    }
  }

  private async runInternal(id: string, resume: boolean): Promise<WorkflowRunSummary> {
    const workflow = await this.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow ${id} not found`);

    if (!resume) {
      workflow.nodes = workflow.nodes.map((node) => ({
        ...node,
        status: "pending",
        result: undefined,
      }));
      workflow.status = "draft";
      workflow.updatedAt = nowIso();
      await this.saveWorkflow(workflow);
    }

    this.logger.info("Workflow execution started", { id, resume, nodes: workflow.nodes.length });

    let safety = workflow.nodes.length + 5;
    while (safety > 0) {
      safety--;
      const batch = this.pickNextNodeBatch(workflow);
      if (batch.length === 0) break;

      if (batch.length === 1) {
        const node = batch[0];
        if (node) {
          await this.executeNode(workflow, node);
        }
      } else {
        // Execute multiple independent nodes in parallel
        this.logger.debug("Executing workflow nodes in parallel", { count: batch.length });
        await Promise.allSettled(batch.map((node) => {
          if (node) {
            return this.executeNode(workflow, node);
          }
          return Promise.resolve();
        }));
      }

      const failed = workflow.nodes.some((node) => node.status === "failed");
      if (failed) break;
    }

    const failedNodes = workflow.nodes.filter((node) => node.status === "failed").length;
    const completedNodes = workflow.nodes.filter((node) => node.status === "completed").length;

    workflow.status = failedNodes > 0 ? "failed" : completedNodes === workflow.nodes.length ? "completed" : "running";
    workflow.updatedAt = nowIso();
    await this.saveWorkflow(workflow);

    return {
      workflowId: workflow.id,
      status: workflow.status,
      completedNodes,
      failedNodes,
      updatedAt: workflow.updatedAt,
    };
  }

  async runWorkflow(id: string): Promise<WorkflowRunSummary> {
    return this.runInternal(id, false);
  }

  async resumeWorkflow(id: string): Promise<WorkflowRunSummary> {
    return this.runInternal(id, true);
  }
}