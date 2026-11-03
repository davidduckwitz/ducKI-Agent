import { useEffect, useRef, useState } from "react";
import { Ear, Trash2, Upload } from "lucide-react";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { preloadWakeWordEngine, splitModelRef } from "../../lib/wakeWord";

interface ModelEntry { id: string; label: string; installed?: boolean; size?: number }
interface CommunityEntry { id: string; label: string; language: string }
interface ModelsResponse {
  openwakeword: { builtin: ModelEntry[]; custom: ModelEntry[] };
  porcupine: { params: Array<{ id: string; installed: boolean }>; custom: ModelEntry[] };
}

// Mirrors BuiltInKeyword from @picovoice/porcupine-web without pulling the SDK into the settings chunk.
const PORCUPINE_BUILTINS = ["Alexa", "Americano", "Blueberry", "Bumblebee", "Computer", "Grapefruit", "Grasshopper", "Hey Google", "Hey Siri", "Jarvis", "Okay Google", "Picovoice", "Porcupine", "Terminator"];

const selectClass = "w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary";

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** An older backend without /api/wakeword answers with an HTML 404 page instead of JSON. */
async function readJson(response: Response): Promise<{ data?: any; error?: string }> {
  try {
    return await response.json();
  } catch {
    throw new Error(response.status === 404
      ? "Das Backend kennt /api/wakeword noch nicht – bitte den DucKI-Server neu starten."
      : `Unerwartete Antwort vom Backend (HTTP ${response.status}).`);
  }
}

