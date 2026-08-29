import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type PluginInfo, type PluginWidgetSpec, type PluginBuilderDraft } from "../../lib/api";
import { pluginUiUrl } from "../../lib/backendUrl";
import { toastManager as toast } from "../../lib/toast";
import { useAppStore } from "../../lib/store";
import { CreatePluginWizardModal } from "./CreatePluginWizardModal";

/** Public plugin catalog API (filterable via ?search= / ?category=). */
const CATALOG_API = "https://ducki.cloud/api/v1";

interface CatalogEntry {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  source_url?: string;
}

export function PluginsPage() {
  const [tab, setTab] = useState<"installed" | "catalog">("installed");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState("");
  // Name of the plugin whose iframe settings page is currently expanded (Phase 3), or null.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [widgetsFor, setWidgetsFor] = useState<string | null>(null);
  const [widgetDrafts, setWidgetDrafts] = useState<Record<string, PluginWidgetSpec[]>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [resumeRun, setResumeRun] = useState<{ name: string; runId: string } | null>(null);
  const [drafts, setDrafts] = useState<PluginBuilderDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const socket = useAppStore((s) => s.socket);

  const refreshDrafts = useCallback(async () => {
    setDraftsLoading(true);
    try {
      setDrafts(await api.plugins.listDrafts());
    } catch {
      // Best-effort - a broken drafts listing shouldn't block the rest of the page.
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPlugins(await api.plugins.list());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Plugins konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  // The installed-plugin list is cached server-side (only refreshed on enable/disable/install
  // through this API) so a plugin folder dropped directly onto disk stays invisible without
  // this: a fresh re-scan when the page is opened, so newly added plugins show up without a
  // server restart.
  const reload = useCallback(async (silent: boolean) => {
    setReloading(true);
    try {
      await api.plugins.reload();
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["plugins"] });
      if (!silent) toast.success("Plugin-Liste aktualisiert");
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : "Aktualisieren fehlgeschlagen");
    } finally {
      setReloading(false);
    }
  }, [refresh, queryClient]);

  useEffect(() => {
    void reload(true);
    void refreshDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A builder run's terminal state (success/fail/stop) is only pushed over the socket while
  // the wizard modal that started it is mounted and listening - refresh the drafts list here too
  // so a run that finishes after the modal was closed ("im Hintergrund weiterlaufen lassen")
  // still updates status/removes itself from "Unfertige Entwürfe" without a manual reload.
  useEffect(() => {
    if (!socket) return;
    const handleComplete = () => { void refreshDrafts(); if (tab === "installed") void refresh(); };
    socket.on("plugin_create_complete", handleComplete);
    return () => { socket.off("plugin_create_complete", handleComplete); };
  }, [socket, refreshDrafts, refresh, tab]);

  const resumeDraft = async (draft: PluginBuilderDraft) => {
    setDraftBusy(draft.name);
    try {
      const res = await api.plugins.resumeRun(draft.name);
      setResumeRun({ name: draft.name, runId: res.runId });
      setCreateOpen(true);
      void refreshDrafts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fortsetzen fehlgeschlagen");
    } finally {
      setDraftBusy(null);
    }
  };

  const deleteDraft = async (draft: PluginBuilderDraft) => {
    setDraftBusy(draft.name);
    try {
      await api.plugins.deleteDraft(draft.name);
      setDrafts((current) => current.filter((d) => d.name !== draft.name));
      toast.success(`Entwurf "${draft.name}" gelöscht`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen");
    } finally {
      setDraftBusy(null);
    }
  };

  // Catalog is fetched server-side filtered (?search=) with a small debounce so typing
  // doesn't hammer the endpoint. Re-runs whenever the search term changes on the catalog tab.
  useEffect(() => {
    if (tab !== "catalog") return;
    const handle = setTimeout(() => {
      void (async () => {
        setCatalogLoading(true);
        setCatalogError(null);
        try {
          const url = `${CATALOG_API}?action=plugins${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as { data?: { plugins?: CatalogEntry[] }; plugins?: CatalogEntry[] };
          setCatalog(json.data?.plugins ?? json.plugins ?? []);
        } catch (e) {
          setCatalogError(e instanceof Error ? e.message : "Katalog nicht erreichbar");
          setCatalog([]);
        } finally {
          setCatalogLoading(false);
        }
      })();
    }, 250);
    return () => clearTimeout(handle);
  }, [tab, search]);

  const toggle = async (p: PluginInfo) => {
    setBusy(p.name);
    try {
      const res = p.enabled ? await api.plugins.disable(p.name) : await api.plugins.enable(p.name);
      const applied = res.reload?.applied
        ? "sofort uebernommen"
        : res.reload?.deferred
          ? "wird uebernommen, sobald kein Agent mehr arbeitet"
          : "Neustart uebernimmt die Aenderung";
      toast.success(`${p.name} ${p.enabled ? "deaktiviert" : "aktiviert"} — ${applied}`);
      await refresh();
      // Refresh the shared plugin cache so sidebar links + widgets update immediately.
      await queryClient.invalidateQueries({ queryKey: ["plugins"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(null);
    }
  };

  const openWidgets = (plugin: PluginInfo) => {
    setWidgetDrafts((current) => ({ ...current, [plugin.name]: current[plugin.name] ?? plugin.widgets.map((widget) => ({ ...widget })) }));
    setWidgetsFor((current) => current === plugin.name ? null : plugin.name);
  };

  const saveWidgets = async (plugin: PluginInfo) => {
    setBusy(plugin.name);
    try {
      const result = await api.plugins.saveWidgets(plugin.name, widgetDrafts[plugin.name] ?? plugin.widgets);
      setWidgetDrafts((current) => ({ ...current, [plugin.name]: result.widgets }));
      // Apply the server-validated representation synchronously to both consumers. A plain
      // invalidation can leave the old placement visible until its async refetch completes
      // (or until a deferred PluginManager reload is applied), which looked like Save failed.
      setPlugins((current) => current.map((entry) => entry.name === plugin.name ? { ...entry, widgets: result.widgets } : entry));
      queryClient.setQueryData<PluginInfo[]>(["plugins"], (current) =>
        current?.map((entry) => entry.name === plugin.name ? { ...entry, widgets: result.widgets } : entry)
      );
      toast.success("Widget-Darstellung gespeichert");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Widget-Einstellungen konnten nicht gespeichert werden");
    } finally {
      setBusy(null);
    }
  };

  const install = async (entry: CatalogEntry) => {
    const url = entry.source_url;
    if (!url) {
      toast.error("Keine Download-URL im Katalog-Eintrag");
      return;
    }
    setBusy(entry.id ?? entry.name ?? "");
    try {
      const res = await api.plugins.install({ url });
      toast.success(`${res.name} installiert (${res.files} Dateien) — ${res.reload?.deferred ? "aktiv sobald idle" : "aktiv"}`);
      await refresh();
      setTab("installed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Installation fehlgeschlagen");
    } finally {
      setBusy(null);
    }
  };

  const installedNames = new Set(plugins.map((p) => p.name));

  return (
    <div className="page space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Plugins</h1>
          <p className="text-sm text-muted-foreground">
            Datei-basierte Erweiterungen aus <code>plugins/</code> — Tools, Skills und Mappings. Keine node_modules, keine Belastung der Hauptdatenbank.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void reload(false)}
            disabled={reloading}
            title="Plugin-Verzeichnis neu einlesen (z. B. nach manuell hinzugefügten Plugin-Ordnern)"
            className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {reloading ? "Aktualisiere…" : "⟳ Aktualisieren"}
          </button>
          <button
            onClick={() => { setResumeRun(null); setCreateOpen(true); }}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            + Plugin erstellen
          </button>
        </div>
      </div>

      <CreatePluginWizardModal
        open={createOpen}
        onClose={() => { setCreateOpen(false); setResumeRun(null); void refreshDrafts(); }}
        existingNames={plugins.map((p) => p.name)}
        onCreated={() => void refresh()}
        resumeRun={resumeRun}
      />

      <div className="flex gap-2 border-b border-border">
        {(["installed", "catalog"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${tab === t ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
          >
            {t === "installed" ? "Installiert" : "Katalog"}
          </button>
        ))}
      </div>

      {tab === "installed" && (
        <div className="space-y-3">
          {!draftsLoading && drafts.length > 0 && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-sm font-medium text-amber-200">🚧 Unfertige Entwürfe ({drafts.length})</div>
              <p className="text-xs text-muted-foreground">
                Diese Plugin-Builder-Läufe wurden nicht abgeschlossen (fehlgeschlagen, gestoppt oder das Fenster wurde geschlossen).
                Die geschriebenen Dateien liegen noch auf dem Server — hier kannst du sie fortsetzen oder verwerfen.
              </p>
              {drafts.map((draft) => (
                <div key={draft.name} className="flex items-center justify-between gap-3 rounded border border-border bg-background/60 p-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      {draft.icon && <span>{draft.icon}</span>}
                      <span className="font-medium">{draft.displayName}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{draft.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                        draft.status === "running" ? "bg-cyan-500/15 text-cyan-300"
                          : draft.status === "failed" ? "bg-red-500/15 text-red-400"
                          : draft.status === "stopped" ? "bg-gray-500/15 text-gray-400"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {draft.status === "running" ? "läuft" : draft.status === "failed" ? "fehlgeschlagen" : draft.status === "stopped" ? "gestoppt" : "unbekannt"}
                      </span>
                    </div>
                    {draft.error && <p className="mt-0.5 truncate text-xs text-red-400" title={draft.error}>{draft.error}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {draft.status === "running" ? (
                      <button
                        onClick={() => { setResumeRun({ name: draft.name, runId: draft.runId ?? "" }); setCreateOpen(true); }}
                        className="rounded border border-border px-3 py-1.5 text-xs"
                      >
                        Ansehen
                      </button>
                    ) : (
                      <button
                        onClick={() => void resumeDraft(draft)}
                        disabled={draftBusy === draft.name || !draft.resumable}
                        title={draft.resumable ? undefined : "Kein spec.json vorhanden - dieser Entwurf kann nur gelöscht werden"}
                        className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        {draftBusy === draft.name ? "…" : "Fortsetzen"}
                      </button>
                    )}
                    <button
                      onClick={() => void deleteDraft(draft)}
                      disabled={draftBusy === draft.name}
                      className="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Löschen
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {loading && <p className="text-sm text-muted-foreground">Lade …</p>}
          {!loading && plugins.length === 0 && (
            <p className="text-sm text-muted-foreground">Keine Plugins in <code>plugins/</code> gefunden.</p>
          )}
          {plugins.map((p) => (
            <div key={p.name} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {p.icon && <span>{p.icon}</span>}
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-xs text-muted-foreground">v{p.version}</span>
                    {p.hasStorage && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">SQLite</span>}
                    {p.error && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-500">Fehler</span>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
                  {p.error && <p className="mt-1 text-xs text-red-500">{p.error}</p>}
                  <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                    {p.toolNames.map((t) => (
                      <span key={t} className="rounded bg-muted px-1.5 py-0.5">🔧 {t}</span>
                    ))}
                    {p.skillDirs.map((s) => (
                      <span key={s} className="rounded bg-muted px-1.5 py-0.5">📄 {s.split(/[\\/]/).pop()}</span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.frontendPage && p.enabled && !p.error && (
                    <button
                      onClick={() => navigate(`/plugin/${p.name}`)}
                      className="rounded border border-border px-3 py-1.5 text-sm"
                    >
                      ↗ Öffnen
                    </button>
                  )}
                  {p.settingsPage && !p.error && (
                    <button
                      onClick={() => setSettingsFor((cur) => (cur === p.name ? null : p.name))}
                      className="rounded border border-border px-3 py-1.5 text-sm"
                    >
                      {settingsFor === p.name ? "Schließen" : "⚙️ Einstellungen"}
                    </button>
                  )}
                  {p.widgets.length > 0 && !p.error && (
                    <button onClick={() => openWidgets(p)} className="rounded border border-border px-3 py-1.5 text-sm">
                      {widgetsFor === p.name ? "Schließen" : `🧩 Widgets (${p.widgets.length})`}
                    </button>
                  )}
                  <button
                    onClick={() => void toggle(p)}
                    disabled={busy === p.name || !!p.error}
                    className={`rounded px-3 py-1.5 text-sm ${p.enabled ? "bg-primary text-primary-foreground" : "border border-border"} disabled:opacity-50`}
                  >
                    {p.enabled ? "Aktiv" : "Aus"}
                  </button>
                </div>
              </div>

              {p.settingsPage && settingsFor === p.name && (
                <iframe
                  title={`${p.name} Einstellungen`}
                  src={pluginUiUrl(p.name, "settings")}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  className="mt-3 w-full rounded-md border border-border bg-background"
                  style={{ height: 520 }}
                />
              )}
              {p.widgets.length > 0 && widgetsFor === p.name && (
                <WidgetStyleEditor
                  widgets={widgetDrafts[p.name] ?? p.widgets}
                  busy={busy === p.name}
                  onChange={(widgets) => setWidgetDrafts((current) => ({ ...current, [p.name]: widgets }))}
                  onSave={() => void saveWidgets(p)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "catalog" && (
        <div className="space-y-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Plugins durchsuchen …"
            className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
          />
          {catalogLoading && <p className="text-sm text-muted-foreground">Lade Katalog …</p>}
          {catalogError && <p className="text-sm text-muted-foreground">Katalog nicht erreichbar: {catalogError}</p>}
          {!catalogLoading && catalog?.map((c) => {
            const id = c.id ?? c.name ?? "";
            const installed = installedNames.has(id);
            return (
              <div key={id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span className="font-semibold">{c.name ?? id}</span>
                    {c.version && <span className="ml-2 text-xs text-muted-foreground">v{c.version}</span>}
                    <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>
                  </div>
                  {installed ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Installiert</span>
                  ) : (
                    <button
                      onClick={() => void install(c)}
                      disabled={busy === id}
                      className="shrink-0 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                    >
                      {busy === id ? "Installiere …" : "Installieren"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!catalogLoading && catalog?.length === 0 && !catalogError && (
            <p className="text-sm text-muted-foreground">Keine Katalog-Eintraege.</p>
          )}
        </div>
      )}
    </div>
  );
}

const WIDGET_PLACEMENTS: PluginWidgetSpec["placement"][] = [
  "dashboard", "topbar", "footer", "sidebar-above-logo", "sidebar-before-mode", "sidebar-after-mode", "sidebar-content",
];

function WidgetStyleEditor({ widgets, busy, onChange, onSave }: {
  widgets: PluginWidgetSpec[];
  busy: boolean;
  onChange: (widgets: PluginWidgetSpec[]) => void;
  onSave: () => void;
}) {
  const update = (index: number, change: Partial<PluginWidgetSpec>) => onChange(widgets.map((widget, itemIndex) => itemIndex === index ? { ...widget, ...change } : widget));
  const fieldClass = "rounded border border-border bg-background px-2 py-1 text-xs";
  return <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
    <div className="mb-3 flex items-center justify-between gap-3">
      <div><div className="text-sm font-medium">Widget-Darstellung</div><div className="text-xs text-muted-foreground">Position und Stil ändern; Inhalt und Widget-ID bleiben unverändert.</div></div>
      <button onClick={onSave} disabled={busy} className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">{busy ? "Speichere…" : "Speichern"}</button>
    </div>
    <div className="space-y-2">
      {widgets.map((widget, index) => <div key={widget.id} className="grid gap-2 rounded border border-border bg-background/60 p-2 md:grid-cols-2 xl:grid-cols-7">
        <label className="text-[11px] text-muted-foreground"><span className="block pb-1 font-medium text-foreground">{widget.title || widget.id}</span><span className="font-mono">{widget.id}</span></label>
        <label className="text-[11px] text-muted-foreground">Position<select value={widget.placement} onChange={(event) => update(index, { placement: event.target.value as PluginWidgetSpec["placement"] })} className={`${fieldClass} mt-1 block w-full`}>{WIDGET_PLACEMENTS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="text-[11px] text-muted-foreground">Ausrichtung<select value={widget.align} onChange={(event) => update(index, { align: event.target.value as PluginWidgetSpec["align"] })} className={`${fieldClass} mt-1 block w-full`}>{["left", "center", "right", "full"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="text-[11px] text-muted-foreground">Rahmen<select value={widget.frame} onChange={(event) => update(index, { frame: event.target.value as PluginWidgetSpec["frame"] })} className={`${fieldClass} mt-1 block w-full`}><option value="card">card</option><option value="borderless">ohne Rahmen</option></select></label>
        <label className="text-[11px] text-muted-foreground">Hintergrund<select value={widget.background} onChange={(event) => update(index, { background: event.target.value as PluginWidgetSpec["background"] })} className={`${fieldClass} mt-1 block w-full`}>{["card", "transparent", "inherit"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="text-[11px] text-muted-foreground">Breite<select value={widget.width} onChange={(event) => update(index, { width: event.target.value as PluginWidgetSpec["width"] })} className={`${fieldClass} mt-1 block w-full`}>{["auto", "sm", "md", "lg", "full"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="text-[11px] text-muted-foreground">Höhe (px)<input type="number" min={20} max={800} value={widget.height} onChange={(event) => update(index, { height: Number(event.target.value) })} className={`${fieldClass} mt-1 block w-full`} /></label>
      </div>)}
    </div>
  </div>;
}

export default PluginsPage;
