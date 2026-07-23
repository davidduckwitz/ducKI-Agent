import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useCodingSession } from "../../lib/codingSessionStore";

interface CodingProject {
  slug: string;
  name: string;
}

interface CodingFileItem {
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt?: string;
}

export function CodingSidebarPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { selectedProject, setSelectedProject, selectedPath, setSelectedPath } = useCodingSession();
  const [newFilePath, setNewFilePath] = useState("");

  const settingsQuery = useQuery({
    queryKey: ["settings", "coding-sidebar"],
    queryFn: () => api.settings.list() as Promise<Array<{ key: string; value: string }>>,
    refetchInterval: 5000,
  });
  const codingEnabled = String(settingsQuery.data?.find((s) => s.key === "CODING_ENABLED")?.value ?? "false").trim().toLowerCase() === "true";
  const codingSettingReady = !settingsQuery.isLoading && Boolean(settingsQuery.data);

  const projectsQuery = useQuery({
    queryKey: ["coding", "projects"],
    queryFn: () => api.coding.listProjects() as Promise<CodingProject[]>,
    enabled: codingSettingReady && codingEnabled,
  });

  useEffect(() => {
    if (!codingSettingReady || !codingEnabled) return;
    if (!selectedProject && (projectsQuery.data?.length ?? 0) > 0) {
      setSelectedProject(projectsQuery.data?.[0]?.slug ?? "");
    }
    if (selectedProject && !(projectsQuery.data ?? []).some((p) => p.slug === selectedProject)) {
      setSelectedProject(projectsQuery.data?.[0]?.slug ?? "");
    }
  }, [codingSettingReady, codingEnabled, projectsQuery.data, selectedProject, setSelectedProject]);

  const filesQuery = useQuery({
    queryKey: ["coding", "files", selectedProject],
    queryFn: () => api.coding.listFiles(selectedProject) as Promise<{ project: string; files: CodingFileItem[] }>,
    enabled: codingSettingReady && codingEnabled && Boolean(selectedProject),
  });

  const sortedFiles = useMemo(() => {
    const list = [...(filesQuery.data?.files ?? [])];
    return list.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }, [filesQuery.data?.files]);

  const writeFile = useMutation({
    mutationFn: (payload: { path: string; content: string }) => api.coding.writeFile(selectedProject, payload.path, payload.content),
    onSuccess: async (_data, vars) => {
      setSelectedPath(vars.path);
      setNewFilePath("");
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
    },
  });

  if (!codingSettingReady || !codingEnabled) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col p-2 gap-3 overflow-y-auto">
      <div className="space-y-1.5">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {t("codingPage.project")}
        </p>
        <select
          className="input w-full text-sm"
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
        >
          {(projectsQuery.data ?? []).length === 0 && <option value="">{t("codingPage.noProjects")}</option>}
          {(projectsQuery.data ?? []).map((project) => (
            <option key={project.slug} value={project.slug}>
              {project.slug}
            </option>
          ))}
        </select>
      </div>

      {selectedProject ? (
        <>
          <div className="space-y-1.5">
            <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t("codingPage.newFilePath")}
            </p>
            <div className="flex gap-1.5">
              <input
                className="input flex-1 text-sm"
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                placeholder={t("codingPage.newFilePath")}
              />
              <button
                className="btn-secondary px-2"
                onClick={() => writeFile.mutate({ path: newFilePath, content: "" })}
                disabled={!newFilePath.trim() || writeFile.isPending}
                title={t("common.create")}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto space-y-1">
            {sortedFiles.map((file) =>
              file.type === "directory" ? (
                <div
                  key={file.path}
                  className="w-full text-left rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 opacity-80"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="truncate text-xs">{file.path}</span>
                  </span>
                </div>
              ) : (
                <button
                  key={file.path}
                  onClick={() => setSelectedPath(file.path)}
                  className={`w-full text-left rounded-lg border px-2.5 py-1.5 transition ${
                    selectedPath === file.path
                      ? "border-primary bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-accent"
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span className="truncate text-xs">{file.path}</span>
                  </span>
                </button>
              )
            )}
          </div>
        </>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">{t("codingPage.noProjects")}</p>
      )}
    </div>
  );
}
