import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, FolderOpen } from "lucide-react";
import { api } from "../../lib/api";

interface Project {
  id: number;
  name: string;
  description?: string;
  folder?: string;
  createdAt: string;
}

interface ProjectContent {
  conversations?: Array<{ id: number; name: string }>;
  tasks?: Array<{ id: number; title: string }>;
  codingProjects?: Array<{ name: string }>;
}

export function ProjectManager() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", folder: "" });
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list() as Promise<Project[]>,
  });

  const create = useMutation({
    mutationFn: () => api.projects.create(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setShowCreate(false);
      setForm({ name: "", description: "", folder: "" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.projects.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const { data: selectedProject } = useQuery({
    queryKey: ["projects", selectedProjectId],
    queryFn: () => (selectedProjectId ? api.projects.get(selectedProjectId) : null) as Promise<Project | null>,
    enabled: Boolean(selectedProjectId),
  });

  const { data: conversations = [] } = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () => api.chat.listConversations(selectedProjectId ?? undefined) as Promise<Array<{ id: number; name: string }>>,
    enabled: Boolean(selectedProjectId),
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.tasks.list(selectedProjectId ?? undefined) as Promise<Array<{ id: number; title: string }>>,
    enabled: Boolean(selectedProjectId),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projekte</h1>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Neu
        </button>
      </div>

      {showCreate && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Neues Projekt</h2>
          <input
            className="input w-full"
            placeholder="Projektname *"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="input w-full"
            placeholder="Beschreibung"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <input
            className="input w-full"
            placeholder="Ordnerpfad"
            value={form.folder}
            onChange={(e) => setForm((f) => ({ ...f, folder: e.target.value }))}
          />
          <div className="flex gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={!form.name || create.isPending}
              className="btn-primary disabled:opacity-50"
            >
              Erstellen
            </button>
            <button onClick={() => setShowCreate(false)} className="btn-secondary">
              Abbrechen
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2 lg:col-span-1">
          {(projects as Project[]).map((project) => (
            <div
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              className={`card cursor-pointer transition ${
                selectedProjectId === project.id
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-gray-800 hover:border-gray-700"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FolderOpen className="w-5 h-5 text-blue-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-gray-400 truncate">{project.description}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove.mutate(project.id);
                  }}
                  className="p-1.5 text-gray-400 hover:text-red-400 transition-colors shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {(projects as Project[]).length === 0 && (
            <div className="text-center text-gray-500 py-12">
              <FolderOpen className="w-10 h-10 mx-auto mb-3 text-gray-700" />
              <p>Keine Projekte vorhanden</p>
            </div>
          )}
        </div>

        {selectedProjectId && selectedProject && (
          <div className="lg:col-span-2 card space-y-4">
            <div>
              <h2 className="text-xl font-semibold mb-2">{selectedProject.name}</h2>
              {selectedProject.description && (
                <p className="text-sm text-gray-400 mb-2">{selectedProject.description}</p>
              )}
              <div className="text-xs text-gray-500 space-y-1">
                {selectedProject.folder && <p>Ordner: {selectedProject.folder}</p>}
                <p>Erstellt: {new Date(selectedProject.createdAt).toLocaleString()}</p>
              </div>
            </div>

            <div className="border-t border-gray-700 pt-4">
              <h3 className="font-medium mb-3">Projekt-Inhalte</h3>
              <div className="space-y-3">
                {conversations && Array.isArray(conversations) && (conversations as any[]).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-2">Chats ({(conversations as any[]).length})</p>
                    <ul className="space-y-1 text-xs">
                      {(conversations as any[]).map((conv: any) => (
                        <li key={conv.id} className="text-gray-300">• {conv.name}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {tasks && Array.isArray(tasks) && (tasks as any[]).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 mb-2">Tasks ({(tasks as any[]).length})</p>
                    <ul className="space-y-1 text-xs">
                      {(tasks as any[]).map((task: any) => (
                        <li key={task.id} className="text-gray-300">• {task.title}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {(!conversations || (conversations as any[]).length === 0) &&
                  (!tasks || (tasks as any[]).length === 0) && (
                    <p className="text-xs text-gray-500">Keine Inhalte vorhanden</p>
                  )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
