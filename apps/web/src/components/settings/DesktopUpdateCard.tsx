import { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getDesktopInfo, isTauriDesktop, setDesktopPreferences, type DesktopInfo, type UpdateInterval } from "../../lib/desktop";
import { installDesktopUpdateNow, runDesktopUpdateCheck, useDesktopUpdate } from "../../lib/desktopUpdate";
import { DESKTOP_PREFS_CHANGED } from "../layout/DesktopUpdateBanner";

/** Settings overview box for the Tauri desktop app: version, manual check, install, schedule. */
export function DesktopUpdateCard() {
  const { language, t } = useI18n();
  const de = language === "de";
  const s = useDesktopUpdate();
  const [info, setInfo] = useState<DesktopInfo | null>(null);

  useEffect(() => {
    if (isTauriDesktop()) void getDesktopInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  if (!isTauriDesktop()) return null;

  async function save(patch: { autoUpdateCheck?: boolean; updateInterval?: UpdateInterval }) {
    const next = await setDesktopPreferences(patch).catch(() => null);
    if (next) {
      setInfo(next);
      window.dispatchEvent(new Event(DESKTOP_PREFS_CHANGED));
    }
  }

  const percent = s.progress?.total ? Math.min(100, Math.round((s.progress.downloaded / s.progress.total) * 100)) : null;
  const lastChecked = s.lastChecked ? new Date(s.lastChecked).toLocaleString(de ? "de-DE" : "en-GB") : null;

  return (
    <div className="card space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{de ? "Updates" : "Updates"}</p>
          <p className="text-sm text-muted-foreground">
            {de ? "Installierte Version" : "Installed version"}: <span className="font-mono">{info?.version ?? "…"}</span>
            {lastChecked ? ` · ${de ? "zuletzt geprüft" : "last checked"}: ${lastChecked}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5 text-xs"
          disabled={s.checking || s.installing}
          onClick={() => void runDesktopUpdateCheck(true)}
        >
          {s.checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {de ? "Auf Update prüfen" : "Check for updates"}
        </button>
      </div>

      {s.update ? (
        <div className="space-y-2 rounded-lg border border-primary/50 bg-primary/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Download className="h-4 w-4 text-primary" />
            {de ? `Version ${s.update.version} ist verfügbar` : `Version ${s.update.version} is available`}
          </p>
          {s.update.notes ? <p className="whitespace-pre-wrap text-muted-foreground">{s.update.notes}</p> : null}
          <p className="text-xs text-muted-foreground">
            {de
              ? "Vor dem Update werden deine Daten gesichert, der Agent wird gestoppt und die App startet danach neu. Laufende Agent-Läufe werden abgebrochen."
              : "Your data is backed up first, the agent is stopped and the app restarts afterwards. Running agent jobs are interrupted."}
          </p>
          {s.installing ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {percent !== null ? `${de ? "Lade herunter" : "Downloading"} … ${percent}%` : de ? "Wird vorbereitet …" : "Preparing …"}
            </p>
          ) : (
            <button type="button" className="btn-primary text-xs" onClick={() => void installDesktopUpdateNow()}>
              {de ? "Update installieren" : "Install update"}
            </button>
          )}
        </div>
      ) : s.upToDate && !s.checking ? (
        <p className="flex items-center gap-2 text-sm text-emerald-500">
          <CheckCircle2 className="h-4 w-4" />
          {de ? "DucKI Node ist auf dem neuesten Stand." : "DucKI Node is up to date."}
        </p>
      ) : null}
      {s.error ? <p className="text-sm text-red-400">{s.error}</p> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <span>{t("setupWizard.desktop.autoUpdateCheck")}</span>
          <input
            type="checkbox"
            checked={info?.autoUpdateCheck ?? false}
            disabled={!info}
            onChange={(e) => void save({ autoUpdateCheck: e.target.checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
          <span>{t("setupWizard.desktop.updateInterval")}</span>
          <select
            className="input w-auto"
            value={info?.updateInterval ?? "off"}
            disabled={!info}
            onChange={(e) => void save({ updateInterval: e.target.value as UpdateInterval })}
          >
            <option value="off">{t("setupWizard.desktop.updateIntervalOff")}</option>
            <option value="hourly">{t("setupWizard.desktop.updateIntervalHourly")}</option>
            <option value="daily">{t("setupWizard.desktop.updateIntervalDaily")}</option>
          </select>
        </label>
      </div>
    </div>
  );
}
