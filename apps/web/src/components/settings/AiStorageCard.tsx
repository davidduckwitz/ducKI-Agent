import { getApiBaseUrl } from "../../lib/backendUrl";
import { useCallback, useEffect, useState } from "react";

interface StorageItem {
  id: string;
  kind: "venv" | "model";
  label: string;
  description: string;
  path: string;
  sizeBytes: number;
  blockedReason?: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Disk usage of the local TTS/STT engines (Python environments + model downloads) with delete. */
export function AiStorageCard() {
  const [items, setItems] = useState<StorageItem[]>();
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/settings/ai-storage`);
      if (!response.ok) throw new Error(await response.text());
      setItems((await response.json()).data.items);
      setError("");
    } catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (item: StorageItem) => {
    if (!window.confirm(`„${item.label}“ (${formatSize(item.sizeBytes)}) wirklich löschen?\n\n${item.path}`)) return;
    setDeleting(item.id); setError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/settings/ai-storage?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.error?.message ?? body?.error ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeleting(undefined); }
  };

  const total = items?.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0;
  const section = (kind: StorageItem["kind"], title: string) => {
    const rows = items?.filter((item) => item.kind === kind) ?? [];
    if (!rows.length) return null;
    return <div className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <ul className="space-y-2">
        {rows.map((item) => <li key={item.id} className="rounded border border-border p-2 text-sm flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div><strong>{item.label}</strong> <span className="text-xs text-muted-foreground">· {formatSize(item.sizeBytes)}</span></div>
            <div className="text-xs text-muted-foreground">{item.description}</div>
            {item.blockedReason && <div className="text-xs text-amber-600 dark:text-amber-400">{item.blockedReason}</div>}
          </div>
          <button type="button" className="btn-secondary" disabled={!!item.blockedReason || !!deleting} onClick={() => void remove(item)}>
            {deleting === item.id ? "Lösche …" : "Löschen"}
          </button>
        </li>)}
      </ul>
    </div>;
  };

  return <div className="card space-y-3 mt-3" aria-label="Speicherplatz lokale Sprachmodelle">
    <div className="flex items-center gap-2">
      <h3 className="font-semibold">Speicherplatz lokale Sprachmodelle (TTS &amp; STT)</h3>
      {items && <span className="text-xs text-muted-foreground">gesamt {formatSize(total)}</span>}
      <button type="button" className="btn-secondary ml-auto" disabled={loading} onClick={() => void refresh()}>{loading ? "Berechne …" : "Aktualisieren"}</button>
    </div>
    <p className="text-xs text-muted-foreground">
      Nicht mehr benötigte Python-Umgebungen und Modell-Downloads löschen, um Platz zu schaffen. Der zugehörige Server muss dafür gestoppt sein.
      Gelöschte Modelle werden beim nächsten Laden neu heruntergeladen, Umgebungen lassen sich neu einrichten.
    </p>
    {!items && loading && <p className="text-sm">Größen werden berechnet …</p>}
    {items && items.length === 0 && <p className="text-sm">Nichts installiert.</p>}
    {section("venv", "Python-Umgebungen")}
    {section("model", "Modell-Downloads")}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
  </div>;
}
