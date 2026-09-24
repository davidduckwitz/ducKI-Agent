import { getApiBaseUrl } from "../../lib/backendUrl";
import { useEffect, useState } from "react";

interface Status {
  reachable: boolean;
  managed: boolean;
  working: boolean;
  autoStart: boolean;
  error?: string;
  health?: { modelLoaded?: boolean; busy?: boolean; device?: string; packageVersion?: string; packageRevision?: string;
    modelVariant?: string; metrics?: { lastRealtimeFactor?: number } };
}

export function ChatterboxControls() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/settings/chatterbox/status`);
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        if (active) { setStatus(body.data); setStatusError(""); }
      } catch (cause) { if (active) setStatusError(String(cause)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const action = async (name: string) => {
    setPending(true); setError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/settings/chatterbox/${name}`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setStatus((current) => current && { ...current, working: true, error: undefined });
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  };
  const busy = pending || status?.working || status?.health?.busy;
  return <div className="card space-y-3 mt-3" aria-label="Chatterbox Serversteuerung">
    <h3 className="font-semibold">Chatterbox Multilingual V3 – lokaler Server</h3>
    <p className="text-sm" role="status">{!status ? "Status wird geladen …" : status.working ? "Aktion läuft …" :
      !status.reachable ? "Server gestoppt" : status.health?.modelLoaded ? "Modell geladen" : "Modell entladen"}
      {status?.health?.device && ` · ${status.health.device}`}
      {status?.health?.packageVersion && ` · Paket ${status.health.packageVersion}`}
      {status?.health?.packageRevision && ` · ${status.health.packageRevision.slice(0, 8)}`}
      {status?.health?.modelVariant && ` · Multilingual ${status.health.modelVariant}`}
    </p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={status?.autoStart ?? true} disabled={!status || pending}
      onChange={async (event) => {
        const enabled = event.target.checked;
        setPending(true);
        try {
          const response = await fetch(`${getApiBaseUrl()}/settings/CHATTERBOX_AUTO_START`, { method: "PUT",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: String(enabled) }) });
          if (!response.ok) throw new Error(await response.text());
          setStatus((current) => current && { ...current, autoStart: enabled });
        } catch (cause) { setError(String(cause)); } finally { setPending(false); }
      }} />Automatisch starten, wenn Chatterbox als Server-TTS aktiviert ist</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary" disabled={!status || busy || status.reachable} onClick={() => void action("start")}>Server starten</button>
      <button type="button" className="btn-secondary" disabled={!status?.managed || pending || status.working} onClick={() => void action("stop")}>Server stoppen</button>
      <button type="button" className="btn-secondary" disabled={!status?.reachable || busy || status.health?.modelLoaded} onClick={() => void action("load")}>Modell laden</button>
      <button type="button" className="btn-secondary" disabled={!status?.health?.modelLoaded || busy} onClick={() => void action("unload")}>Modell entladen</button>
    </div>
    {status?.reachable && !status.managed && <p className="text-xs text-muted-foreground">Extern gestarteter Server: zum Übernehmen einmal im ursprünglichen Terminal stoppen und hier starten.</p>}
    <p className="text-xs text-muted-foreground">Entladen gibt den Modellspeicher frei. Vor der nächsten Sprachausgabe „Modell laden“ wählen. Autostart gilt beim Backend-Start und beim Aktivieren; manuelles Stoppen bleibt bis dahin erhalten.</p>
    {status?.health?.metrics?.lastRealtimeFactor != null && <p className="text-xs">Letzte Generierung: {status.health.metrics.lastRealtimeFactor} Sekunden Rechenzeit pro Sekunde Audio (kleiner ist schneller).</p>}
    {(error || statusError || status?.error) && <p role="alert" className="text-sm text-red-500">{error || statusError || status?.error}</p>}
  </div>;
}
