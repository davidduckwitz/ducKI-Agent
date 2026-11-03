import { getApiBaseUrl } from "../../lib/backendUrl";
import { useEffect, useState } from "react";

interface Status {
  reachable: boolean;
  managed: boolean;
  working: boolean;
  phase?: string;
  envReady?: boolean;
  autoStart: boolean;
  error?: string;
  health?: { modelLoaded?: boolean; busy?: boolean; device?: string; packageVersion?: string; loadedLanguages?: string[];
    cloningAvailable?: boolean | null; metrics?: { lastRealtimeFactor?: number | null; lastFirstChunkMs?: number | null } };
}

export function PocketTtsControls() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/settings/pocket-tts/status`);
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
      const response = await fetch(`${getApiBaseUrl()}/settings/pocket-tts/${name}`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setStatus((current) => current && { ...current, working: true, error: undefined });
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  };
  const busy = pending || status?.working || status?.health?.busy;
  const metrics = status?.health?.metrics;
  return <div className="card space-y-3 mt-3" aria-label="Pocket TTS Serversteuerung">
    <h3 className="font-semibold">Pocket TTS – lokaler Server (CPU)</h3>
    <p className="text-sm" role="status">{!status ? "Status wird geladen …" : status.working ? (status.phase ?? "Aktion läuft (Erststart lädt Modellgewichte herunter) …") :
      !status.reachable ? (status.envReady === false ? "Python-Umgebung nicht eingerichtet" : "Server gestoppt") :
      status.health?.modelLoaded ? "Modell geladen" : "Modell entladen"}
      {status?.health?.device && ` · ${status.health.device}`}
      {!!status?.health?.loadedLanguages?.length && ` · Sprachen: ${status.health.loadedLanguages.join(", ")}`}
      {status?.health?.packageVersion && ` · Paket ${status.health.packageVersion}`}
    </p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={status?.autoStart ?? true} disabled={!status || pending}
      onChange={async (event) => {
        const enabled = event.target.checked;
        setPending(true);
        try {
          const response = await fetch(`${getApiBaseUrl()}/settings/POCKET_TTS_AUTO_START`, { method: "PUT",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: String(enabled) }) });
          if (!response.ok) throw new Error(await response.text());
          setStatus((current) => current && { ...current, autoStart: enabled });
        } catch (cause) { setError(String(cause)); } finally { setPending(false); }
      }} />Automatisch starten, wenn Pocket TTS als Server-TTS aktiviert ist</label>
    {status && !status.reachable && !status.working && status.envReady === false && (
      <div className="rounded border border-border p-2 space-y-2">
        <p className="text-sm">Die eigene Python-Umgebung (<code className="rounded bg-muted px-1">.venv-pocket</code>) mit pocket-tts fehlt.
          Die Einrichtung lädt einige hundert MB herunter (PyTorch läuft auf der CPU, keine GPU nötig).</p>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void action("setup")}>Umgebung einrichten</button>
      </div>
    )}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary" disabled={!status || busy || status.reachable || status.envReady === false} onClick={() => void action("start")}>Server starten</button>
      <button type="button" className="btn-secondary" disabled={!status?.managed || pending || status.working} onClick={() => void action("stop")}>Server stoppen</button>
      <button type="button" className="btn-secondary" disabled={!status?.reachable || busy || status.health?.modelLoaded} onClick={() => void action("load")}>Modell laden</button>
      <button type="button" className="btn-secondary" disabled={!status?.health?.modelLoaded || busy} onClick={() => void action("unload")}>Modell entladen</button>
    </div>
    {status?.reachable && !status.managed && <p className="text-xs text-muted-foreground">Extern gestarteter Server: zum Übernehmen einmal im ursprünglichen Terminal stoppen und hier starten.</p>}
    <p className="text-xs text-muted-foreground">
      Kleines Sprachmodell (~100M Parameter) für die CPU mit echtem Streaming (erstes Audio nach ca. 0,2 s). Es gibt ein Modell je Sprache
      (Deutsch, Englisch, Französisch, Spanisch, Italienisch, Portugiesisch, Niederländisch); die Sprache folgt der Einstellung „Sprache“ oben.
      Der erste Start jeder Sprache lädt die Gewichte einmalig von Hugging Face, danach läuft alles lokal. Emotions-Presets werden nicht unterstützt.
    </p>
    {status?.health?.cloningAvailable === false && (
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Stimmklon aus eigenen Aufnahmen ist nicht freigeschaltet – es werden die eingebauten Stimmen genutzt (Deutsch: juergen). Zum Freischalten die Bedingungen auf huggingface.co/kyutai/pocket-tts akzeptieren, unter Settings → Agent → Zugangsdaten einen
        Hugging-Face-Token hinterlegen und den Server neu starten.
      </p>
    )}
    {metrics?.lastRealtimeFactor != null && <p className="text-xs">Letzte Generierung: {metrics.lastRealtimeFactor} Sekunden Rechenzeit pro Sekunde Audio
      {metrics.lastFirstChunkMs != null && `, erstes Audio nach ${metrics.lastFirstChunkMs} ms`} (kleiner ist schneller).</p>}
    {(error || statusError || status?.error) && <p role="alert" className="text-sm text-red-500">{error || statusError || status?.error}</p>}
  </div>;
}
