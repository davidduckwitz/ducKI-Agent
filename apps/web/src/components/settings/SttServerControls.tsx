import { getApiBaseUrl } from "../../lib/backendUrl";
import { useEffect, useState } from "react";

interface Status {
  reachable: boolean;
  managed: boolean;
  working: boolean;
  autoStart: boolean;
  error?: string;
  health?: { modelLoaded?: boolean; busy?: boolean; model?: string; device?: string; computeType?: string;
    cudaAvailable?: boolean; error?: string; metrics?: { lastTranscribeMs?: number; lastAudioSeconds?: number; lastRealtimeFactor?: number } };
}

const MODELS = [
  { value: "", label: "Automatisch (GPU: large-v3-turbo, CPU: base)" },
  { value: "tiny", label: "tiny – sehr schnell, ungenau" },
  { value: "base", label: "base – schnell (CPU-Empfehlung)" },
  { value: "small", label: "small – ausgewogen" },
  { value: "medium", label: "medium – genau, langsam auf CPU" },
  { value: "large-v3-turbo", label: "large-v3-turbo – beste Wahl mit NVIDIA-GPU" },
  { value: "large-v3", label: "large-v3 – maximal genau, braucht viel VRAM" },
];

async function readSetting(key: string): Promise<string> {
  const response = await fetch(`${getApiBaseUrl()}/settings/${key}`);
  if (!response.ok) return "";
  const body = await response.json();
  return String(body.data?.value ?? "");
}

async function writeSetting(key: string, value: string) {
  const response = await fetch(`${getApiBaseUrl()}/settings/${key}`, { method: "PUT",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
  if (!response.ok) throw new Error(await response.text());
}

/** Settings > Sprache: lokaler faster-whisper STT-Server (scripts/stt_server.py). */
export function SttServerControls() {
  const [status, setStatus] = useState<Status>();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void Promise.all([readSetting("DEFAULT_SPEECH_TO_TEXT_PROVIDER"), readSetting("STT_SERVER_MODEL"), readSetting("STT_SERVER_DEVICE")])
      .then(([p, m, d]) => { setProvider(p || "nodejs-whisper"); setModel(m); setDevice(d); })
      .catch((cause) => setError(String(cause)));
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/settings/stt-server/status`);
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        if (active) setStatus(body.data);
      } catch { /* backend unreachable - keep last status */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const action = async (name: string) => {
    setPending(true); setError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/settings/stt-server/${name}`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setStatus((current) => current && { ...current, working: true, error: undefined });
    } catch (cause) { setError(String(cause)); }
    finally { setPending(false); }
  };
  const save = async (key: string, value: string, apply: (v: string) => void) => {
    setError("");
    try { await writeSetting(key, value); apply(value); } catch (cause) { setError(String(cause)); }
  };

  const enabled = provider === "faster-whisper";
  const busy = pending || status?.working;
  const h = status?.health;
  return <div className="card space-y-3" aria-label="STT-Server Steuerung">
    <h4 className="font-semibold text-sm">Schnelle Transkription – faster-whisper Server</h4>
    <label className="flex gap-2 text-sm items-center">
      <input type="checkbox" checked={enabled} onChange={(e) =>
        void save("DEFAULT_SPEECH_TO_TEXT_PROVIDER", e.target.checked ? "faster-whisper" : "nodejs-whisper", setProvider)} />
      faster-whisper Server für die Spracheingabe verwenden (inkl. Live-Text während des Sprechens)
    </label>
    <p className="text-sm" role="status">{!status ? "Status wird geladen …" : status.working ? "Aktion läuft … (erster Start lädt das Modell herunter)" :
      !status.reachable ? "Server gestoppt" : h?.modelLoaded ? `Modell ${h.model} geladen` : "Modell entladen"}
      {h?.device && ` · ${h.device === "cuda" ? "NVIDIA CUDA" : "CPU"}${h.computeType ? ` (${h.computeType})` : ""}`}
      {h && !h.cudaAvailable && h.device !== "cuda" && " · keine CUDA-GPU erkannt"}
    </p>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-sm space-y-1"><span className="block font-medium">Modell</span>
        <select className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm" value={model} disabled={busy}
          onChange={(e) => void save("STT_SERVER_MODEL", e.target.value, setModel)}>
          {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <label className="text-sm space-y-1"><span className="block font-medium">Hardware</span>
        <select className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm" value={device} disabled={busy}
          onChange={(e) => void save("STT_SERVER_DEVICE", e.target.value, setDevice)}>
          <option value="">Automatisch (NVIDIA-GPU falls vorhanden)</option>
          <option value="cuda">NVIDIA CUDA erzwingen</option>
          <option value="cpu">Nur CPU</option>
        </select>
      </label>
    </div>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={status?.autoStart ?? true} disabled={!status || pending}
      onChange={(e) => void save("STT_SERVER_AUTO_START", String(e.target.checked), (v) =>
        setStatus((current) => current && { ...current, autoStart: v === "true" }))} />
      Automatisch starten, wenn faster-whisper aktiviert ist</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary" disabled={!status || busy || status.reachable} onClick={() => void action("start")}>Server starten</button>
      <button type="button" className="btn-secondary" disabled={!status?.managed || busy} onClick={() => void action("stop")}>Server stoppen</button>
      <button type="button" className="btn-secondary" disabled={!status?.reachable || busy || h?.modelLoaded} onClick={() => void action("load")}>Modell laden</button>
      <button type="button" className="btn-secondary" disabled={!h?.modelLoaded || busy} onClick={() => void action("unload")}>Modell entladen</button>
    </div>
    <p className="text-xs text-muted-foreground">Modell- und Hardware-Änderungen gelten nach „Server stoppen“ und erneutem Start.
      Läuft der Server nicht, wird automatisch auf nodejs-whisper zurückgefallen (ohne Live-Text).</p>
    {h?.metrics?.lastTranscribeMs != null && <p className="text-xs">Letzte Transkription: {h.metrics.lastTranscribeMs} ms für {h.metrics.lastAudioSeconds}s Audio.</p>}
    {status?.reachable && !status.managed && <p className="text-xs text-muted-foreground">Extern gestarteter Server – Stoppen nur im ursprünglichen Terminal.</p>}
    {(error || status?.error || h?.error) && <p role="alert" className="text-sm text-red-500">{error || status?.error || h?.error}</p>}
  </div>;
}
