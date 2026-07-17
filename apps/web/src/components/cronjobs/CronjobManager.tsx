import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Play, Trash2, Plus, Save, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";

type CronTargetType = "task" | "prompt" | "tool" | "skill";

interface CronJob {
  id: number;
  name: string;
  schedule: string;
  targetType: CronTargetType;
  targetRef?: string | null;
  payload?: string | null;
  enabled: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastResult?: string | null;
}

interface Task {
  id: number;
  title: string;
}

interface ToolDef {
  name: string;
  description: string;
}

interface SkillDef {
  slug: string;
  name: string;
}

interface FormState {
  id?: number;
  name: string;
  schedule: string;
  targetType: CronTargetType;
  targetRef: string;
  enabled: boolean;
  promptText: string;
  toolInputJson: string;
}

const EXAMPLES = [
  "*/5 * * * *  (alle 5 Minuten)",
  "0 9 * * 1-5  (werktags 09:00)",
  "30 18 * * *  (taeglich 18:30)",
];

function safeParsePayload(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toLocalDateTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function buildFormFromJob(job: CronJob): FormState {
  const payload = safeParsePayload(job.payload);
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    targetType: job.targetType,
    targetRef: job.targetRef ?? "",
    enabled: job.enabled === 1,
    promptText: String(payload["prompt"] ?? ""),
    toolInputJson: JSON.stringify(payload["input"] ?? {}, null, 2),
  };
}

