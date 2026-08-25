import { useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Eye, Globe2, Plus, Play, RotateCcw, Save, Trash2, Link2, Upload, Zap, Wrench, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useBrowserActivityStore } from "../../lib/browserActivityStore";

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

export function workflowDisplayEdges(workflow: Workflow): WorkflowEdge[] {
  const edges = [...workflow.edges];
  const pairs = new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
  for (const node of workflow.nodes) {
    for (const source of node.dependsOn ?? []) {
      const pair = `${source}->${node.id}`;
      if (!pairs.has(pair)) {
        pairs.add(pair);
        edges.push({ id: `inferred_${source}_${node.id}`, source, target: node.id });
      }
    }
  }
  return edges;
}

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

type BrowserAutomationStep = { action: string; [key: string]: unknown };

function browserWorkflowPayload(rawSteps: BrowserAutomationStep[], name = "Browser Automation"): Pick<Workflow, "name" | "goal" | "nodes" | "edges"> {
  const cleaned = rawSteps.filter((step) => step && typeof step.action === "string" && !["stream_start", "stream_stop", "screenshot", "list_sessions"].includes(step.action));
  const firstUrl = String(cleaned.find((step) => step.action === "goto" || step.action === "launch")?.url ?? "about:blank");
  const steps = cleaned[0]?.action === "launch" ? cleaned : [{ action: "launch", url: firstUrl, newSession: true }, ...cleaned];
  const nodes: WorkflowNode[] = steps.map((step, index) => {
    const id = `browser_${index + 1}`;
    const { action, sessionId: _recordedSession, actor: _actor, ...params } = step;
    return {
      id,
      title: `${index + 1}. ${action.replaceAll("_", " ")}`,
      kind: "tool_call",
      role: "browser",
      prompt: "",
      toolName: "browser",
      toolInput: {
        action,
        ...params,
        ...(index > 0 ? { sessionId: "{{browser_1.result.sessionId}}" } : {}),
      },
      status: "pending",
      dependsOn: index > 0 ? [`browser_${index}`] : [],
      position: { x: 80 + (index % 4) * 260, y: 100 + Math.floor(index / 4) * 210 },
    };
  });
  const edges: WorkflowEdge[] = nodes.slice(1).map((node, index) => ({ id: `edge_${nodes[index]!.id}_${node.id}`, source: nodes[index]!.id, target: node.id }));
  return { name, goal: "Aufgezeichnete Browser-Interaktion reproduzierbar ausführen", nodes, edges };
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);
  const browserActivities = useBrowserActivityStore((state) => state.activities);

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

  // Older graphs and some agent-created boards stored only `dependsOn`. Render those
  // dependencies as edges too, while de-duplicating explicit edge records.
  const displayEdges = useMemo<WorkflowEdge[]>(() => {
    return selectedWorkflow ? workflowDisplayEdges(selectedWorkflow) : [];
  }, [selectedWorkflow]);

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

  const importBrowserWorkflow = useMutation({
    mutationFn: (payload: Pick<Workflow, "name" | "goal" | "nodes" | "edges">) => api.workflows.create(payload) as Promise<Workflow>,
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ["workflows"] });
      setSelectedWorkflowId(created.id);
      setSelectedNodeId(created.nodes[0]?.id ?? null);
      setExpandedNodes(new Set(created.nodes.slice(0, 1).map((node) => node.id)));
    },
  });

  const importCurrentBrowserTimeline = () => {
    const latestSessionId = browserActivities.at(-1)?.sessionId;
    const steps = browserActivities.filter((item) => item.success && (!latestSessionId || item.sessionId === latestSessionId)).map((item) => {
      const { action: _inputAction, actor: _actor, sessionId: _sessionId, ...params } = item.params;
      return { action: item.action, ...params } as BrowserAutomationStep;
    });
    if (steps.length === 0) return;
    importBrowserWorkflow.mutate(browserWorkflowPayload(steps, `Browser Automation ${new Date().toLocaleString()}`));
  };

  const importAutomationFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const parsed = JSON.parse(await file.text()) as { name?: string; steps?: BrowserAutomationStep[] } | BrowserAutomationStep[];
    const steps = Array.isArray(parsed) ? parsed : parsed.steps ?? [];
    if (steps.length === 0) throw new Error("Die Automationsdatei enthält keine Schritte");
    importBrowserWorkflow.mutate(browserWorkflowPayload(steps, Array.isArray(parsed) ? file.name.replace(/\.json$/i, "") : parsed.name ?? file.name));
  };

  const saveWorkflow = useMutation({
    mutationFn: (workflow: Workflow) => api.workflows.update(workflow.id, workflow),
    onMutate: (workflow) => {
      qc.setQueryData<Workflow[]>(["workflows"], (items = []) => items.map((item) => item.id === workflow.id ? workflow : item));
    },
    onError: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
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
    qc.setQueryData<Workflow[]>(["workflows"], (items = []) => items.map((item) => item.id === next.id ? next : item));
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
    const edge = displayEdges.find((item) => item.id === edgeId);
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
    qc.setQueryData<Workflow[]>(["workflows"], (items = []) => items.map((workflow) => workflow.id !== selectedWorkflow.id ? workflow : {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === dragState.nodeId ? { ...node, position: { x: Math.max(20, x), y: Math.max(20, y) } } : node),
    }));
  };

  const finishDrag = () => {
    if (dragState && selectedWorkflow) {
      const current = qc.getQueryData<Workflow[]>(["workflows"])?.find((workflow) => workflow.id === selectedWorkflow.id);
      if (current) saveWorkflow.mutate(current);
    }
    setDragState(null);
  };

  const running = runWorkflow.isPending || resumeWorkflow.isPending;

  return (
    <div className="p-3 sm:p-6 h-full flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("workflowPage.title")}</h1>
          <p className="text-sm text-gray-400">{t("workflowPage.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importAutomationFile(event)} />
          <button onClick={importCurrentBrowserTimeline} disabled={browserActivities.length === 0 || importBrowserWorkflow.isPending} className="btn-secondary flex items-center gap-2 disabled:opacity-40" title="Aktuelle Browser-Timeline als Workflow importieren">
            <Globe2 className="w-4 h-4" />
            Browser-Timeline
          </button>
          <button onClick={() => importInputRef.current?.click()} disabled={importBrowserWorkflow.isPending} className="btn-secondary flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Automation importieren
          </button>
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

        <section className="col-span-6 card relative min-h-[540px] overflow-auto bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] bg-[size:24px_24px]"
          onMouseMove={handleMouseMove}
          onMouseUp={finishDrag}
          onMouseLeave={finishDrag}
        >
          {!selectedWorkflow && (
            <div className="h-full grid place-items-center text-gray-500">
              {t("workflowPage.chooseOrCreate")}
            </div>
          )}

          {selectedWorkflow && (
            <>
              <svg className="absolute inset-0 min-w-full min-h-full w-[1400px] h-[900px] pointer-events-none overflow-visible">
                <defs>
                  {(["pending", "running", "completed", "failed"] as NodeStatus[]).map((status) => (
                    <marker key={status} id={`arrow-${status}`} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L0,6 L9,3 z" fill={edgeColor(status)} />
                    </marker>
                  ))}
                </defs>
                {displayEdges.map((edge) => {
                  const source = selectedWorkflow.nodes.find((node) => node.id === edge.source);
                  const target = selectedWorkflow.nodes.find((node) => node.id === edge.target);
                  if (!source?.position || !target?.position) return null;
                  const x1 = source.position.x + 224;
                  const y1 = source.position.y + 36;
                  const x2 = target.position.x;
                  const y2 = target.position.y + 36;
                  const bend = Math.max(60, Math.abs(x2 - x1) * 0.45);
                  const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
                  return (
                    <g
                      key={edge.id}
                    >
                      <path d={path} fill="none" stroke="hsl(var(--background))" strokeWidth="7" opacity=".8" />
                      <path d={path} fill="none" stroke={edgeColor(target.status)} strokeWidth="2.5" strokeDasharray={target.status === "pending" ? "7 6" : "0"} markerEnd={`url(#arrow-${target.status})`} className={target.status === "running" ? "animate-pulse" : ""} />
                    </g>
                  );
                })}
              </svg>

              {selectedWorkflow.nodes.map((node) => (
                <div
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`absolute w-56 overflow-hidden rounded-xl border text-left transition shadow-xl backdrop-blur ${
                    selectedNode?.id === node.id
                      ? "border-blue-500 bg-slate-950/95 ring-2 ring-blue-500/20"
                      : "border-gray-700 bg-slate-950/90 hover:border-gray-500"
                  }`}
                  style={{
                    left: node.position?.x ?? 80,
                    top: node.position?.y ?? 100,
                  }}
                >
                  <span className="absolute -left-1.5 top-9 h-3 w-3 rounded-full border-2 border-slate-950 bg-gray-500" />
                  <span className="absolute -right-1.5 top-9 h-3 w-3 rounded-full border-2 border-slate-950" style={{ backgroundColor: edgeColor(node.status) }} />
                  <div
                    className="cursor-grab select-none border-b border-gray-800 px-3 py-2 active:cursor-grabbing"
                    onMouseDown={(event) => {
                      const rect = event.currentTarget.parentElement!.getBoundingClientRect();
                      setDragState({ nodeId: node.id, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top });
                    }}
                  >
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-400">
                      {node.kind === "tool_call" ? <><Wrench className="h-3 w-3" />{node.toolName || "tool"}</> : formatRole(node.role)}
                      <span className="ml-auto h-2 w-2 rounded-full" style={{ backgroundColor: edgeColor(node.status) }} />
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm font-semibold leading-tight">{node.title}</div>
                  </div>
                  <button type="button" onClick={(event) => { event.stopPropagation(); setExpandedNodes((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; }); }} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:bg-white/5 hover:text-gray-200">
                    {expandedNodes.has(node.id) ? <ChevronDown className="h-3.5 w-3.5"/> : <ChevronRight className="h-3.5 w-3.5"/>}
                    Optionen & Ausgabe
                    <span className="ml-auto capitalize" style={{ color: edgeColor(node.status) }}>{node.status}</span>
                  </button>
                  {expandedNodes.has(node.id) && <div className="space-y-2 border-t border-gray-800 px-3 py-2 text-[10px]">
                    <div><span className="text-gray-500">Eingabe</span><pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-1.5 text-gray-300">{node.kind === "tool_call" ? JSON.stringify(node.toolInput ?? {}, null, 2) : node.prompt || "–"}</pre></div>
                    <div><span className="flex items-center gap-1 text-gray-500"><Eye className="h-3 w-3"/>Ausgabe an nächste Nodes</span><pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-1.5 text-gray-300">{node.resultData !== undefined ? JSON.stringify(node.resultData, null, 2) : node.result || "Noch keine Ausgabe"}</pre></div>
                    {(node.dependsOn ?? []).length > 0 && <div className="truncate text-gray-500">Wartet auf: {(node.dependsOn ?? []).join(", ")}</div>}
                  </div>
                  }
                </div>
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
                  {displayEdges.map((edge) => (
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
