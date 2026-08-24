import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { ShieldCheck, ShieldAlert, BookOpen, X } from "lucide-react";
import { useState } from "react";

/** Persistent dismiss key per project root — stored in localStorage so the
 *  banner stays hidden across sessions even when the user hasn't trusted. */
function dismissKey(projectRoot: string): string {
  return `project-skills-banner-dismissed:${projectRoot}`;
}

function isDismissed(projectRoot: string): boolean {
  try {
    return localStorage.getItem(dismissKey(projectRoot)) === "1";
  } catch {
    return false;
  }
}

function setDismissed(projectRoot: string): void {
  try {
    localStorage.setItem(dismissKey(projectRoot), "1");
  } catch { /* ignore */ }
}

export function ProjectSkillsBanner() {
  const qc = useQueryClient();
  const [dismissedByUser, setDismissedByUser] = useState(false);

  const skillsQuery = useQuery({
    queryKey: ["projectSkills"],
    queryFn: () => api.projectSkills.get(),
    staleTime: 60_000, // re-check every minute
    retry: false,
  });

  const trustMutation = useMutation({
    mutationFn: () => api.projectSkills.trust(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectSkills"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const data = skillsQuery.data;

  // Nothing to show: no git repo, or already trusted, or already dismissed.
  if (!data?.projectRoot) return null;
  if (data.trusted && data.skills.length === 0) return null;
  if (dismissedByUser || isDismissed(data.projectRoot)) return null;

  // Already trusted — no action needed, just nothing to show.
  if (data.trusted) return null;

  // Error fetching: show nothing (graceful degradation).
  if (skillsQuery.isError && !skillsQuery.data) return null;

  // Still loading: show a subtle placeholder so the UI doesn't jump later.
  if (skillsQuery.isLoading) return null;

  const skillCount = data.skills.length;

  return (
    <div className="shrink-0 border-b border-amber-800/30 bg-amber-950/30 px-4 py-2.5">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
        {/* Icon: either shield (untrusted) or book (trusted, but no skills loaded yet) */}
        <div className="shrink-0">
          <ShieldAlert className="h-5 w-5 text-amber-400" />
        </div>

        {/* Message */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-200">
            {skillCount > 0
              ? `${skillCount} project skill${skillCount !== 1 ? "s" : ""} gefunden`
              : "Project skills verfügbar"}
          </p>
          <p className="text-xs text-amber-400/80">
            In <code className="rounded bg-amber-950/50 px-1 text-[11px]">{data.projectRoot}</code>
            {skillCount > 0
              ? ` — ${data.skills.map((s) => s.slug).join(", ")}`
              : ""}
          </p>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => trustMutation.mutate()}
            disabled={trustMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:opacity-60"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {trustMutation.isPending ? "Vertraue…" : "Vertrauen & Laden"}
          </button>

          <button
            onClick={() => {
              if (data.projectRoot) {
                setDismissed(data.projectRoot);
                setDismissedByUser(true);
              }
            }}
            className="rounded p-1 text-amber-500/70 transition hover:bg-amber-950/50 hover:text-amber-300"
            title="Ausblenden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Trusted confirmation (shown briefly after trusting) */}
      {trustMutation.isSuccess && (
        <div className="mx-auto mt-2 flex w-full max-w-4xl items-center gap-2 rounded-md bg-green-950/40 px-3 py-1.5">
          <BookOpen className="h-3.5 w-3.5 text-green-400" />
          <p className="text-xs text-green-300">
            {trustMutation.data.skills.length > 0
              ? `${trustMutation.data.skills.length} project skill(s) aktiviert. Sie erscheinen jetzt im Chat und unter /skills.`
              : "Project-Skills aktiviert. Lege Skills in .agents/skills/ oder .hermes/skills/ ab."}
          </p>
        </div>
      )}
    </div>
  );
}