import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, CheckSquare, Circle, Clock, Play, FolderOpen, X, Save } from "lucide-react";
import { api } from "../../lib/api";

interface Task {
  id: number;
  projectId?: number;
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
  updatedAt?: string;
  result?: string;
}

interface Project {
  id: number;
  name: string;
}

type TaskColumnStatus = "pending" | "running" | "completed" | "failed";

const COLUMNS: Array<{ key: TaskColumnStatus; label: string; accent: string }> = [
  { key: "pending", label: "Backlog", accent: "border-slate-600" },
  { key: "running", label: "In Arbeit", accent: "border-blue-500" },
  { key: "completed", label: "Fertig", accent: "border-emerald-500" },
  { key: "failed", label: "Blockiert", accent: "border-rose-500" },
];

const statusIcon = (status: string) => {
  if (status === "completed") return <CheckSquare className="w-4 h-4 text-green-400" />;
  if (status === "running") return <Clock className="w-4 h-4 text-blue-400 animate-spin" />;
  return <Circle className="w-4 h-4 text-gray-400" />;
};

const priorityBadge = (priority: string) => {
  const classes: Record<string, string> = {
    critical: "bg-red-500/20 text-red-400",
    high: "bg-orange-500/20 text-orange-400",
    medium: "bg-yellow-500/20 text-yellow-400",
    low: "bg-gray-500/20 text-gray-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${classes[priority] ?? classes.medium}`}>
      {priority}
    </span>
  );
};