export function CronjobManager() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>({
    name: "",
    schedule: "*/15 * * * *",
    targetType: "prompt",
    targetRef: "",
    enabled: true,
    promptText: "",
    toolInputJson: "{}",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: ["cronjobs"],
    queryFn: () => api.cronjobs.list() as Promise<CronJob[]>,
    refetchInterval: 5000,
  });

  const tasksQuery = useQuery({
    queryKey: ["tasks", "cronjobs"],
    queryFn: () => api.tasks.list() as Promise<Task[]>,
  });

  const toolsQuery = useQuery({
    queryKey: ["tools", "cronjobs"],
    queryFn: () => api.tools.list() as Promise<ToolDef[]>,
  });

  const skillsQuery = useQuery({
    queryKey: ["skills", "cronjobs"],
    queryFn: () => api.skills.list() as Promise<SkillDef[]>,
  });

  const createJob = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.cronjobs.create(payload as never),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cronjobs"] });
      resetForm();
    },
  });

  const updateJob = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) => api.cronjobs.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cronjobs"] });
      resetForm();
    },
  });

  const deleteJob = useMutation({
    mutationFn: (id: number) => api.cronjobs.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cronjobs"] }),
  });

  const runJob = useMutation({
    mutationFn: (id: number) => api.cronjobs.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cronjobs"] }),
  });

  const sortedJobs = useMemo(
    () => [...(jobsQuery.data ?? [])].sort((a, b) => Number(b.id) - Number(a.id)),
    [jobsQuery.data]
  );

  const resetForm = () => {
    setForm({
      name: "",
      schedule: "*/15 * * * *",
      targetType: "prompt",
      targetRef: "",
      enabled: true,
      promptText: "",
      toolInputJson: "{}",
    });
    setFormError(null);
  };

  const payloadForSubmit = (): { targetRef?: string; payload?: Record<string, unknown> } => {
    if (form.targetType === "prompt") {
      if (!form.promptText.trim()) throw new Error("Prompt text is required for prompt cronjobs");
      return { payload: { prompt: form.promptText.trim() } };
    }

    if (form.targetType === "task") {
      if (!form.targetRef.trim()) throw new Error("Select a task for task cronjobs");
      return { targetRef: form.targetRef.trim() };
    }

    if (form.targetType === "skill") {
      if (!form.targetRef.trim()) throw new Error("Select a skill for skill cronjobs");
      return {
        targetRef: form.targetRef.trim(),
        payload: form.promptText.trim() ? { prompt: form.promptText.trim() } : undefined,
      };
    }

    if (!form.targetRef.trim()) throw new Error("Select a tool for tool cronjobs");
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(form.toolInputJson || "{}");
      if (parsed && typeof parsed === "object") {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error("Tool input must be valid JSON");
    }

    return { targetRef: form.targetRef.trim(), payload: { input } };
  };

  const submit = () => {
    setFormError(null);
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      if (!form.schedule.trim()) throw new Error("Schedule is required");

      const extra = payloadForSubmit();
      const basePayload = {
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        targetType: form.targetType,
        enabled: form.enabled,
        targetRef: extra.targetRef,
        payload: extra.payload,
      };

      if (form.id) {
        updateJob.mutate({ id: form.id, payload: basePayload });
      } else {
        createJob.mutate(basePayload);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarClock className="w-6 h-6 text-cyan-400" />
            Cronjobs
          </h1>
          <p className="text-sm text-gray-400">Schedule Tasks, Prompts, Tools, and Skills with cron syntax.</p>
        </div>
        <button onClick={() => jobsQuery.refetch()} className="btn-secondary inline-flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <section className="card xl:col-span-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{form.id ? `Cronjob #${form.id} bearbeiten` : "Neuer Cronjob"}</h2>
            {form.id && (
              <button onClick={resetForm} className="text-xs text-gray-400 hover:text-gray-200">Neu statt Bearbeiten</button>
            )}
          </div>

          <input
            className="input w-full"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />

          <input
            className="input w-full"
            placeholder="Cron expression"
            value={form.schedule}
            onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
          />
          <div className="text-xs text-gray-500 space-y-1">
            {EXAMPLES.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>

          <select
            className="input w-full"
            value={form.targetType}
            onChange={(e) => setForm((f) => ({ ...f, targetType: e.target.value as CronTargetType, targetRef: "" }))}
          >
            <option value="prompt">Prompt</option>
            <option value="task">Task</option>
            <option value="tool">Tool</option>
            <option value="skill">Skill</option>
          </select>

          {form.targetType === "task" && (
            <select
              className="input w-full"
              value={form.targetRef}
              onChange={(e) => setForm((f) => ({ ...f, targetRef: e.target.value }))}
            >
              <option value="">Task auswaehlen</option>
              {(tasksQuery.data ?? []).map((task) => (
                <option key={task.id} value={String(task.id)}>{`#${task.id} ${task.title}`}</option>
              ))}
            </select>
          )}

          {form.targetType === "tool" && (
            <>
              <select
                className="input w-full"
                value={form.targetRef}
                onChange={(e) => setForm((f) => ({ ...f, targetRef: e.target.value }))}
              >
                <option value="">Tool auswaehlen</option>
                {(toolsQuery.data ?? []).map((tool) => (
                  <option key={tool.name} value={tool.name}>{tool.name}</option>
                ))}
              </select>
              <textarea
                className="input w-full min-h-[140px] font-mono text-xs"
                placeholder='{"path":"/health"}'
                value={form.toolInputJson}
                onChange={(e) => setForm((f) => ({ ...f, toolInputJson: e.target.value }))}
              />
            </>
          )}

          {form.targetType === "skill" && (
            <>
              <select
                className="input w-full"
                value={form.targetRef}
                onChange={(e) => setForm((f) => ({ ...f, targetRef: e.target.value }))}
              >
                <option value="">Skill auswaehlen</option>
                {(skillsQuery.data ?? []).map((skill) => (
                  <option key={skill.slug} value={skill.slug}>{skill.slug}</option>
                ))}
              </select>
              <textarea
                className="input w-full min-h-[96px]"
                placeholder="Optionaler Prompt fuer Skill-Run"
                value={form.promptText}
                onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
              />
            </>
          )}

          {form.targetType === "prompt" && (
            <textarea
              className="input w-full min-h-[120px]"
              placeholder="Prompt text"
              value={form.promptText}
              onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
            />
          )}

          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Aktiv
          </label>

          {formError && <p className="text-sm text-red-300">{formError}</p>}

          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={createJob.isPending || updateJob.isPending}
              className="btn-primary inline-flex items-center gap-2"
            >
              {form.id ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {form.id ? "Speichern" : "Erstellen"}
            </button>
            <button onClick={resetForm} className="btn-secondary">Reset</button>
          </div>
        </section>

        <section className="xl:col-span-2 card">
          <h2 className="font-semibold mb-3">Geplante Jobs</h2>
          <div className="space-y-2">
            {sortedJobs.length === 0 && <p className="text-sm text-gray-400">Keine Cronjobs angelegt.</p>}
            {sortedJobs.map((job) => (
              <article key={job.id} className="rounded-lg border border-gray-800 bg-gray-950/70 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm">{job.name}</p>
                    <p className="text-xs text-gray-400">#{job.id} | {job.schedule}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border ${job.enabled ? "border-green-500/50 text-green-300" : "border-gray-600 text-gray-400"}`}>
                    {job.enabled ? "aktiv" : "deaktiviert"}
                  </span>
                </div>

                <div className="text-xs text-gray-300 grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>Target: {job.targetType}{job.targetRef ? ` (${job.targetRef})` : ""}</div>
                  <div>Next: {toLocalDateTime(job.nextRunAt)}</div>
                  <div>Last: {toLocalDateTime(job.lastRunAt)}</div>
                  <div>Status: {job.lastStatus ?? "-"}</div>
                </div>

                {job.lastError && <p className="text-xs text-red-300">Error: {job.lastError}</p>}
                {job.lastResult && <p className="text-xs text-gray-400 line-clamp-2">Result: {job.lastResult}</p>}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => setForm(buildFormFromJob(job))}
                    className="btn-secondary text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => runJob.mutate(job.id)}
                    className="btn-secondary inline-flex items-center gap-1 text-xs"
                    disabled={runJob.isPending}
                  >
                    <Play className="w-3.5 h-3.5" />
                    Run now
                  </button>
                  <button
                    onClick={() =>
                      updateJob.mutate({
                        id: job.id,
                        payload: { enabled: job.enabled !== 1 },
                      })
                    }
                    className="btn-secondary text-xs"
                  >
                    {job.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => deleteJob.mutate(job.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600/20 text-red-300 hover:bg-red-600/30 text-xs"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
