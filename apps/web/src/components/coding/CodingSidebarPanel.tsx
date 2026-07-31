import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerQuery } from "../../lib/useServerQuery";
import { useSettings, readFlag, settingsReady } from "../../lib/useSettings";
import { Check, FolderPlus, Search, Upload, X } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useCodingSession } from "../../lib/codingSessionStore";
import { useUiStore } from "../../lib/uiStore";
import { CollapsibleSection } from "../ui/collapsible-section";
import { CodingFileTree, type CodingFileItem } from "./CodingFileTree";

interface CodingProject {
  slug: string;
  name: string;
}

export function CodingSidebarPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const {
    selectedProject,
    setSelectedProject,
    selectedPath,
    openFile,
    drafts,
    command,
    runCommand,
  } = useCodingSession();
  const { filesOpen, toggleSection, setSection } = useUiStore();

  const [filter, setFilter] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const newFileRef = useRef<HTMLInputElement>(null);
  // See CodingWorkspace: -1 so a command dispatched right before mount still lands.
  const handledCommandNonce = useRef(-1);

  const settingsQuery = useSettings();
  const codingEnabled = readFlag(settingsQuery.data, "CODING_ENABLED");
  const codingSettingReady = settingsReady(settingsQuery);

  const projectsQuery = useServerQuery({
    queryKey: ["coding", "projects"],
    queryFn: () => api.coding.listProjects() as Promise<CodingProject[]>,
    enabled: codingSettingReady && codingEnabled,
  });

  useEffect(() => {
    if (!codingSettingReady || !codingEnabled) return;
    const projects = projectsQuery.data ?? [];
    if (projects.length === 0) return;
    if (!selectedProject || !projects.some((p) => p.slug === selectedProject)) {
      setSelectedProject(projects[0]?.slug ?? "");
    }
  }, [codingSettingReady, codingEnabled, projectsQuery.data, selectedProject, setSelectedProject]);

  const filesQuery = useServerQuery({
    queryKey: ["coding", "files", selectedProject],
    queryFn: () => api.coding.listFiles(selectedProject) as Promise<{ project: string; files: CodingFileItem[] }>,
    enabled: codingSettingReady && codingEnabled && Boolean(selectedProject),
  });

  const writeFile = useMutation({
    mutationFn: (payload: { path: string; content: string }) =>
      api.coding.writeFile(selectedProject, payload.path, payload.content),
    onSuccess: async (_data, vars) => {
      openFile(vars.path);
      setNewFilePath("");
      setNewFileOpen(false);
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
    },
  });

  // "Neue Datei" from the sidebar's Neu-menu opens and focuses the inline input.
  useEffect(() => {
    if (command.nonce === handledCommandNonce.current) return;
    handledCommandNonce.current = command.nonce;
    if (command.action !== "new-file") return;
    setSection("files", true);
    setNewFileOpen(true);
    window.setTimeout(() => newFileRef.current?.focus(), 0);
  }, [command, setSection]);

  const dirtyPaths = useMemo(() => new Set(Object.keys(drafts)), [drafts]);
  const files = filesQuery.data?.files ?? [];

  if (!codingSettingReady || !codingEnabled) return null;

  const submitNewFile = () => {
    const path = newFilePath.trim();
    if (!path) return;
    writeFile.mutate({ path, content: "" });
  };

  return (
    <CollapsibleSection
      title={t("layout.sidebar.files")}
      open={filesOpen}
      onToggle={() => toggleSection("files")}
      count={files.filter((f) => f.type === "file").length}
      bodyClassName="flex flex-col gap-1.5 px-1 pb-2"
      actions={
        <>
          <button
            type="button"
            onClick={() => runCommand("new-project")}
            title={t("codingPage.newProject")}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => runCommand("upload")}
            title={t("codingPage.uploadTitle")}
            disabled={!selectedProject}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
        </>
      }
    >
      <select
        className="input w-full px-2 py-1 text-xs"
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

      {selectedProject && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              className="input w-full py-1 pl-7 pr-6 text-xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("codingPage.searchFiles")}
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {newFileOpen && (
            <div className="flex gap-1">
              <input
                ref={newFileRef}
                className="input w-full py-1 text-xs"
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewFile();
                  if (e.key === "Escape") setNewFileOpen(false);
                }}
                placeholder={t("codingPage.newFilePath")}
              />
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-1.5 text-primary transition hover:bg-accent disabled:opacity-40"
                onClick={submitNewFile}
                disabled={!newFilePath.trim() || writeFile.isPending}
                title={t("common.create")}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-1.5 text-muted-foreground transition hover:bg-accent"
                onClick={() => setNewFileOpen(false)}
                title={t("common.cancel")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Capped instead of flex-1: the sidebar column scrolls as a whole, and a
              flexible tree would collapse to a few rows once the chat list is open. */}
          <div className="max-h-[45vh] min-h-[140px] overflow-y-auto">
            <CodingFileTree
              files={files}
              project={selectedProject}
              selectedPath={selectedPath}
              dirtyPaths={dirtyPaths}
              filter={filter}
              onSelect={openFile}
              onFolderAction={(folderPath) => {
                setNewFilePath(`${folderPath}/`);
                setNewFileOpen(true);
                window.setTimeout(() => newFileRef.current?.focus(), 0);
              }}
              emptyLabel={t("codingPage.noFiles")}
              noMatchLabel={t("codingPage.noMatchingFiles")}
            />
          </div>

          {!newFileOpen && (
            <button
              type="button"
              onClick={() => {
                setNewFileOpen(true);
                window.setTimeout(() => newFileRef.current?.focus(), 0);
              }}
              className="rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
            >
              + {t("codingPage.newFileHere")}
            </button>
          )}
        </>
      )}

      {!selectedProject && <p className="px-1 text-[11px] text-muted-foreground">{t("codingPage.noProjects")}</p>}
    </CollapsibleSection>
  );
}