export function TaskManager() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | "all">("all");
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskEditForm, setTaskEditForm] = useState({
    title: "",
    description: "",
    priority: "medium",
    status: "pending",
    projectId: "",
  });
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "medium",
    projectId: "",
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list() as Promise<Project[]>,
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () =>
      api.tasks.list(selectedProjectId === "all" ? undefined : selectedProjectId) as Promise<Task[]>,
  });

  const create = useMutation({
    mutationFn: () =>
      api.tasks.create({
        title: form.title,
        description: form.description || undefined,
        priority: form.priority,
        projectId: form.projectId ? Number(form.projectId) : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      setShowCreate(false);
      setForm({ title: "", description: "", priority: "medium", projectId: "" });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      api.tasks.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const runTask = useMutation({
    mutationFn: (id: number) => api.tasks.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  useEffect(() => {
    if (!selectedTask) return;
    setTaskEditForm({
      title: selectedTask.title,
      description: selectedTask.description ?? "",
      priority: selectedTask.priority,
      status: selectedTask.status,
      projectId: selectedTask.projectId ? String(selectedTask.projectId) : "",
    });
  }, [selectedTask]);

  const tasksByStatus = (tasks as Task[]).reduce<Record<TaskColumnStatus, Task[]>>(
    (acc, task) => {
      if (task.status === "cancelled") return acc;
      if (task.status in acc) {
        acc[task.status as TaskColumnStatus].push(task);
      }
      return acc;
    },
    { pending: [], running: [], completed: [], failed: [] }
  );

  const moveTask = (taskId: number, nextStatus: TaskColumnStatus) => {
    const task = (tasks as Task[]).find((item) => item.id === taskId);
    if (!task || task.status === nextStatus) return;
    update.mutate({ id: taskId, data: { status: nextStatus } });
  };

  const projectName = (projectId?: number) => {
    if (!projectId) return "Ohne Projekt";
    const project = (projects as Project[]).find((item) => item.id === projectId);
    return project?.name ?? `Projekt #${projectId}`;
  };

  const saveTaskDetails = () => {
    if (!selectedTask) return;
    update.mutate(
      {
        id: selectedTask.id,
        data: {
          title: taskEditForm.title,
          description: taskEditForm.description || undefined,
          priority: taskEditForm.priority,
          status: taskEditForm.status,
          projectId: taskEditForm.projectId ? Number(taskEditForm.projectId) : undefined,
        },
      },
      {
        onSuccess: () => {
          const refreshed = (tasks as Task[]).find((item) => item.id === selectedTask.id);
          if (refreshed) setSelectedTask(refreshed);
        },
      }
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Task Board</h1>
          <p className="text-sm text-gray-400">Drag and Drop, Status-Tracking und Agent-Execution</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="input"
            value={selectedProjectId}
            onChange={(e) => {
              const value = e.target.value;
              setSelectedProjectId(value === "all" ? "all" : Number(value));
            }}
          >
            <option value="all">Alle Projekte</option>
            {(projects as Project[]).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Neu
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card space-y-3">
          <input
            className="input w-full"
            placeholder="Titel *"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <textarea
            className="input w-full"
            placeholder="Beschreibung"
            rows={3}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <select
            className="input w-full"
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
          >
            <option value="low">Niedrig</option>
            <option value="medium">Mittel</option>
            <option value="high">Hoch</option>
            <option value="critical">Kritisch</option>
          </select>
          <select
            className="input w-full"
            value={form.projectId}
            onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
          >
            <option value="">Kein Projekt</option>
            {(projects as Project[]).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={!form.title || create.isPending}
              className="btn-primary disabled:opacity-50"
            >
              Erstellen
            </button>
            <button onClick={() => setShowCreate(false)} className="btn-secondary">Abbrechen</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4 items-start">
        {COLUMNS.map((column) => (
          <section
            key={column.key}
            className={`card min-h-[320px] border-t-2 ${column.accent}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (draggedTaskId !== null) {
                moveTask(draggedTaskId, column.key);
              }
              setDraggedTaskId(null);
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">{column.label}</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">
                {tasksByStatus[column.key].length}
              </span>
            </div>

            <div className="space-y-2">
              {tasksByStatus[column.key].map((task) => (
                <article
                  key={task.id}
                  draggable
                  onDragStart={() => setDraggedTaskId(task.id)}
                  className="rounded-lg border border-gray-800 bg-gray-950/80 p-3 space-y-2 cursor-grab active:cursor-grabbing"
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 shrink-0">{statusIcon(task.status)}</div>
                    <div className="flex-1 min-w-0">
                      <p className={`font-medium ${task.status === "completed" ? "line-through text-gray-500" : ""}`}>
                        {task.title}
                      </p>
                      {task.description && (
                        <p className="text-sm text-gray-400 line-clamp-2">{task.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    {priorityBadge(task.priority)}
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <FolderOpen className="w-3.5 h-3.5" />
                      {projectName(task.projectId)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      onClick={() => setSelectedTask(task)}
                      className="text-xs text-gray-400 hover:text-gray-200"
                    >
                      Details
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => runTask.mutate(task.id)}
                        disabled={runTask.isPending || task.status === "running"}
                        className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-50"
                        title="Task mit Agent ausführen"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => remove.mutate(task.id)}
                        className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                        title="Task löschen"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </article>
              ))}

              {tasksByStatus[column.key].length === 0 && (
                <div className="text-sm text-gray-500 border border-dashed border-gray-800 rounded-lg p-3 text-center">
                  Keine Tasks
                </div>
              )}
            </div>
          </section>
        ))}
      </div>

      {(tasks as Task[]).length === 0 && (
        <div className="text-center text-gray-500 py-6">
          <CheckSquare className="w-10 h-10 mx-auto mb-3 text-gray-700" />
          <p>Keine Aufgaben vorhanden</p>
        </div>
      )}

      <div className="text-xs text-gray-500">
        Tipp: Karten zwischen Spalten ziehen, um den Status zu ändern. Mit dem Play-Button wird ein Task direkt vom Agenten bearbeitet.
      </div>

      {selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold">Task Details #{selectedTask.id}</h2>
              <button
                onClick={() => setSelectedTask(null)}
                className="p-1 rounded hover:bg-gray-800 text-gray-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="text-xs text-gray-400">Titel</label>
                <input
                  className="input w-full"
                  value={taskEditForm.title}
                  onChange={(e) => setTaskEditForm((f) => ({ ...f, title: e.target.value }))}
                />
              </div>

              <div className="md:col-span-2">
                <label className="text-xs text-gray-400">Beschreibung</label>
                <textarea
                  className="input w-full"
                  rows={4}
                  value={taskEditForm.description}
                  onChange={(e) => setTaskEditForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              <div>
                <label className="text-xs text-gray-400">Priorität</label>
                <select
                  className="input w-full"
                  value={taskEditForm.priority}
                  onChange={(e) => setTaskEditForm((f) => ({ ...f, priority: e.target.value }))}
                >
                  <option value="low">Niedrig</option>
                  <option value="medium">Mittel</option>
                  <option value="high">Hoch</option>
                  <option value="critical">Kritisch</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-400">Status</label>
                <select
                  className="input w-full"
                  value={taskEditForm.status}
                  onChange={(e) => setTaskEditForm((f) => ({ ...f, status: e.target.value }))}
                >
                  <option value="pending">Backlog</option>
                  <option value="running">In Arbeit</option>
                  <option value="completed">Fertig</option>
                  <option value="failed">Blockiert</option>
                  <option value="cancelled">Abgebrochen</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="text-xs text-gray-400">Projekt</label>
                <select
                  className="input w-full"
                  value={taskEditForm.projectId}
                  onChange={(e) => setTaskEditForm((f) => ({ ...f, projectId: e.target.value }))}
                >
                  <option value="">Kein Projekt</option>
                  {(projects as Project[]).map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </div>

              {selectedTask.result && (
                <div className="md:col-span-2">
                  <label className="text-xs text-gray-400">Ergebnis</label>
                  <pre className="rounded border border-gray-800 bg-black/30 p-2 text-xs text-gray-300 whitespace-pre-wrap overflow-x-auto">
                    {selectedTask.result}
                  </pre>
                </div>
              )}

              <div className="md:col-span-2 text-xs text-gray-500">
                Erstellt: {new Date(selectedTask.createdAt).toLocaleString()}
                {selectedTask.updatedAt ? ` | Aktualisiert: ${new Date(selectedTask.updatedAt).toLocaleString()}` : ""}
              </div>
            </div>

            <div className="p-4 border-t border-gray-800 flex items-center justify-between">
              <button
                onClick={() => {
                  remove.mutate(selectedTask.id, {
                    onSuccess: () => setSelectedTask(null),
                  });
                }}
                className="btn-secondary flex items-center gap-2 text-red-300 hover:text-red-200"
              >
                <Trash2 className="w-4 h-4" />
                Löschen
              </button>

              <div className="flex items-center gap-2">
                <button onClick={() => setSelectedTask(null)} className="btn-secondary">Schließen</button>
                <button
                  onClick={saveTaskDetails}
                  disabled={!taskEditForm.title.trim() || update.isPending}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  Speichern
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
