import { getApiBaseUrl } from "../../lib/backendUrl";
import { useCallback, useEffect, useRef, useState } from "react";

interface VoiceEntry { id: string; sizeBytes: number; hasTranscript: boolean; transcript?: string }

async function errorText(response: Response): Promise<string> {
  try { const body = await response.json(); return body?.error?.message ?? body?.error ?? JSON.stringify(body); }
  catch { return `HTTP ${response.status}`; }
}

/** Reference-voice library shared by all local TTS engines (Chatterbox, Qwen3-TTS). */
export function TtsVoiceLibrary() {
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [defaultVoice, setDefaultVoice] = useState<string>();
  const [dir, setDir] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [transcript, setTranscript] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const input = useRef<HTMLInputElement>(null);
  const base = `${getApiBaseUrl()}/settings/tts-voices`;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base);
      if (!response.ok) throw new Error(await errorText(response));
      const body = await response.json();
      setVoices(body.data.voices); setDefaultVoice(body.data.defaultVoice); setDir(body.data.dir ?? "");
    } catch (cause) { setError(String(cause)); }
  }, [base]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await task(); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const sendJson = async (url: string, method: string, payload?: unknown) => {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (!response.ok) throw new Error(await errorText(response));
  };

  const upload = () => run(async () => {
    if (!file) throw new Error("Bitte eine .wav-Datei wählen.");
    const id = name.trim();
    const response = await fetch(`${base}/${encodeURIComponent(id)}?overwrite=${voices.some((v) => v.id === id)}`, {
      method: "PUT", headers: { "Content-Type": "audio/wav" }, body: file });
    if (!response.ok) throw new Error(await errorText(response));
    if (transcript.trim()) await sendJson(`${base}/${encodeURIComponent(id)}/transcript`, "PUT", { text: transcript });
    setFile(undefined); setName(""); setTranscript("");
    if (input.current) input.current.value = "";
  });

  return <div className="card space-y-3 mt-3" aria-label="Referenzstimmen für lokale TTS-Modelle">
    <h3 className="font-semibold">Referenzstimmen (Chatterbox &amp; Qwen3-TTS)</h3>
    <p className="text-xs text-muted-foreground">
      Beide Modelle klonen die Stimme aus einer kurzen, sauberen Aufnahme (5–20 s, ein Sprecher, .wav). Alle Aufnahmen liegen
      im gemeinsamen Ordner{dir && <> <code className="rounded bg-muted px-1 break-all">{dir}</code></>}. Der gesprochene
      Text (optional) verbessert die Qualität bei Qwen3-TTS Base.
    </p>
    {voices.length === 0 ? <p className="text-sm">Noch keine Referenzstimme vorhanden.</p> : (
      <ul className="space-y-2">
        {voices.map((voice) => <li key={voice.id} className="rounded border border-border p-2 text-sm space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{voice.id}</strong>
            {voice.id === defaultVoice && <span className="text-xs text-emerald-600 dark:text-emerald-400">Standard</span>}
            <span className="text-xs text-muted-foreground">{(voice.sizeBytes / 1024).toFixed(0)} KB · {voice.hasTranscript ? "mit Transkript" : "ohne Transkript"}</span>
            <audio controls preload="none" src={`${base}/${encodeURIComponent(voice.id)}/audio`} className="h-8" />
            <button type="button" className="btn-secondary ml-auto" disabled={busy}
              onClick={() => setEditing(editing?.id === voice.id ? undefined : { id: voice.id, text: voice.transcript ?? "" })}>Transkript</button>
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => { if (window.confirm(`Stimme „${voice.id}“ löschen?`)) void run(() => sendJson(`${base}/${encodeURIComponent(voice.id)}`, "DELETE")); }}>Löschen</button>
          </div>
          {editing?.id === voice.id && <div className="space-y-2">
            <textarea className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm" rows={3} value={editing.text}
              placeholder="Genau der Text, der in der Aufnahme gesprochen wird" onChange={(event) => setEditing({ id: voice.id, text: event.target.value })} />
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => void run(async () => { await sendJson(`${base}/${encodeURIComponent(voice.id)}/transcript`, "PUT", { text: editing.text }); setEditing(undefined); })}>Transkript speichern</button>
          </div>}
        </li>)}
      </ul>
    )}
    <div className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm font-medium">Neue Referenzaufnahme hochladen</h4>
      <input ref={input} type="file" accept=".wav,audio/wav,audio/x-wav" className="text-sm block"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          setFile(chosen);
          if (chosen && !name) setName(chosen.name.replace(/\.wav$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64));
        }} />
      <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name der Stimme (a–z, 0–9, _ -)"
        className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm" />
      <textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} rows={2}
        placeholder="Optional: gesprochener Text der Aufnahme" className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm" />
      <button type="button" className="btn-secondary" disabled={busy || !file || !name.trim()} onClick={() => void upload()}>
        {voices.some((v) => v.id === name.trim()) ? "Hochladen (überschreibt vorhandene)" : "Hochladen"}
      </button>
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
  </div>;
}
