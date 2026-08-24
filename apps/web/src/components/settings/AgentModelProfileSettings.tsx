import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Cpu, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { getApiBaseUrl } from "../../lib/backendUrl";

export type AgentModelProfileName = "legacy" | "small" | "balanced" | "large";
type CurrentProfile = AgentModelProfileName | "custom";

interface ProfileDefinition {
  id: AgentModelProfileName;
  label: string;
  modelHint: string;
  description: string;
  settings: Record<string, string>;
}

interface ProfilesResponse {
  currentProfile: CurrentProfile;
  profiles: ProfileDefinition[];
}

interface ApplyResponse {
  profile: AgentModelProfileName;
  appliedKeys: string[];
  definition: ProfileDefinition;
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  if (body.data === undefined) throw new Error("Unerwartete Antwort vom Settings-Backend");
  return body.data;
}

const PREVIEW_KEYS: Array<{ key: string; label: string }> = [
  { key: "AGENT_MAX_ITERATIONS", label: "Main/Bot Iterationen" },
  { key: "AGENT_MAX_OUTPUT_TOKENS", label: "Max Output Tokens" },
  { key: "AGENT_ENABLE_REFLECTION", label: "Generische Reflection" },
  { key: "AGENT_CHECKLIST_ENABLED", label: "Checkliste" },
  { key: "AGENT_MAX_REPEATED_TOOL_CALL", label: "Gleicher Tool-Call max." },
  { key: "AGENT_CODING_MAX_ITERATIONS", label: "Coding Runtime" },
  { key: "CODING_AGENT_MAX_ATTEMPTS", label: "Coding Attempts" },
  { key: "CODING_AGENT_MAX_ITERATIONS_MEDIUM", label: "Coding mittel" },
];

function displaySetting(value: string | undefined): string {
  if (value === "true") return "An";
  if (value === "false") return "Aus";
  return value ?? "–";
}

export function AgentModelProfileSettings() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<AgentModelProfileName>("legacy");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const profilesQuery = useQuery({
    queryKey: ["agent-model-profiles"],
    queryFn: () => apiRequest<ProfilesResponse>("/settings/model-profile/presets"),
  });

  useEffect(() => {
    const current = profilesQuery.data?.currentProfile;
    if (current && current !== "custom") setSelected(current);
  }, [profilesQuery.data?.currentProfile]);

  const profiles = profilesQuery.data?.profiles ?? [];
  const selectedDefinition = useMemo(
    () => profiles.find((profile) => profile.id === selected),
    [profiles, selected]
  );

  const applyProfile = useMutation({
    mutationFn: (profile: AgentModelProfileName) =>
      apiRequest<ApplyResponse>("/settings/model-profile/apply", {
        method: "POST",
        body: JSON.stringify({ profile }),
      }),
    onSuccess: async (result) => {
      setMessage({ type: "success", text: `${result.definition.label} wurde angewendet.` });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["settings"] }),
        qc.invalidateQueries({ queryKey: ["agent-model-profiles"] }),
      ]);
      setTimeout(() => setMessage(null), 3500);
    },
    onError: (error) => {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Profil konnte nicht angewendet werden.",
      });
    },
  });

  const current = profilesQuery.data?.currentProfile ?? "legacy";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card/50 p-4">
      <div className="flex items-start gap-3">
        <Cpu className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">Modell-Profil</h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              Aktuell: {current === "custom" ? "Benutzerdefiniert" : profiles.find((p) => p.id === current)?.label ?? current}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Optimiert Laufzeit, Reflection, Checkliste, Loop-Schutz und Coding-Budgets für die Modellgröße.
            Bereits einzeln gesetzte Werte können nach dem Anwenden wieder feinjustiert werden.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {profiles.map((profile) => {
          const active = selected === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => setSelected(profile.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-accent"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{profile.label}</span>
                {active ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
              </div>
              <p className="mt-1 text-[11px] font-medium text-muted-foreground">{profile.modelHint}</p>
            </button>
          );
        })}
      </div>

      {selectedDefinition ? (
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          <div className="flex items-start gap-2">
            <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{selectedDefinition.description}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PREVIEW_KEYS.map(({ key, label }) => (
              <div key={key} className="rounded-md bg-muted/50 p-2">
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="mt-0.5 text-sm font-medium tabular-nums">
                  {displaySetting(selectedDefinition.settings[key])}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <div>
          <p className="font-medium text-emerald-700 dark:text-emerald-400">Capabilities bleiben unverändert</p>
          <p className="mt-1 text-muted-foreground">
            Profile ändern weder Vision noch Skill-Auto-Detection, Plugin-/Tool-Aktivierung, Bot-Whitelists,
            Connectoren noch Handoff-/Worker-Übertragungen. Diese Grenze wird zusätzlich in CI getestet.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {current === "custom"
            ? "Einzelne Tuning-Werte wurden manuell angepasst. Anwenden eines Profils überschreibt nur dessen Tuning-Felder."
            : "Das Profil wird als persistierte Runtime-Settings angewendet und gilt für neue Agent-Läufe ohne Server-Neustart."}
        </p>
        <button
          type="button"
          className="btn-primary"
          disabled={applyProfile.isPending || profilesQuery.isLoading || !selectedDefinition}
          onClick={() => applyProfile.mutate(selected)}
        >
          {applyProfile.isPending ? "Wird angewendet…" : "Profil anwenden"}
        </button>
      </div>

      {profilesQuery.isError ? (
        <p className="text-xs text-destructive">Modell-Profile konnten nicht geladen werden.</p>
      ) : null}
      {message ? (
        <p className={`text-xs ${message.type === "success" ? "text-emerald-600" : "text-destructive"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
