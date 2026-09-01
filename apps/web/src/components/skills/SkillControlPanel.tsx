import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Download,
  Trash2,
  Power,
  AlertCircle,
} from "lucide-react";
import { cn } from "../../lib/utils";

interface SkillControlPanelProps {
  skillId: string;
  skillName: string;
  isEnabled: boolean;
  isInstalled: boolean;
  /** false for skills managed elsewhere (e.g. plugin-bundled skills managed on the Plugins page). */
  canDelete?: boolean;
  onToggleEnabled: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
  isPending?: boolean;
}

export function SkillControlPanel({
  skillId: _skillId,
  skillName: _skillName,
  isEnabled,
  isInstalled,
  canDelete = true,
  onToggleEnabled,
  onDelete,
  isPending: _isPending = false,
}: SkillControlPanelProps) {
  const [showDelete, setShowDelete] = useState(false);

  const toggleEnabledMutation = useMutation({
    mutationFn: () => onToggleEnabled(!isEnabled),
  });

  const deleteMutation = useMutation({
    mutationFn: () => onDelete(),
    onSuccess: () => setShowDelete(false),
  });

  return (
    <div className="space-y-3">
      {/* Status Bar */}
      <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded">
        <div className="flex gap-1 flex-1">
          {isInstalled ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
              <Download className="w-3 h-3" />
              Installed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              <Download className="w-3 h-3" />
              Not Installed
            </span>
          )}

          {isEnabled ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
              <Power className="w-3 h-3" />
              Enabled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              <Power className="w-3 h-3" />
              Disabled
            </span>
          )}
        </div>
      </div>

      {/* Control Buttons */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {/* Enable/Disable */}
        <button
          onClick={() => toggleEnabledMutation.mutate()}
          disabled={toggleEnabledMutation.isPending || !isInstalled}
          className={cn(
            "p-2 rounded text-xs font-medium flex items-center justify-center gap-1 transition",
            isEnabled
              ? "bg-blue-600 hover:bg-blue-700 text-white"
              : "bg-gray-300 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100"
          )}
        >
          <Power className="w-3 h-3" />
          {isEnabled ? "Disable" : "Enable"}
        </button>

        {/* Install/Remove */}
        <button
          disabled={true}
          className="p-2 rounded text-xs font-medium flex items-center justify-center gap-1 bg-gray-300 dark:bg-gray-700 text-gray-600 dark:text-gray-400 cursor-not-allowed"
          title="Skills are auto-installed from file system"
        >
          <Download className="w-3 h-3" />
          Installed
        </button>

        {/* Delete */}
        {canDelete ? (
          !showDelete ? (
            <button
              onClick={() => setShowDelete(true)}
              className="p-2 rounded text-xs font-medium flex items-center justify-center gap-1 bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400"
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          ) : (
            <button
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="p-2 rounded text-xs font-bold flex items-center justify-center gap-1 bg-red-600 hover:bg-red-700 text-white animate-pulse"
            >
              <AlertCircle className="w-3 h-3" />
              Confirm?
            </button>
          )
        ) : (
          <button
            disabled
            className="p-2 rounded text-xs font-medium flex items-center justify-center gap-1 bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed"
            title="Managed on the Plugins page"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
