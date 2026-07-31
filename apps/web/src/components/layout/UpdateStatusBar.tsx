import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, X } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

/**
 * Bottom status strip. It used to be `fixed left-56`, which hard-wired the sidebar
 * width into the shell; it now lives inside the content column instead.
 */
export function UpdateStatusBar() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const updateStatus = useQuery({
    queryKey: ["updates", "status"],
    queryFn: () => api.updates.status(),
    refetchInterval: (query) => (query.state.data?.updating ? 1000 : 5000),
  });

  const checkUpdates = useMutation({
    mutationFn: () => api.updates.check(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["updates", "status"] });
    },
  });

  const startUpdate = useMutation({
    mutationFn: () => api.updates.start(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["updates", "status"] });
    },
  });

  const updateAvailable = Boolean(updateStatus.data?.updateAvailable);
  const updating = Boolean(updateStatus.data?.updating);
  const checking = Boolean(updateStatus.data?.checking);
  const currentCommitShort = updateStatus.data?.currentCommit?.slice(0, 8) ?? "-";
  const remoteCommitShort = updateStatus.data?.remoteCommit?.slice(0, 8) ?? "-";
  const updateError = updateStatus.data?.lastUpdateError ?? updateStatus.data?.lastCheckError;

  return (
    <>
      <footer className="z-30 flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-card/95 px-3 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5 truncate">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${updateAvailable ? "bg-amber-400" : "bg-green-500"}`} />
            Update: {updateAvailable ? t("layout.updateAvailable") : t("layout.updateCurrent")}
          </span>
          <span className="hidden truncate text-muted-foreground/70 sm:inline">
            {currentCommitShort} {"->"} {remoteCommitShort}
          </span>
          {checking && <span className="text-blue-400">{t("layout.checking")}</span>}
          {updating && <span className="text-amber-400">{t("layout.updating")}</span>}
          {updateError && <span className="max-w-[42rem] truncate text-red-400">{updateError}</span>}
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 transition hover:border-foreground/40 hover:bg-accent"
        >
          <Download className="h-3 w-3" />
          {t("layout.updateButton")}
        </button>
      </footer>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 md:items-center md:p-6">
          <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">{t("layout.repositoryUpdate")}</h3>
              <button onClick={() => setModalOpen(false)} className="rounded p-1 hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 px-4 py-3 text-sm">
              <div className="grid-auto-sm text-xs">
                <div className="rounded border border-border bg-background/60 p-2">
                  <div className="text-muted-foreground">{t("layout.repo")}</div>
                  <div className="break-all text-foreground">{updateStatus.data?.repoUrl ?? "-"}</div>
                </div>
                <div className="rounded border border-border bg-background/60 p-2">
                  <div className="text-muted-foreground">{t("layout.branch")}</div>
                  <div className="text-foreground">{updateStatus.data?.branch ?? "-"}</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={`rounded border px-2 py-0.5 ${
                    updateAvailable ? "border-amber-500/50 text-amber-400" : "border-green-500/50 text-green-500"
                  }`}
                >
                  {updateAvailable ? t("layout.newCommitAvailable") : t("layout.upToDate")}
                </span>
                <span className="text-muted-foreground">
                  {t("layout.local")}: {currentCommitShort}
                </span>
                <span className="text-muted-foreground">
                  {t("layout.remote")}: {remoteCommitShort}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => checkUpdates.mutate()}
                  disabled={checking || updating || checkUpdates.isPending}
                  className="btn-secondary inline-flex items-center gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
                  {t("layout.checkNow")}
                </button>
                <button
                  onClick={() => startUpdate.mutate()}
                  disabled={updating || startUpdate.isPending || checking || !updateAvailable}
                  className="btn-primary inline-flex items-center gap-2"
                >
                  <Download className={`h-4 w-4 ${updating ? "animate-bounce" : ""}`} />
                  {t("layout.startUpdate")}
                </button>
              </div>

              <div className="rounded border border-border bg-background/70 p-2">
                <div className="mb-1 text-xs text-muted-foreground">{t("layout.liveOutput")}</div>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap text-[11px] leading-4 text-foreground">
                  {(updateStatus.data?.lastUpdateOutput?.length ?? 0) > 0
                    ? updateStatus.data?.lastUpdateOutput?.join("\n")
                    : t("layout.noUpdateOutput")}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
