import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type PluginInfo } from "../../lib/api";
import { toastManager as toast } from "../../lib/toast";

/** Public plugin catalog API (filterable via ?search= / ?category=). */
const CATALOG_API = "https://ducki-ai-agent.davidduckwitz.de/api/v1.php";

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      <div>
        <h1 className="text-2xl font-bold">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          Datei-basierte Erweiterungen aus <code>plugins/</code> — Tools, Skills und Mappings. Keine node_modules, keine Belastung der Hauptdatenbank.
        </p>
      </div>

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
                  src={`/api/plugins/${p.name}/ui/settings`}
                  className="mt-3 w-full rounded-md border border-border bg-background"
                  style={{ height: 520 }}
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

export default PluginsPage;
