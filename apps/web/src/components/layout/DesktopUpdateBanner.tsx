import { useEffect } from "react";
import { Download, Loader2, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getDesktopInfo, isTauriDesktop, type UpdateInterval } from "../../lib/desktop";
import {
  dismissDesktopUpdate,
  getLastChecked,
  installDesktopUpdateNow,
  runDesktopUpdateCheck,
  useDesktopUpdate,
} from "../../lib/desktopUpdate";

const STARTUP_CHECK_DELAY_MS = 8000;
const TICK_MS = 60_000;
const INTERVAL_MS: Record<UpdateInterval, number> = { off: 0, hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000 };

/** Window event the settings UI fires after saving desktop prefs, so the schedule re-reads them. */
export const DESKTOP_PREFS_CHANGED = "ducki:desktop-prefs-changed";

/**
 * Update banner of the Tauri desktop shell (the git-based `UpdateStatusBar` is for source installs).
 * Also runs the schedule: a check shortly after startup (if enabled), then periodically
 * (hourly/daily) while the app runs - the webview keeps running in the tray.
 * Installing always needs a click: the shell backs up data and restarts the app.
 */
export function DesktopUpdateBanner({ busy }: { busy: boolean }) {
  const { language } = useI18n();
  const de = language === "de";
  const s = useDesktopUpdate();

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let interval: UpdateInterval = "off";
    let startupTimer: number | undefined;
    let first = true;

    const loadPrefs = async () => {
      const info = await getDesktopInfo().catch(() => null);
      interval = info?.updateInterval ?? "off";
      if (first) {
        first = false;
        if (info?.autoUpdateCheck !== false) {
          startupTimer = window.setTimeout(() => void runDesktopUpdateCheck(false), STARTUP_CHECK_DELAY_MS);
        }
      }
    };
    void loadPrefs();

    const tick = window.setInterval(() => {
      const period = INTERVAL_MS[interval];
      if (!period) return;
      const last = getLastChecked();
      if (last === null || Date.now() - last >= period) void runDesktopUpdateCheck(false);
    }, TICK_MS);

    const manual = () => void runDesktopUpdateCheck(true);
    window.addEventListener("ducki:check-update", manual);
    window.addEventListener(DESKTOP_PREFS_CHANGED, loadPrefs);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(tick);
      window.removeEventListener("ducki:check-update", manual);
      window.removeEventListener(DESKTOP_PREFS_CHANGED, loadPrefs);
    };
  }, []);

  const showUpdate = s.update !== null && (!s.dismissed || s.installing);
  // Tray/menu "Nach Updates suchen" gives feedback here; the settings card has its own status.
  const note = !s.update && !s.checking && s.error ? s.error : null;
  if (!showUpdate && !note) return null;

  const percent = s.progress?.total ? Math.min(100, Math.round((s.progress.downloaded / s.progress.total) * 100)) : null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-card px-4 py-2 text-sm">
      {showUpdate && s.update ? (
        <>
          <Download className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {de ? `Neue Version ${s.update.version} verfügbar` : `New version ${s.update.version} available`}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {de ? "installiert:" : "installed:"} {s.update.currentVersion}
              </span>
            </div>
            {s.update.notes ? <div className="truncate text-xs text-muted-foreground">{s.update.notes}</div> : null}
            {s.installing ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {percent !== null
                  ? `${de ? "Lade herunter" : "Downloading"} … ${percent}%`
                  : de
                    ? "Wird vorbereitet … Die App startet danach neu."
                    : "Preparing … the app restarts afterwards."}
              </div>
            ) : busy ? (
              <div className="mt-1 text-xs text-amber-500">
                {de ? "Ein Agent-Lauf ist aktiv – er wird beim Update abgebrochen." : "An agent run is active – it will be interrupted by the update."}
              </div>
            ) : null}
            {s.error ? <div className="mt-1 text-xs text-red-400">{s.error}</div> : null}
          </div>
          {s.installing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <button
                type="button"
                onClick={() => void installDesktopUpdateNow()}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                {de ? "Jetzt aktualisieren" : "Update now"}
              </button>
              <button type="button" onClick={dismissDesktopUpdate} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </>
          )}
        </>
      ) : (
        <span className="flex-1 text-red-400">{note}</span>
      )}
    </div>
  );
}
