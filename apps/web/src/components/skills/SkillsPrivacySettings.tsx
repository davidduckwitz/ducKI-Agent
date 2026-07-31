import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, Eye, EyeOff, Download, Trash2, AlertCircle } from "lucide-react";
import { api } from "../../lib/api";

interface PrivacySetting {
  syncToPublic: boolean;
  privateMode: boolean;
  hiddenSkills: string[];
}

export function SkillsPrivacySettings() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data: settings = {} } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.list(),
  });

  const syncEnabled = settings.find?.((s: any) => s.key === "SKILLS_SYNC_PUBLIC")?.value !== "false";
  const privateMode = settings.find?.((s: any) => s.key === "SKILLS_PRIVATE_MODE")?.value === "true";
  const hiddenSkillsStr = settings.find?.((s: any) => s.key === "SKILLS_HIDDEN")?.value ?? "[]";
  const hiddenSkills = JSON.parse(hiddenSkillsStr as string) as string[];

  const setSyncEnabled = useMutation({
    mutationFn: (value: boolean) =>
      api.settings.set("SKILLS_SYNC_PUBLIC", value ? "true" : "false"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const setPrivateMode = useMutation({
    mutationFn: (value: boolean) =>
      api.settings.set("SKILLS_PRIVATE_MODE", value ? "true" : "false"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const hideSkill = useMutation({
    mutationFn: (slug: string) => {
      const updated = [...hiddenSkills, slug];
      return api.settings.set("SKILLS_HIDDEN", JSON.stringify(updated));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const unhideSkill = useMutation({
    mutationFn: (slug: string) => {
      const updated = hiddenSkills.filter((s) => s !== slug);
      return api.settings.set("SKILLS_HIDDEN", JSON.stringify(updated));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="space-y-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30"
      >
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span className="font-semibold text-blue-900 dark:text-blue-100">Skills Privacy Settings</span>
        </div>
        <span className="text-xs px-2 py-1 bg-blue-200 dark:bg-blue-800 rounded text-blue-800 dark:text-blue-200">
          {syncEnabled ? "Public Sync" : "Private Mode"}
        </span>
      </button>

      {expanded && (
        <div className="card p-4 space-y-4 border-l-4 border-blue-500">
          {/* Public Sync Setting */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-medium text-sm">Sync Skills to Public Landing Page</label>
              <button
                onClick={() => setSyncEnabled.mutate(!syncEnabled)}
                disabled={setSyncEnabled.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  syncEnabled
                    ? "bg-green-600"
                    : "bg-gray-300 dark:bg-gray-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    syncEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {syncEnabled
                ? "✓ Your skills are visible on https://ducki-ai-agent.davidduckwitz.de/"
                : "✗ Your skills remain private and won't appear on the public landing page"}
            </p>
          </div>

          {/* Private Mode */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="font-medium text-sm">Private Mode (Hide from Public)</label>
              <button
                onClick={() => setPrivateMode.mutate(!privateMode)}
                disabled={setPrivateMode.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  privateMode
                    ? "bg-red-600"
                    : "bg-gray-300 dark:bg-gray-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    privateMode ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {privateMode
                ? "🔒 Private Mode: Only your personal/sensitive skills are affected. Use 'Hide' below for selective privacy."
                : "🔓 Public Mode: Skills visible based on sync setting above."}
            </p>
          </div>

          {/* Hidden Skills List */}
          {hiddenSkills.length > 0 && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <p className="font-medium text-sm mb-2">
                Hidden Skills ({hiddenSkills.length})
              </p>
              <div className="space-y-1">
                {hiddenSkills.map((slug) => (
                  <div
                    key={slug}
                    className="flex items-center justify-between p-2 bg-gray-100 dark:bg-gray-800 rounded text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <EyeOff className="w-3 h-3 text-gray-500" />
                      <span>{slug}</span>
                    </div>
                    <button
                      onClick={() => unhideSkill.mutate(slug)}
                      disabled={unhideSkill.isPending}
                      className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded"
                    >
                      Unhide
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Privacy Info */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 bg-amber-50 dark:bg-amber-900/20 p-3 rounded">
            <div className="flex gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800 dark:text-amber-200">
                <p className="font-medium mb-1">Privacy Notice:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Disabling sync prevents all skills from appearing on public landing page</li>
                  <li>Hidden skills remain in your system but won't be synchronized</li>
                  <li>Private skills are never uploaded without your explicit permission</li>
                  <li>You can toggle sync anytime - changes apply immediately</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
