import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { MultiAgentRole, WorkflowEngine, WorkflowGraph, WorkflowNode, WorkflowStatus } from "./workflow-engine.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

function newWorkflowId(): string {
  return `wf_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

function asRole(value: unknown): MultiAgentRole {
  const normalized = String(value ?? "manager").toLowerCase();
  if (["manager", "research", "coding", "review", "browser"].includes(normalized)) {
    return normalized as MultiAgentRole;
  }
  return "manager";
}

function normalizeNodes(value: unknown): WorkflowNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes: WorkflowNode[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const id = String(node["id"] ?? `node_${index + 1}`);
    const title = String(node["title"] ?? `Node ${index + 1}`);
    const prompt = String(node["prompt"] ?? "");
    const role = asRole(node["role"]);
    const dependsOn = Array.isArray(node["dependsOn"])
      ? (node["dependsOn"] as unknown[]).map((dep) => String(dep)).filter((dep) => dep.length > 0)
      : [];

    nodes.push({
      id,
      title,
      prompt,
      role,
      dependsOn,
      status: "pending",
    });
  }

  return nodes.length > 0 ? nodes : undefined;
}

function normalizeEdges(value: unknown): WorkflowGraph["edges"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const edges = value
    .map((raw, index) => {
      if (!raw || typeof raw !== "object") return undefined;
      const edge = raw as Record<string, unknown>;
      const source = String(edge["source"] ?? "").trim();
      const target = String(edge["target"] ?? "").trim();
      if (!source || !target) return undefined;
      const id = String(edge["id"] ?? `edge_${source}_${target}_${index}`);
      return { id, source, target };
    })
    .filter((edge): edge is WorkflowGraph["edges"][number] => Boolean(edge));

  return edges.length > 0 ? edges : undefined;
}

function defaultNodes(goal: string): WorkflowNode[] {
  return [
    {
      id: "node_1",
      title: "Workflow Planning",
      role: "manager",
      prompt: goal || "Create an actionable plan for this workflow.",
      status: "pending",
      dependsOn: [],
      position: { x: 120, y: 120 },
    },
  ];
}

function validateNodesAndEdges(nodes: WorkflowNode[], edges: WorkflowGraph["edges"]): string | undefined {
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id ?? "").trim();
    if (!id) return "workflow: nodes require non-empty id";
    if (ids.has(id)) return `workflow: duplicate node id '${id}'`;
    ids.add(id);

    if (String(node.title ?? "").trim().length === 0) {
      return `workflow: node '${id}' requires non-empty title`;
    }
    if (String(node.prompt ?? "").trim().length === 0) {
      return `workflow: node '${id}' requires non-empty prompt`;
    }
  }

  const dependencies = new Map<string, string[]>();
  for (const node of nodes) {
    dependencies.set(node.id, [...(node.dependsOn ?? [])]);
  }

  for (const edge of edges) {
    if (!ids.has(edge.source)) return `workflow: edge source '${edge.source}' does not exist`;
    if (!ids.has(edge.target)) return `workflow: edge target '${edge.target}' does not exist`;
    const list = dependencies.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    dependencies.set(edge.target, list);
  }

  for (const [nodeId, deps] of dependencies.entries()) {
    for (const dep of deps) {
      if (!ids.has(dep)) return `workflow: node '${nodeId}' depends on unknown node '${dep}'`;
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const hasCycle = (nodeId: string): boolean => {
    if (visited.has(nodeId)) return false;
    if (visiting.has(nodeId)) return true;
    visiting.add(nodeId);
    const deps = dependencies.get(nodeId) ?? [];
    for (const dep of deps) {
      if (hasCycle(dep)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const nodeId of ids) {
    if (hasCycle(nodeId)) return "workflow: cyclic dependencies detected";
  }

  return undefined;
}

export function createWorkflowManagementTool(workflowEngine: WorkflowEngine): ToolExecutor {
  return {
    name: "workflow",
    description: "Create, inspect, update, run, resume, list, and delete workflow graphs",
    definition: {
      name: "workflow",
      description: "Workflow graph management and execution",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "get", "create", "create_graph", "update", "run", "resume", "delete"],
          },
          id: { type: "string", description: "Workflow id" },
          name: { type: "string", description: "Workflow name" },
          goal: { type: "string", description: "Workflow goal" },
          status: {
            type: "string",
            enum: ["draft", "running", "completed", "failed"],
          },
          nodes: { type: "array", description: "Workflow nodes" },
          edges: { type: "array", description: "Workflow edges" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawAction = String(input["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        create_graph: "create",
      };
      const action = actionAliases[rawAction] ?? rawAction;

      try {
        switch (action) {
          case "list": {
            return ok(await workflowEngine.listWorkflows());
          }
          case "get": {
            const id = String(input["id"] ?? "").trim();
            if (!id) return fail("workflow:get requires field 'id'");
            const workflow = await workflowEngine.getWorkflow(id);
            if (!workflow) return fail(`Workflow '${id}' not found`);
            return ok(workflow);
          }
          case "create": {
            const name = String(input["name"] ?? "").trim();
            if (!name) return fail("workflow:create requires field 'name'");
            const id = String(input["id"] ?? "").trim() || newWorkflowId();
            const goal = String(input["goal"] ?? "").trim();
            const nodes = normalizeNodes(input["nodes"]) ?? defaultNodes(goal);
            const edges = normalizeEdges(input["edges"]) ?? [];
            const statusRaw = String(input["status"] ?? "draft").toLowerCase();
            const status: WorkflowStatus = ["draft", "running", "completed", "failed"].includes(statusRaw)
              ? (statusRaw as WorkflowStatus)
              : "draft";

            const validationError = validateNodesAndEdges(nodes, edges);
            if (validationError) return fail(validationError);

            const created = await workflowEngine.saveWorkflow({
              id,
              name,
              goal,
              status,
              nodes,
              edges,
            });
            return ok(created);
          }
          case "update": {
            const id = String(input["id"] ?? "").trim();
            if (!id) return fail("workflow:update requires field 'id'");
            const existing = await workflowEngine.getWorkflow(id);
            if (!existing) return fail(`Workflow '${id}' not found`);

            const name = String(input["name"] ?? "").trim() || existing.name;
            const goal = input["goal"] !== undefined ? String(input["goal"] ?? "") : existing.goal;
            const nodes = normalizeNodes(input["nodes"]) ?? existing.nodes;
            const edges = normalizeEdges(input["edges"]) ?? existing.edges;
            const statusRaw = String(input["status"] ?? existing.status).toLowerCase();
            const status: WorkflowStatus = ["draft", "running", "completed", "failed"].includes(statusRaw)
              ? (statusRaw as WorkflowStatus)
              : existing.status;

            const validationError = validateNodesAndEdges(nodes, edges);
            if (validationError) return fail(validationError);

            const updated = await workflowEngine.saveWorkflow({
              ...existing,
              id,
              name,
              goal,
              status,
              nodes,
              edges,
            });
            return ok(updated);
          }
          case "run": {
            const id = String(input["id"] ?? "").trim();
            if (!id) return fail("workflow:run requires field 'id'");
            return ok(await workflowEngine.runWorkflow(id));
          }
          case "resume": {
            const id = String(input["id"] ?? "").trim();
            if (!id) return fail("workflow:resume requires field 'id'");
            return ok(await workflowEngine.resumeWorkflow(id));
          }
          case "delete": {
            const id = String(input["id"] ?? "").trim();
            if (!id) return fail("workflow:delete requires field 'id'");
            await workflowEngine.deleteWorkflow(id);
            return ok({ deleted: true, id });
          }
          default:
            return fail(`Unknown workflow action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
