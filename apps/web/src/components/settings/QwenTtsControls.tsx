import { getApiBaseUrl } from "../../lib/backendUrl";
import { useEffect, useState } from "react";

interface Status {
  reachable: boolean;
  managed: boolean;
  working: boolean;
  phase?: string;
  envReady?: boolean;
  cpuOnlyTorch?: boolean;
  autoStart: boolean;
  error?: string;
  health?: { modelLoaded?: boolean; busy?: boolean; device?: string; packageVersion?: string; model?: string;
    mode?: "clone" | "speaker"; supportsInstruct?: boolean; attention?: string; vramAllocatedGb?: number | null;
    metrics?: { lastRealtimeFactor?: number } };
}

const MODELS = [
  { label: "0.6B Base (Stimmklon, kleinster VRAM-Bedarf)", value: "Qwen/Qwen3-TTS-12Hz-0.6B-Base" },
  { label: "0.6B CustomVoice (feste Sprecher)", value: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" },
  { label: "1.7B Base (Stimmklon, bessere Qualität)", value: "Qwen/Qwen3-TTS-12Hz-1.7B-Base" },
  { label: "1.7B CustomVoice (feste Sprecher + Stil-Anweisung)", value: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
];

export function QwenTtsControls() {
  const [model, setModel] = useState(MODELS[0]!.value);
  useEffect(() => {
    void fetch(`${getApiBaseUrl()}/settings/QWEN_TTS_MODEL`).then((r) => r.json())
      .then((body) => { if (body?.data?.value) setModel(body.data.value); }).catch(() => undefined);
  }, []);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/settings/qwen-tts/status`);
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
      const response = await fetch(`${getApiBaseUrl()}/settings/qwen-tts/${name}`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setStatus((current) => current && { ...current, working: true, error: undefined });
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  };
  const busy = pending || status?.working || status?.health?.busy;
  return <div className="card space-y-3 mt-3" aria-label="Qwen3-TTS Serversteuerung">
    <h3 className="font-semibold">Qwen3-TTS – lokaler Server</h3>
    <p className="text-sm" role="status">{!status ? "Status wird geladen …" : status.working ? (status.phase ?? "Aktion läuft (Erststart lädt Modellgewichte herunter) …") :
      !status.reachable ? (status.envReady === false ? "Python-Umgebung nicht eingerichtet" : "Server gestoppt") : status.health?.modelLoaded ? "Modell geladen" : "Modell entladen"}
      {status?.health?.device && ` · ${status.health.device}`}
      {status?.health?.model && ` · ${status.health.model.split("/").pop()}`}
      {status?.health?.mode && ` · ${status.health.mode === "clone" ? "Stimmklon" : "Sprecher"}`}
      {status?.health?.vramAllocatedGb != null && ` · ${status.health.vramAllocatedGb} GB VRAM`}
    </p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={status?.autoStart ?? true} disabled={!status || pending}
      onChange={async (event) => {
        const enabled = event.target.checked;
        setPending(true);
        try {
          const response = await fetch(`${getApiBaseUrl()}/settings/QWEN_TTS_AUTO_START`, { method: "PUT",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: String(enabled) }) });
          if (!response.ok) throw new Error(await response.text());
          setStatus((current) => current && { ...current, autoStart: enabled });
        } catch (cause) { setError(String(cause)); } finally { setPending(false); }
      }} />Automatisch starten, wenn Qwen3-TTS als Server-TTS aktiviert ist</label>
    {status && !status.reachable && !status.working && (status.envReady === false || status.cpuOnlyTorch) && (
      <div className="rounded border border-border p-2 space-y-2">
        {status.envReady === false
          ? <p className="text-sm">Die eigene Python-Umgebung (<code className="rounded bg-muted px-1">.venv-qwen</code>) mit PyTorch und qwen-tts fehlt.
              Die Einrichtung lädt mehrere GB herunter und dauert einige Minuten.</p>
          : <p className="text-sm">In der Umgebung ist PyTorch ohne GPU-Unterstützung installiert (CPU-Build) – die Sprachausgabe läuft dadurch etwa 10x langsamer.
              „Umgebung einrichten“ ersetzt es durch die CUDA-Version (mehrere GB Download).</p>}
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void action("setup")}>{status.envReady === false ? "Umgebung einrichten" : "Auf GPU-PyTorch umstellen"}</button>
      </div>
    )}
    <label className="block text-sm space-y-1"><span className="font-medium">Modell</span>
      <select value={model} className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm"
        onChange={async (event) => {
          const value = event.target.value;
          setModel(value);
          try {
            const response = await fetch(`${getApiBaseUrl()}/settings/QWEN_TTS_MODEL`, { method: "PUT",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
            if (!response.ok) throw new Error(await response.text());
          } catch (cause) { setError(String(cause)); }
        }}>
        {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary" disabled={!status || busy || status.reachable || status.envReady === false} onClick={() => void action("start")}>Server starten</button>
      <button type="button" className="btn-secondary" disabled={!status?.managed || pending || status.working} onClick={() => void action("stop")}>Server stoppen</button>
      <button type="button" className="btn-secondary" disabled={!status?.reachable || busy || status.health?.modelLoaded} onClick={() => void action("load")}>Modell laden</button>
      <button type="button" className="btn-secondary" disabled={!status?.health?.modelLoaded || busy} onClick={() => void action("unload")}>Modell entladen</button>
    </div>
    {status?.reachable && !status.managed && <p className="text-xs text-muted-foreground">Extern gestarteter Server: zum Übernehmen einmal im ursprünglichen Terminal stoppen und hier starten.</p>}
    <p className="text-xs text-muted-foreground">
      Ein Modellwechsel wirkt nach Server-Neustart (stoppen, starten).
      Base-Modelle klonen die Stimme aus einer .wav der Stimmen-Bibliothek (optional mit dem gesprochenen Text);
      CustomVoice-Modelle bringen feste Sprecher mit{status?.health && !status.health.supportsInstruct ? "; Stil-Anweisungen unterstützt nur CustomVoice 1.7B" : ""}.
      Einrichtung über „Umgebung einrichten“ (eigene venv .venv-qwen).
    </p>
    {status?.health?.metrics?.lastRealtimeFactor != null && <p className="text-xs">Letzte Generierung: {status.health.metrics.lastRealtimeFactor} Sekunden Rechenzeit pro Sekunde Audio (kleiner ist schneller).</p>}
    {(error || statusError || status?.error) && <p role="alert" className="text-sm text-red-500">{error || statusError || status?.error}</p>}
  </div>;
}