export function WakeWordSettings() {
  const settings = useVoiceSettings();
  const { setWakeWord } = settings;
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [community, setCommunity] = useState<CommunityEntry[] | null>(null);
  const [status, setStatus] = useState<{ tone: "info" | "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const isOww = settings.wakeWordProvider === "openwakeword";

  const loadModels = async () => {
    try {
      const response = await fetch("/api/wakeword/models");
      const body = await readJson(response);
      if (response.ok) setModels(body.data);
    } catch { /* backend offline - selects keep the saved value */ }
  };
  useEffect(() => { void loadModels(); }, []);

  const loadCommunity = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/wakeword/community");
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "Community-Liste nicht erreichbar");
      setCommunity(body.data);
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setStatus({ tone: "info", text: `Lade ${file.name} hoch …` });
    try {
      const engine = settings.wakeWordProvider;
      const response = await fetch(`/api/wakeword/custom/${engine}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, data: await fileToBase64(file) }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "Upload fehlgeschlagen");
      await loadModels();
      const label = file.name.replace(/\.(onnx|ppn)$/i, "").replace(/_(de|en)_wasm_.*$/i, "").replace(/[_-]+/g, " ");
      setWakeWord(engine === "openwakeword"
        ? { wakeWordOwwModel: `custom:${body.data.id}`, wakeWordPhrase: label }
        : { wakeWordPorcupineKeyword: `custom:${body.data.id}`, wakeWordPhrase: label });
      setStatus({ tone: "ok", text: `${file.name} hochgeladen und ausgewählt.` });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };

  const removeCustom = async (id: string) => {
    const engine = settings.wakeWordProvider;
    await fetch(`/api/wakeword/custom/${engine}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (engine === "openwakeword" && settings.wakeWordOwwModel === `custom:${id}`) setWakeWord({ wakeWordOwwModel: "builtin:hey_jarvis", wakeWordPhrase: "Hey Jarvis" });
    if (engine === "porcupine" && settings.wakeWordPorcupineKeyword === `custom:${id}`) setWakeWord({ wakeWordPorcupineKeyword: "builtin:Jarvis", wakeWordPhrase: "Jarvis" });
    await loadModels();
  };

  const test = async () => {
    setBusy(true);
    setStatus({ tone: "info", text: "Lade Modelle und prüfe die Konfiguration …" });
    try {
      await preloadWakeWordEngine(useVoiceSettings.getState());
      setStatus({ tone: "ok", text: `Erkennung bereit. Im Sprache-Tab das Mikrofon antippen und „${settings.wakeWordPhrase}“ sagen.` });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };

  const selectedCustomId = (() => {
    const ref = isOww ? settings.wakeWordOwwModel : settings.wakeWordPorcupineKeyword;
    const [source, id] = splitModelRef(ref, "builtin");
    return source === "custom" ? id : null;
  })();
  const customList = (isOww ? models?.openwakeword.custom : models?.porcupine.custom) ?? [];
  const owwInCommunity = settings.wakeWordOwwModel.startsWith("community:");

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Ear className="h-5 w-5" />
        <h3 className="text-base font-semibold">Aktivierungswort (Wake Word)</h3>
      </div>

      <div className="space-y-3 pl-7">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium block">Nur auf Aktivierungswort reagieren</label>
            <p className="text-xs text-muted-foreground">
              Das Mikrofon wartet auf das Wort (z. B. „Hey Jarvis“), nimmt dann eine Anfrage auf und wartet danach automatisch wieder.
              Das Wort unterbricht auch eine laufende Antwort. Auch im Sprache-Tab direkt umschaltbar.
            </p>
          </div>
          <input type="checkbox" checked={settings.wakeWordEnabled} onChange={(e) => setWakeWord({ wakeWordEnabled: e.target.checked })} className="h-4 w-4 shrink-0" />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">Erkennung</label>
          <select value={settings.wakeWordProvider} onChange={(e) => {
            const provider = e.target.value as "openwakeword" | "porcupine";
            // Each engine keeps its own selected word - show that one's phrase again.
            const ref = provider === "porcupine" ? settings.wakeWordPorcupineKeyword : settings.wakeWordOwwModel;
            const name = splitModelRef(ref, "builtin")[1].split("/").pop() ?? "";
            const phrase = name.replace(/\.(onnx|ppn)$/i, "").replace(/_(de|en)_wasm_.*$/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            setWakeWord({ wakeWordProvider: provider, wakeWordPhrase: phrase || settings.wakeWordPhrase });
            setStatus(null);
          }} className={selectClass}>
            <option value="openwakeword">openWakeWord (Open Source, ohne Konto)</option>
            <option value="porcupine">Porcupine / Picovoice (AccessKey nötig, eigene Wörter auch auf Deutsch)</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Beide laufen lokal im Browser (WASM) auf dem Mikrofon-Signal – Whisper wird erst nach dem Wort benutzt. Die Modelle lädt der Server beim ersten Einsatz herunter.
          </p>
        </div>

        <div className="space-y-4 rounded bg-accent/10 p-3">
          {isOww ? (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium">Modell</label>
                <select value={settings.wakeWordOwwModel} onChange={(e) => {
                  const option = e.target.selectedOptions[0];
                  setWakeWord({ wakeWordOwwModel: e.target.value, wakeWordPhrase: option?.dataset["phrase"] || settings.wakeWordPhrase });
                }} className={selectClass}>
                  <optgroup label="Offiziell (Englisch)">
                    {(models?.openwakeword.builtin ?? [{ id: "hey_jarvis", label: "Hey Jarvis" }]).map((model) => (
                      <option key={model.id} value={`builtin:${model.id}`} data-phrase={model.label}>{model.label}{model.installed ? " ✓" : ""}</option>
                    ))}
                  </optgroup>
                  {customList.length > 0 && (
                    <optgroup label="Eigene Modelle">
                      {customList.map((model) => <option key={model.id} value={`custom:${model.id}`} data-phrase={model.label}>{model.label}</option>)}
                    </optgroup>
                  )}
                  {community && (
                    <optgroup label="Community (Home Assistant)">
                      {community.map((model) => (
                        <option key={model.id} value={`community:${model.id}`} data-phrase={model.label}>{model.label} ({model.language})</option>
                      ))}
                    </optgroup>
                  )}
                  {owwInCommunity && !community && (
                    <option value={settings.wakeWordOwwModel}>{splitModelRef(settings.wakeWordOwwModel, "community")[1]}</option>
                  )}
                </select>
                <div className="flex flex-wrap gap-2">
                  {!community && (
                    <button type="button" disabled={busy} onClick={() => void loadCommunity()} className="rounded-md border border-border px-2 py-1 text-xs hover:border-foreground/50 disabled:opacity-50">
                      Community-Modelle laden (~100 Wörter)
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Eigenes Wort wie „Hey Cryptana“: im offiziellen{" "}
                  <a className="underline" href="https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb" target="_blank" rel="noreferrer">openWakeWord-Colab</a>{" "}
                  trainieren (nur synthetische Stimmen, ca. 1 Stunde) und die .onnx-Datei hier hochladen.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">Schwellwert</label>
                  <span className="text-xs text-muted-foreground">{settings.wakeWordOwwThreshold.toFixed(2)}</span>
                </div>
                <input type="range" min="0.1" max="0.95" step="0.05" value={settings.wakeWordOwwThreshold}
                  onChange={(e) => setWakeWord({ wakeWordOwwThreshold: parseFloat(e.target.value) })} className="w-full" />
                <p className="text-xs text-muted-foreground mt-1">Niedriger = reagiert leichter (auch fälschlich), höher = nur bei deutlich gesprochenem Wort.</p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium">AccessKey</label>
                <input type="password" autoComplete="off" value={settings.wakeWordPorcupineAccessKey}
                  onChange={(e) => setWakeWord({ wakeWordPorcupineAccessKey: e.target.value })}
                  placeholder="von console.picovoice.ai" className={selectClass} />
                <p className="text-xs text-muted-foreground">
                  Kostenlos für private Nutzung auf{" "}
                  <a className="underline" href="https://console.picovoice.ai/" target="_blank" rel="noreferrer">console.picovoice.ai</a>. Der Key wird nur in diesem Browser gespeichert und vom SDK online geprüft.
                </p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Sprache des Modells</label>
                <select value={settings.wakeWordPorcupineLanguage} onChange={(e) => {
                  const language = e.target.value;
                  // Built-in keywords are English only.
                  setWakeWord(language !== "en" && settings.wakeWordPorcupineKeyword.startsWith("builtin:")
                    ? { wakeWordPorcupineLanguage: language, wakeWordPorcupineKeyword: customList[0] ? `custom:${customList[0].id}` : settings.wakeWordPorcupineKeyword }
                    : { wakeWordPorcupineLanguage: language });
                }} className={selectClass}>
                  <option value="en">Englisch</option>
                  <option value="de">Deutsch</option>
                </select>
                <p className="text-xs text-muted-foreground">Muss zur .ppn-Datei passen. Eingebaute Wörter gibt es nur auf Englisch.</p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Wort</label>
                <select value={settings.wakeWordPorcupineKeyword} onChange={(e) => {
                  const option = e.target.selectedOptions[0];
                  setWakeWord({ wakeWordPorcupineKeyword: e.target.value, wakeWordPhrase: option?.dataset["phrase"] || settings.wakeWordPhrase });
                }} className={selectClass}>
                  {settings.wakeWordPorcupineLanguage === "en" && (
                    <optgroup label="Eingebaut (Englisch)">
                      {PORCUPINE_BUILTINS.map((name) => <option key={name} value={`builtin:${name}`} data-phrase={name}>{name}</option>)}
                    </optgroup>
                  )}
                  {customList.length > 0 && (
                    <optgroup label="Eigene .ppn-Dateien">
                      {customList.map((model) => <option key={model.id} value={`custom:${model.id}`} data-phrase={model.label}>{model.label}</option>)}
                    </optgroup>
                  )}
                </select>
                <p className="text-xs text-muted-foreground">
                  Eigenes Wort: in der Picovoice-Console eingeben, Plattform „Web (WASM)“ und passende Sprache wählen, die .ppn-Datei hier hochladen.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">Empfindlichkeit</label>
                  <span className="text-xs text-muted-foreground">{settings.wakeWordPorcupineSensitivity.toFixed(2)}</span>
                </div>
                <input type="range" min="0" max="1" step="0.05" value={settings.wakeWordPorcupineSensitivity}
                  onChange={(e) => setWakeWord({ wakeWordPorcupineSensitivity: parseFloat(e.target.value) })} className="w-full" />
                <p className="text-xs text-muted-foreground mt-1">Höher = reagiert leichter, aber mehr Fehlauslösungen.</p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={uploadRef} type="file" accept={isOww ? ".onnx" : ".ppn"} className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }} />
              <button type="button" disabled={busy} onClick={() => uploadRef.current?.click()} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:border-foreground/50 disabled:opacity-50">
                <Upload className="h-3.5 w-3.5" /> {isOww ? ".onnx-Modell hochladen" : ".ppn-Datei hochladen"}
              </button>
              {selectedCustomId && (
                <button type="button" disabled={busy} onClick={() => void removeCustom(selectedCustomId)} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-red-500 hover:border-red-500/60 disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" /> Eigenes Modell löschen
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void test()} className="rounded-md border border-primary bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">
                Erkennung testen
              </button>
            </div>
            {status && (
              <p className={`text-xs ${status.tone === "error" ? "text-red-500" : status.tone === "ok" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>{status.text}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">Gesprochene Phrase</label>
          <input type="text" value={settings.wakeWordPhrase} onChange={(e) => setWakeWord({ wakeWordPhrase: e.target.value })} className={selectClass} />
          <p className="text-xs text-muted-foreground">
            Wird im Sprache-Tab angezeigt und am Anfang der Transkription entfernt, falls Whisper das Wort mitschreibt. Ändert nicht, worauf das Modell reagiert.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">Nachfrage-Fenster nach einer Antwort</label>
            <span className="text-xs text-muted-foreground">{settings.wakeWordFollowUpMs === 0 ? "aus" : `${(settings.wakeWordFollowUpMs / 1000).toFixed(0)} s`}</span>
          </div>
          <input type="range" min="0" max="30000" step="1000" value={settings.wakeWordFollowUpMs}
            onChange={(e) => setWakeWord({ wakeWordFollowUpMs: parseInt(e.target.value, 10) })} className="w-full" />
          <p className="text-xs text-muted-foreground mt-1">
            So lange darfst du nach der gesprochenen Antwort ohne Aktivierungswort weiterreden. Danach wartet der Agent wieder auf das Wort.
          </p>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Signalton bei Erkennung</label>
          <input type="checkbox" checked={settings.wakeWordChime} onChange={(e) => setWakeWord({ wakeWordChime: e.target.checked })} className="h-4 w-4 shrink-0" />
        </div>
      </div>
    </section>
  );
}
