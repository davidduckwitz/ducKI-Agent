import { useMemo, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Play, RotateCcw, Save, Trash2, Link2, Zap, Wrench, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

type Role = "manager" | "research" | "coding" | "review" | "browser";
type NodeStatus = "pending" | "running" | "completed" | "failed";
type NodeKind = "agent" | "tool_call";

type WorkflowNode = {
  id: string;
  title: string;
  kind?: NodeKind;
  role: Role;
  prompt: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  resultData?: unknown;
  status: NodeStatus;
  dependsOn?: string[];
  result?: string;
  position?: { x: number; y: number };
  taskId?: number;
};

type ToolDefinition = {
  name: string;
  description: string;
  parameters?: {
    properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
    required?: string[];
  };
};

type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

type Workflow = {
  id: string;
  name: string;
  goal: string;
  status: "draft" | "running" | "completed" | "failed";
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt: string;
  createdAt: string;
  lastRunAt?: string;
};

const ROLES: Role[] = ["manager", "research", "coding", "review", "browser"];

function newNode(index: number): WorkflowNode {
  const id = `node_${Math.random().toString(36).slice(2, 9)}`;
  return {
    id,
    title: `Node ${index + 1}`,
    role: "manager",
    prompt: "Describe what this agent role should accomplish.",
    status: "pending",
    dependsOn: [],
    position: { x: 120 + index * 220, y: 140 },
  };
}

function edgeColor(status: NodeStatus): string {
  if (status === "completed") return "#10b981";
  if (status === "running") return "#3b82f6";
  if (status === "failed") return "#f43f5e";
  return "#6b7280";
}

function formatRole(role: Role): string {
  if (role === "manager") return "Manager";
  if (role === "research") return "Research";
  if (role === "coding") return "Coding";
  if (role === "review") return "Review";
  return "Browser";
}

export function WorkflowGraphEditor() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [edgeFrom, setEdgeFrom] = useState<string>("");
  const [edgeTo, setEdgeTo] = useState<string>("");
  const [dragState, setDragState] = useState<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);

  const workflowsQuery = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows.list() as Promise<Workflow[]>,
  });

  const toolDefinitionsQuery = useQuery({
    queryKey: ["tool-definitions"],
    queryFn: () => api.tools.list(),
  });
  const toolDefinitions = (toolDefinitionsQuery.data ?? []) as ToolDefinition[];

  const selectedWorkflow = useMemo(() => {
    const workflows = workflowsQuery.data ?? [];
    if (!workflows.length) return null;
    if (!selectedWorkflowId) return workflows[0] ?? null;
    return workflows.find((wf) => wf.id === selectedWorkflowId) ?? workflows[0] ?? null;
  }, [workflowsQuery.data, selectedWorkflowId]);

  const selectedNode = useMemo(
    () => selectedWorkflow?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [selectedWorkflow, selectedNodeId]
  );

  const createWorkflow = useMutation({
    mutationFn: () =>
      api.workflows.create({
        name: `Workflow ${new Date().toLocaleString()}`,
        goal: "",
        nodes: [newNode(0)],
        edges: [],
      }) as Promise<Workflow>,
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ["workflows"] });
      setSelectedWorkflowId((created as Workflow).id);
      setSelectedNodeId((created as Workflow).nodes[0]?.id ?? null);
    },
  });

  const saveWorkflow = useMutation({
    mutationFn: (workflow: Workflow) => api.workflows.update(workflow.id, workflow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const runWorkflow = useMutation({
    mutationFn: (id: string) => api.workflows.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const resumeWorkflow = useMutation({
    mutationFn: (id: string) => api.workflows.resume(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const deleteWorkflow = useMutation({
    mutationFn: (id: string) => api.workflows.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflows"] });
      setSelectedWorkflowId(null);
      setSelectedNodeId(null);
    },
  });

  const patchWorkflow = (updater: (workflow: Workflow) => Workflow) => {
    if (!selectedWorkflow) return;
    const next = updater(selectedWorkflow);
    saveWorkflow.mutate(next);
  };

  const addNode = () => {
    if (!selectedWorkflow) return;
    patchWorkflow((workflow) => {
      const node = newNode(workflow.nodes.length);
      return { ...workflow, nodes: [...workflow.nodes, node] };
    });
  };

  const removeNode = (nodeId: string) => {
    if (!selectedWorkflow) return;
    patchWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== nodeId).map((node) => ({
        ...node,
        dependsOn: (node.dependsOn ?? []).filter((dep) => dep !== nodeId),
      })),
      edges: workflow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    }));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  };

  const addEdge = () => {
    if (!selectedWorkflow || !edgeFrom || !edgeTo || edgeFrom === edgeTo) return;
    const id = `edge_${edgeFrom}_${edgeTo}`;
    const exists = selectedWorkflow.edges.some((edge) => edge.id === id);
    if (exists) return;

    patchWorkflow((workflow) => ({
      ...workflow,
      edges: [...workflow.edges, { id, source: edgeFrom, target: edgeTo }],
      nodes: workflow.nodes.map((node) => {
        if (node.id !== edgeTo) return node;
        const dependsOn = Array.from(new Set([...(node.dependsOn ?? []), edgeFrom]));
        return { ...node, dependsOn };
      }),
    }));
    setEdgeFrom("");
    setEdgeTo("");
  };

  const removeEdge = (edgeId: string) => {
    if (!selectedWorkflow) return;
    const edge = selectedWorkflow.edges.find((item) => item.id === edgeId);
    patchWorkflow((workflow) => ({
      ...workflow,
      edges: workflow.edges.filter((item) => item.id !== edgeId),
      nodes: workflow.nodes.map((node) => {
        if (!edge || node.id !== edge.target) return node;
        return { ...node, dependsOn: (node.dependsOn ?? []).filter((dep) => dep !== edge.source) };
      }),
    }));
  };

  const updateNode = (nodeId: string, patch: Partial<WorkflowNode>) => {
    patchWorkflow((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    }));
  };

  const selectedToolDef = selectedNode?.kind === "tool_call"
    ? toolDefinitions.find((tool) => tool.name === selectedNode.toolName)
    : undefined;

  const updateToolInputField = (key: string, value: unknown) => {
    if (!selectedNode) return;
    updateNode(selectedNode.id, {
      toolInput: { ...(selectedNode.toolInput ?? {}), [key]: value },
    });
  };

  const insertToken = (key: string, nodeId: string) => {
    if (!selectedNode) return;
    const current = String((selectedNode.toolInput ?? {})[key] ?? "");
    updateToolInputField(key, `${current}{{${nodeId}.result}}`);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragState || !selectedWorkflow) return;
    const container = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - container.left - dragState.offsetX;
    const y = event.clientY - container.top - dragState.offsetY;
    updateNode(dragState.nodeId, { position: { x: Math.max(20, x), y: Math.max(20, y) } });
  };

  const running = runWorkflow.isPending || resumeWorkflow.isPending;

  return (
    <div className="p-6 h-full flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("workflowPage.title")}</h1>
          <p className="text-sm text-gray-400">{t("workflowPage.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => createWorkflow.mutate()} className="btn-secondary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            {t("workflowPage.newWorkflow")}
          </button>
          {selectedWorkflow && (
            <>
              <button
                onClick={() => runWorkflow.mutate(selectedWorkflow.id)}
                disabled={running}
                className="btn-primary flex items-center gap-2 disabled:opacity-60"
              >
                <Play className="w-4 h-4" />
                Run
              </button>
              <button
                onClick={() => resumeWorkflow.mutate(selectedWorkflow.id)}
                disabled={running}
                className="btn-secondary flex items-center gap-2 disabled:opacity-60"
              >
                <RotateCcw className="w-4 h-4" />
                Resume
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
        <aside className="col-span-3 card overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Workflows</h2>
            <span className="text-xs text-gray-400">{workflowsQuery.data?.length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {(workflowsQuery.data ?? []).map((workflow) => (
              <button
                key={workflow.id}
                onClick={() => {
                  setSelectedWorkflowId(workflow.id);
                  setSelectedNodeId(workflow.nodes[0]?.id ?? null);
                }}
                className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                  selectedWorkflow?.id === workflow.id
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-gray-800 bg-gray-900 hover:border-gray-600"
                }`}
              >
                <div className="font-medium truncate">{workflow.name}</div>
                <div className="text-xs text-gray-400 flex items-center justify-between mt-1">
                  <span className="capitalize">{workflow.status}</span>
                  <span>{workflow.nodes.length} nodes</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="col-span-6 card relative min-h-[540px] overflow-hidden"
          onMouseMove={handleMouseMove}
          onMouseUp={() => setDragState(null)}
          onMouseLeave={() => setDragState(null)}
        >
          {!selectedWorkflow && (
            <div className="h-full grid place-items-center text-gray-500">
              {t("workflowPage.chooseOrCreate")}
            </div>
          )}

          {selectedWorkflow && (
            <>
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                {selectedWorkflow.edges.map((edge) => {
                  const source = selectedWorkflow.nodes.find((node) => node.id === edge.source);
                  const target = selectedWorkflow.nodes.find((node) => node.id === edge.target);
                  if (!source?.position || !target?.position) return null;
                  const x1 = source.position.x + 90;
                  const y1 = source.position.y + 34;
                  const x2 = target.position.x + 90;
                  const y2 = target.position.y + 34;
                  return (
                    <line
                      key={edge.id}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={edgeColor(target.status)}
                      strokeWidth="2"
                      strokeDasharray={target.status === "pending" ? "4 4" : "0"}
                    />
                  );
                })}
              </svg>

              {selectedWorkflow.nodes.map((node) => (
                <button
                  key={node.id}
                  onMouseDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDragState({
                      nodeId: node.id,
                      offsetX: event.clientX - rect.left,
                      offsetY: event.clientY - rect.top,
                    });
                  }}
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`absolute w-44 rounded-xl border p-3 text-left transition shadow-lg ${
                    selectedNode?.id === node.id
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-gray-700 bg-gray-950/90 hover:border-gray-500"
                  }`}
                  style={{
                    left: node.position?.x ?? 80,
                    top: node.position?.y ?? 100,
                    cursor: dragState?.nodeId === node.id ? "grabbing" : "grab",
                  }}
                >
                  <div className="text-xs text-gray-400 uppercase flex items-center gap-1">
                    {node.kind === "tool_call" ? (
                      <>
                        <Wrench className="w-3 h-3" />
                        {node.toolName || "tool"}
                      </>
                    ) : (
                      formatRole(node.role)
                    )}
                  </div>
                  <div className="font-semibold leading-tight mt-1 line-clamp-2">{node.title}</div>
                  <div className="text-xs mt-2 capitalize" style={{ color: edgeColor(node.status) }}>
                    {node.status}
                  </div>
                </button>
              ))}
            </>
          )}
        </section>

        <aside className="col-span-3 card overflow-y-auto space-y-4">
          {selectedWorkflow ? (
            <>
              <div className="space-y-2">
                <h2 className="font-semibold">{t("workflowPage.workflow")}</h2>
                <input
                  className="input w-full"
                  value={selectedWorkflow.name}
                  onChange={(e) => patchWorkflow((workflow) => ({ ...workflow, name: e.target.value }))}
                />
                <textarea
                  className="input w-full"
                  rows={3}
                  value={selectedWorkflow.goal}
                  onChange={(e) => patchWorkflow((workflow) => ({ ...workflow, goal: e.target.value }))}
                  placeholder="Globales Ziel des Workflows"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={addNode} className="btn-secondary flex items-center justify-center gap-2">
                    <Plus className="w-4 h-4" />
                    Node
                  </button>
                  <button
                    onClick={() => deleteWorkflow.mutate(selectedWorkflow.id)}
                    className="btn-danger flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-t border-gray-800 pt-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Link2 className="w-4 h-4" />
                  Edges
                </h3>
                <select className="input w-full" value={edgeFrom} onChange={(e) => setEdgeFrom(e.target.value)}>
                  <option value="">Quelle</option>
                  {selectedWorkflow.nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.title}</option>
                  ))}
                </select>
                <select className="input w-full" value={edgeTo} onChange={(e) => setEdgeTo(e.target.value)}>
                  <option value="">Ziel</option>
                  {selectedWorkflow.nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.title}</option>
                  ))}
                </select>
                <button onClick={addEdge} className="btn-secondary w-full flex items-center justify-center gap-2">
                  <Zap className="w-4 h-4" />
                  {t("workflowPage.addEdge")}
                </button>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {selectedWorkflow.edges.map((edge) => (
                    <div key={edge.id} className="text-xs rounded border border-gray-800 p-2 flex items-center justify-between">
                      <span>{edge.source} {"->"} {edge.target}</span>
                      <button onClick={() => removeEdge(edge.id)} className="text-red-400">x</button>
                    </div>
                  ))}
                </div>
              </div>

              {selectedNode && (
                <div className="space-y-2 border-t border-gray-800 pt-3">
                  <h3 className="text-sm font-semibold">Node Inspector</h3>
                  <input
                    className="input w-full"
                    value={selectedNode.title}
                    onChange={(e) => updateNode(selectedNode.id, { title: e.target.value })}
                  />

                  <select
                    className="input w-full"
                    value={selectedNode.kind ?? "agent"}
                    onChange={(e) =>
                      updateNode(selectedNode.id, {
                        kind: e.target.value as NodeKind,
                        ...(e.target.value === "tool_call" ? { toolInput: selectedNode.toolInput ?? {} } : {}),
                      })
                    }
                  >
                    <option value="agent">Agent (LLM)</option>
                    <option value="tool_call">Tool Call</option>
                  </select>

                  {(selectedNode.kind ?? "agent") === "agent" ? (
                    <>
                      <select
                        className="input w-full"
                        value={selectedNode.role}
                        onChange={(e) => updateNode(selectedNode.id, { role: e.target.value as Role })}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>{formatRole(role)}</option>
                        ))}
                      </select>
                      <textarea
                        className="input w-full"
                        rows={6}
                        value={selectedNode.prompt}
                        onChange={(e) => updateNode(selectedNode.id, { prompt: e.target.value })}
                      />
                    </>
                  ) : (
                    <div className="space-y-3 rounded-lg border border-gray-800 p-2">
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Wrench className="w-3.5 h-3.5" />
                        Tool Call
                      </div>
                      <select
                        className="input w-full text-sm"
                        value={selectedNode.toolName ?? ""}
                        onChange={(e) => updateNode(selectedNode.id, { toolName: e.target.value, toolInput: {} })}
                      >
                        <option value="">Select tool...</option>
                        {toolDefinitions.map((tool) => (
                          <option key={tool.name} value={tool.name}>{tool.name}</option>
                        ))}
                      </select>

                      {selectedToolDef?.description && (
                        <p className="text-xs text-gray-500">{selectedToolDef.description}</p>
                      )}

                      {selectedToolDef?.parameters?.properties &&
                        Object.entries(selectedToolDef.parameters.properties).map(([key, prop]) => {
                          const required = selectedToolDef.parameters?.required?.includes(key) ?? false;
                          const value = (selectedNode.toolInput ?? {})[key];
                          const isTextField = !prop.type || prop.type === "string";

                          return (
                            <div key={key} className="space-y-1">
                              <label className="text-xs text-gray-400 block">
                                {key}
                                {required ? " *" : ""}
                                {prop.description ? ` - ${prop.description}` : ""}
                              </label>

                              {prop.enum ? (
                                <select
                                  className="input w-full text-sm"
                                  value={String(value ?? "")}
                                  onChange={(e) => updateToolInputField(key, e.target.value)}
                                >
                                  <option value="">-</option>
                                  {prop.enum.map((option) => (
                                    <option key={option} value={option}>{option}</option>
                                  ))}
                                </select>
                              ) : prop.type === "boolean" ? (
                                <input
                                  type="checkbox"
                                  checked={Boolean(value)}
                                  onChange={(e) => updateToolInputField(key, e.target.checked)}
                                />
                              ) : prop.type === "number" ? (
                                <input
                                  type="number"
                                  className="input w-full text-sm"
                                  value={typeof value === "number" ? value : ""}
                                  onChange={(e) =>
                                    updateToolInputField(key, e.target.value === "" ? undefined : Number(e.target.value))
                                  }
                                />
                              ) : prop.type === "object" || prop.type === "array" ? (
                                <textarea
                                  className="input w-full text-xs font-mono"
                                  rows={3}
                                  value={
                                    typeof value === "string"
                                      ? value
                                      : JSON.stringify(value ?? (prop.type === "array" ? [] : {}))
                                  }
                                  onChange={(e) => updateToolInputField(key, e.target.value)}
                                  onBlur={(e) => {
                                    try {
                                      updateToolInputField(key, JSON.parse(e.target.value));
                                    } catch {
                                      // keep raw text until valid JSON is entered
                                    }
                                  }}
                                />
                              ) : (
                                <input
                                  className="input w-full text-sm"
                                  value={String(value ?? "")}
                                  onChange={(e) => updateToolInputField(key, e.target.value)}
                                />
                              )}

                              {isTextField && (selectedNode.dependsOn ?? []).length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {(selectedNode.dependsOn ?? []).map((depId) => {
                                    const depNode = selectedWorkflow?.nodes.find((n) => n.id === depId);
                                    return (
                                      <button
                                        key={depId}
                                        type="button"
                                        onClick={() => insertToken(key, depId)}
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
                                      >
                                        + {depNode?.title ?? depId}.result
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}

                  <button
                    onClick={() => removeNode(selectedNode.id)}
                    className="btn-danger w-full flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t("workflowPage.removeNode")}
                  </button>

                  {selectedNode.taskId && (
                    <Link
                      to="/tasks"
                      className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View Task #{selectedNode.taskId} in Task Manager
                    </Link>
                  )}

                  {selectedNode.result && (
                    <pre className="text-xs whitespace-pre-wrap bg-black/40 border border-gray-800 rounded-lg p-2 max-h-52 overflow-y-auto">
                      {selectedNode.result}
                    </pre>
                  )}
                </div>
              )}

              <div className="text-xs text-gray-500 border-t border-gray-800 pt-3">
                Status: <span className="capitalize">{selectedWorkflow.status}</span>
                {selectedWorkflow.lastRunAt ? ` | Last run: ${new Date(selectedWorkflow.lastRunAt).toLocaleString()}` : ""}
              </div>

              <button
                onClick={() => selectedWorkflow && saveWorkflow.mutate(selectedWorkflow)}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" />
                {t("workflowPage.saveNow")}
              </button>
            </>
          ) : (
            <div className="text-gray-500">{t("workflowPage.noneSelected")}</div>
          )}
        </aside>
      </div>
    </div>
  );
}
