import { useState, useEffect } from "react";
import { AlertCircle, Folder, MessageSquare, CheckSquare, Zap, Loader } from "lucide-react";
import { api } from "../../lib/api";

interface ProjectDependency {
  codingFolder?: boolean;
  conversationCount: number;
  taskCount: number;
  workflowCount: number;
}

interface ProjectDeleteDialogProps {
  projectId: number;
  projectName: string;
  onConfirm: (deleteOptions: DeleteOptions) => void;
  onCancel: () => void;
  isDeleting: boolean;
}

export interface DeleteOptions {
  deleteCodingFolder: boolean;
  deleteConversations: boolean;
  deleteTasks: boolean;
  deleteWorkflows: boolean;
}

export function ProjectDeleteDialog({ projectId, projectName, onConfirm, onCancel, isDeleting }: ProjectDeleteDialogProps) {
  const [dependencies, setDependencies] = useState<ProjectDependency | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteOptions, setDeleteOptions] = useState<DeleteOptions>({
    deleteCodingFolder: true,
    deleteConversations: false,
    deleteTasks: false,
    deleteWorkflows: false,
  });

  useEffect(() => {
    const loadDependencies = async () => {
      try {
        console.log("[ProjectDeleteDialog] Loading dependencies for project:", projectId);
        const deps = await api.projects.getDependencies(projectId);
        console.log("[ProjectDeleteDialog] Dependencies loaded:", deps);
        setDependencies(deps);
      } catch (error) {
        console.error("[ProjectDeleteDialog] Error loading dependencies:", error);
        // Set default values on error
        setDependencies({
          codingFolder: true,
          conversationCount: 0,
          taskCount: 0,
          workflowCount: 0,
        });
      } finally {
        setLoading(false);
      }
    };

    loadDependencies();
  }, [projectId]);

  const handleToggle = (key: keyof DeleteOptions) => {
    setDeleteOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const hasDependencies =
    dependencies && (dependencies.conversationCount > 0 || dependencies.taskCount > 0 || dependencies.workflowCount > 0 || dependencies.codingFolder);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-md w-full border border-gray-700 space-y-4 p-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/10 rounded">
            <AlertCircle className="w-5 h-5 text-red-500" />
          </div>
          <div>
            <h3 className="font-semibold text-white">Projekt löschen</h3>
            <p className="text-sm text-gray-400">{projectName}</p>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader className="w-5 h-5 text-blue-500 animate-spin" />
          </div>
        )}

        {/* Dependencies */}
        {!loading && hasDependencies && (
          <div className="space-y-3">
            <p className="text-sm text-gray-300">Dieses Projekt hat Abhängigkeiten:</p>
            <div className="space-y-2 bg-gray-800/50 rounded p-3">
              {/* Coding Folder */}
              {dependencies?.codingFolder && (
                <label className="flex items-center gap-3 cursor-pointer hover:bg-gray-700/50 p-2 rounded">
                  <input
                    type="checkbox"
                    checked={deleteOptions.deleteCodingFolder}
                    onChange={() => handleToggle("deleteCodingFolder")}
                    className="w-4 h-4 rounded"
                  />
                  <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                  <span className="text-sm text-gray-300 flex-1">Projektverzeichnis (Coding)</span>
                </label>
              )}

              {/* Conversations */}
              {dependencies && dependencies.conversationCount > 0 && (
                <label className="flex items-center gap-3 cursor-pointer hover:bg-gray-700/50 p-2 rounded">
                  <input
                    type="checkbox"
                    checked={deleteOptions.deleteConversations}
                    onChange={() => handleToggle("deleteConversations")}
                    className="w-4 h-4 rounded"
                  />
                  <MessageSquare className="w-4 h-4 text-green-400 shrink-0" />
                  <span className="text-sm text-gray-300 flex-1">Chats ({dependencies.conversationCount})</span>
                </label>
              )}

              {/* Tasks */}
              {dependencies && dependencies.taskCount > 0 && (
                <label className="flex items-center gap-3 cursor-pointer hover:bg-gray-700/50 p-2 rounded">
                  <input
                    type="checkbox"
                    checked={deleteOptions.deleteTasks}
                    onChange={() => handleToggle("deleteTasks")}
                    className="w-4 h-4 rounded"
                  />
                  <CheckSquare className="w-4 h-4 text-yellow-400 shrink-0" />
                  <span className="text-sm text-gray-300 flex-1">Tasks ({dependencies.taskCount})</span>
                </label>
              )}

              {/* Workflows */}
              {dependencies && dependencies.workflowCount > 0 && (
                <label className="flex items-center gap-3 cursor-pointer hover:bg-gray-700/50 p-2 rounded">
                  <input
                    type="checkbox"
                    checked={deleteOptions.deleteWorkflows}
                    onChange={() => handleToggle("deleteWorkflows")}
                    className="w-4 h-4 rounded"
                  />
                  <Zap className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="text-sm text-gray-300 flex-1">Workflows ({dependencies.workflowCount})</span>
                </label>
              )}
            </div>
          </div>
        )}

        {/* No dependencies */}
        {!loading && !hasDependencies && (
          <p className="text-sm text-gray-400 py-4">Dieses Projekt hat keine Abhängigkeiten und kann sicher gelöscht werden.</p>
        )}

        {/* Warning */}
        <div className="bg-red-500/10 border border-red-500/20 rounded p-3">
          <p className="text-xs text-red-300">Diese Aktion kann nicht rückgängig gemacht werden.</p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="px-4 py-2 rounded border border-gray-600 text-sm font-medium hover:bg-gray-800 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            onClick={() => onConfirm(deleteOptions)}
            disabled={isDeleting}
            className="px-4 py-2 rounded bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                Löschen...
              </>
            ) : (
              "Löschen"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
