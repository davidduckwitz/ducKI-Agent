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

export function ProjectManager() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", folder: "" });

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

      <div className="space-y-2">
        {(projects as Project[]).map((project) => (
          <div key={project.id} className="card flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FolderOpen className="w-5 h-5 text-blue-400 shrink-0" />
              <div>
                <p className="font-medium">{project.name}</p>
                {project.description && (
                  <p className="text-sm text-gray-400">{project.description}</p>
                )}
                {project.folder && (
                  <p className="text-xs text-gray-500 font-mono">{project.folder}</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => remove.mutate(project.id)}
                className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
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
    </div>
  );
}
