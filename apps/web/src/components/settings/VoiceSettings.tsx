import { ChatterboxControls } from "./ChatterboxControls";
import { useEffect, useState } from "react";
import { Volume2, Mic, MessageCircle } from "lucide-react";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { providerSupportsRealtimeStreaming, providerSupportsEmotionInstructions } from "../../lib/ttsProviderCapabilities";

interface VoiceOption {
  voiceId: string;
  name: string;
}

export function VoiceSettings() {
  const {
    // STT
    enableSTT,
    setEnableSTT,
    sttLanguage,
    setSTTLanguage,
    sttMode,
    setSTTMode,
    sttMaxRecordingMs,
    setSTTMaxRecordingMs,
    sttSilenceTimeoutMs,
    setSTTSilenceTimeoutMs,
    sttSilenceThreshold,
    setSTTSilenceThreshold,
    sttMinSpeechMs,
    setSTTMinSpeechMs,
    // TTS
    enableTTS,
    setEnableTTS,
    ttsProvider,
    setTTSProvider,
    ttsLanguage,
    setTTSLanguage,
    ttsSpeed,
    setTTSSpeed,
    ttsPitch,
    setTTSPitch,
    ttsVolume,
    setTTSVolume,
    ttsVoice,
    setTTSVoice,
    ttsStreamingMode,
    setTTSStreamingMode,
    ttsEmotionStyle,
    setTTSEmotionStyle,
    ttsEmotionInstructions,
    setTTSEmotionInstructions,
    ttsStripMarkdown,
    setTTSStripMarkdown,
    autoPlayTTS,
    setAutoPlayTTS,
    ttsQuality,
    setTTSQuality,
    // Conversation
    continuousConversationMode,
    setContinuousConversationMode,
    agentVoiceReplyStyle,
    setAgentVoiceReplyStyle,
    voiceRetryPromptEnabled,
    setVoiceRetryPromptEnabled,
  } = useVoiceSettings();

  const providerSupportsStyle = ttsProvider === "elevenlabs" || ttsProvider === "chatterbox";
  const providerSupportsVoicePicker =
    ttsProvider === "openai" || ttsProvider === "elevenlabs" || ttsProvider === "chatterbox" || ttsProvider === "breeze";
  const providerIsLocal = ttsProvider === "piper" || ttsProvider === "local" || ttsProvider === "chatterbox";
  const providerHasSearchableVoices = ttsProvider === "breeze";

  const [availableVoices, setAvailableVoices] = useState<VoiceOption[]>([]);
  const [voiceSearch, setVoiceSearch] = useState("");


  useEffect(() => {
    if (ttsProvider !== "elevenlabs" && ttsProvider !== "chatterbox" && ttsProvider !== "breeze") {
      setAvailableVoices([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ provider: ttsProvider });
    if (ttsProvider === "breeze" && voiceSearch.trim()) params.set("q", voiceSearch.trim());
    const handle = setTimeout(() => {
      fetch(`/api/chat/tts-voices?${params.toString()}`)
        .then((res) => res.json())
        .then((body: { data?: { voices?: VoiceOption[] } }) => {
          if (!cancelled) setAvailableVoices(body.data?.voices ?? []);
        })
        .catch(() => {
          if (!cancelled) setAvailableVoices([]);
        });
    }, ttsProvider === "breeze" ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [ttsProvider, voiceSearch]);


  return (
    <div className="space-y-6">
      {/* Spracheingabe (STT) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Mic className="h-5 w-5" />
          <h3 className="text-base font-semibold">Spracheingabe (STT)</h3>
        </div>

        <div className="space-y-3 pl-7">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Spracheingabe aktivieren</label>
            <input
              type="checkbox"
              checked={enableSTT}
              onChange={(e) => setEnableSTT(e.target.checked)}
              className="h-4 w-4"
            />
          </div>

          {enableSTT && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium">Sprache</label>
                <select
                  value={sttLanguage}
                  onChange={(e) => setSTTLanguage(e.target.value)}
                  className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="de-DE">Deutsch (DE)</option>
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (GB)</option>
                  <option value="fr-FR">Français (FR)</option>
                  <option value="es-ES">Español (ES)</option>
                  <option value="it-IT">Italiano (IT)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Aufnahme-Modus</label>
                <select
                  value={sttMode}
                  onChange={(e) => setSTTMode(e.target.value as "push-to-talk" | "vad-auto")}
                  className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="push-to-talk">Push-to-Talk (manuell stoppen)</option>
                  <option value="vad-auto">Automatisch (stoppt bei Stille)</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  "Automatisch" erkennt Sprechpausen und beendet die Aufnahme selbstständig - Voraussetzung für
                  durchgehende Gespräche.
                </p>
              </div>

              {sttMode === "push-to-talk" && (
                <div className="rounded bg-accent/10 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium">Maximale Aufnahmedauer</label>
                    <span className="text-xs text-muted-foreground">{(sttMaxRecordingMs / 1000).toFixed(0)}s</span>
                  </div>
                  <input
                    type="range"
                    min="3000"
                    max="120000"
                    step="1000"
                    value={sttMaxRecordingMs}
                    onChange={(e) => setSTTMaxRecordingMs(parseInt(e.target.value, 10))}
                    className="w-full"
                  />
                </div>
              )}

              {sttMode === "vad-auto" && (
                <div className="space-y-4 rounded bg-accent/10 p-3">
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium">Reaktions-Preset</label>
                    <div className="flex gap-1.5">
                      {(
                        [
                          { key: "fast", label: "Schnell", timeout: 500, threshold: 0.02, minSpeech: 250 },
                          { key: "balanced", label: "Ausgewogen", timeout: 750, threshold: 0.02, minSpeech: 300 },
                          { key: "relaxed", label: "Entspannt", timeout: 1500, threshold: 0.015, minSpeech: 400 },
                        ] as const
                      ).map((preset) => (
                        <button
                          key={preset.key}
                          type="button"
                          onClick={() => {
                            setSTTSilenceTimeoutMs(preset.timeout);
                            setSTTSilenceThreshold(preset.threshold);
                            setSTTMinSpeechMs(preset.minSpeech);
                          }}
                          className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                            sttSilenceTimeoutMs === preset.timeout
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground"
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Setzt Stille-Timeout, Empfindlichkeit und Mindest-Sprechdauer zusammen. Die Regler darunter
                      erlauben Feinjustierung.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Stille-Timeout</label>
                      <span className="text-xs text-muted-foreground">{sttSilenceTimeoutMs} ms</span>
                    </div>
                    <input
                      type="range"
                      min="300"
                      max="5000"
                      step="100"
                      value={sttSilenceTimeoutMs}
                      onChange={(e) => setSTTSilenceTimeoutMs(parseInt(e.target.value, 10))}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Wie lange Stille die Aufnahme beendet, nachdem gesprochen wurde.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Empfindlichkeit (Schwellwert)</label>
                      <span className="text-xs text-muted-foreground">{sttSilenceThreshold.toFixed(3)}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="0.2"
                      step="0.005"
                      value={sttSilenceThreshold}
                      onChange={(e) => setSTTSilenceThreshold(parseFloat(e.target.value))}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Niedriger = empfindlicher (erkennt leise Sprache), höher = unempfindlicher gegen Hintergrundgeräusche.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Mindest-Sprechdauer</label>
                      <span className="text-xs text-muted-foreground">{sttMinSpeechMs} ms</span>
                    </div>
                    <input
                      type="range"
                      min="100"
                      max="3000"
                      step="100"
                      value={sttMinSpeechMs}
                      onChange={(e) => setSTTMinSpeechMs(parseInt(e.target.value, 10))}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Kürzere Laute (Räuspern, Klicks) werden ignoriert und lösen keine Aufnahme aus.
                    </p>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Nutzt die Web Speech API des Browsers für Echtzeit-Transkription
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Sprachausgabe (TTS) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Volume2 className="h-5 w-5" />
          <h3 className="text-base font-semibold">Sprachausgabe (TTS)</h3>
        </div>

        <div className="space-y-3 pl-7">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Sprachausgabe aktivieren</label>
            <input
              type="checkbox"
              checked={enableTTS}
              onChange={(e) => setEnableTTS(e.target.checked)}
              className="h-4 w-4"
            />
          </div>

          {enableTTS && (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="block text-sm font-medium">TTS-Provider</label>
                <select
                  value={ttsProvider}
                  onChange={(e) =>
                    setTTSProvider(
                      e.target.value as
                        | "web-speech-api"
                        | "openai"
                        | "elevenlabs"
                        | "piper"
                        | "local"
                        | "silero"
                        | "chatterbox"
                        | "breeze"
                    )
                  }
                  className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="chatterbox">Chatterbox Multilingual V3 (lokal, Emotion-Regler)</option>
                  <option value="breeze">Breeze TTS (Cloud, Streaming, freie Emotion-Steuerung)</option>
                  <option value="web-speech-api">Web Speech API (Browser-native, inkl. Windows Neural Voices)</option>
                  <option value="openai">OpenAI TTS (Cloud)</option>
                  <option value="elevenlabs">ElevenLabs TTS (Cloud, Emotion/Style)</option>
                  <option value="piper">Piper TTS (lokal, self-hosted, keine Cloud)</option>
                  <option value="local">Eigenes lokales Kommando (self-hosted)</option>
                  <option value="silero" disabled>
                    Silero TTS (Server) - Kommt bald
                  </option>
                </select>
                {ttsProvider === "chatterbox" && <ChatterboxControls />}
                {ttsProvider === "breeze" && (
                  <p className="text-xs text-muted-foreground">
                    Breeze-API-Key wird unter Settings → Speech hinterlegt. Cloud-Dienst ohne Selbst-Hosting-Option.
                  </p>
                )}
                {providerSupportsRealtimeStreaming(ttsProvider) && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">
                    Streaming-fähig: Antworten werden in kleinen Textabschnitten statt satzweise gesprochen -
                    spürbar weniger Pausen.
                  </p>
                )}
                {providerSupportsVoicePicker && (
                  <p className="text-xs text-muted-foreground">
                    Server-Zugangsdaten (API-Key, Modell, Stimme) werden unter Settings → Speech konfiguriert.
                  </p>
                )}
                {providerIsLocal && (
                  <p className="text-xs text-muted-foreground">
                    Läuft komplett lokal als eigener Prozess, keine Daten verlassen die Maschine. Ausführbare Datei,
                    Stimm-Modell und Tempo/Ausdruck-Parameter werden unter Settings → Speech konfiguriert.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Sprache</label>
                <select
                  value={ttsLanguage}
                  onChange={(e) => setTTSLanguage(e.target.value)}
                  className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="de-DE">Deutsch (DE)</option>
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (GB)</option>
                  <option value="fr-FR">Français (FR)</option>
                  <option value="es-ES">Español (ES)</option>
                  <option value="it-IT">Italiano (IT)</option>
                </select>
              </div>

              {providerHasSearchableVoices && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Stimmen durchsuchen</label>
                  <input
                    type="text"
                    value={voiceSearch}
                    onChange={(e) => setVoiceSearch(e.target.value)}
                    placeholder="z. B. deutsch, männlich, ruhig..."
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground">
                    Über 15.000 Stimmen in der Breeze Voice Galaxy - Suchbegriff eingeben statt einer vollständigen Liste.
                  </p>
                </div>
              )}

              {providerSupportsVoicePicker && ttsProvider === "chatterbox" && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Stimme</label>
                  <select
                    value={ttsVoice || "default"}
                    onChange={(e) => setTTSVoice(e.target.value === "default" ? "" : e.target.value)}
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {availableVoices.length === 0 && <option value="default">Chatterbox Standard</option>}
                    {availableVoices.map((v) => (
                      <option key={v.voiceId} value={v.voiceId}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Chatterbox klont Stimmen aus einer Referenzaufnahme statt vorgefertigter Presets zu nutzen - eigene
                    .wav-Datei unter <code className="rounded bg-muted px-1">apps/server/scripts/voices/</code> ablegen,
                    dann erscheint sie hier (siehe apps/server/scripts/README.md).
                  </p>
                </div>
              )}

              {providerSupportsVoicePicker && ttsProvider !== "chatterbox" && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Stimme (Voice-ID)</label>
                  <input
                    type="text"
                    list="tts-voice-options"
                    value={ttsVoice}
                    onChange={(e) => setTTSVoice(e.target.value)}
                    placeholder={ttsProvider === "openai" ? "z. B. alloy, nova, shimmer" : "Voice-ID"}
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  {availableVoices.length > 0 && (
                    <datalist id="tts-voice-options">
                      {availableVoices.map((v) => (
                        <option key={v.voiceId} value={v.voiceId}>
                          {v.name}
                        </option>
                      ))}
                    </datalist>
                  )}
                  {(ttsProvider === "elevenlabs" || ttsProvider === "breeze") && (
                    <p className="text-xs text-muted-foreground">
                      {availableVoices.length > 0
                        ? `${availableVoices.length} Stimme(n) verfügbar (Vorschläge im Feld).`
                        : "Keine Stimmen gefunden - Voice-ID manuell eintragen oder Zugangsdaten/Server prüfen."}
                    </p>
                  )}
                </div>
              )}

              {providerSupportsStyle && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Emotion / Sprechstil</label>
                  <select
                    value={ttsEmotionStyle}
                    onChange={(e) => setTTSEmotionStyle(e.target.value as typeof ttsEmotionStyle)}
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="neutral">Neutral</option>
                    <option value="cheerful">Fröhlich</option>
                    <option value="calm">Ruhig</option>
                    <option value="empathetic">Einfühlsam</option>
                    <option value="excited">Begeistert</option>
                  </select>
                </div>
              )}

              {providerSupportsEmotionInstructions(ttsProvider) && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Emotion / Sprechstil (Freitext)</label>
                  <input
                    type="text"
                    value={ttsEmotionInstructions}
                    onChange={(e) => setTTSEmotionInstructions(e.target.value)}
                    placeholder="z. B. warm, leicht spielerisch, entspanntes Tempo"
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground">
                    Freitext-Beschreibung des Sprechstils - überschreibt das Preset oben, wenn ausgefüllt. Leer lassen,
                    um stattdessen das Preset zu nutzen.
                    {ttsProvider === "openai" && " Wird bei OpenAI nur mit Modell \"gpt-4o-mini-tts\" berücksichtigt (Settings → Speech)."}
                  </p>
                </div>
              )}

              {ttsProvider === "web-speech-api" && (
                <div className="space-y-4 rounded bg-accent/10 p-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Geschwindigkeit</label>
                      <span className="text-xs text-muted-foreground">{ttsSpeed.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={ttsSpeed}
                      onChange={(e) => setTTSSpeed(parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Tonhöhe</label>
                      <span className="text-xs text-muted-foreground">{ttsPitch.toFixed(1)}</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={ttsPitch}
                      onChange={(e) => setTTSPitch(parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium">Lautstärke</label>
                      <span className="text-xs text-muted-foreground">{(ttsVolume * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={ttsVolume}
                      onChange={(e) => setTTSVolume(parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              )}

              {providerSupportsVoicePicker && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Qualität</label>
                  <select
                    value={ttsQuality}
                    onChange={(e) => setTTSQuality(e.target.value as "low" | "high")}
                    className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="low">Niedrig (schneller)</option>
                    <option value="high">Hoch (tts-1-hd o.ä.)</option>
                  </select>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <div>
                  <label className="text-sm font-medium block">Satzweises Streaming</label>
                  <p className="text-xs text-muted-foreground">
                    Beginnt zu sprechen, sobald der erste Satz fertig ist, statt auf die komplette Antwort zu warten.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={ttsStreamingMode}
                  onChange={(e) => setTTSStreamingMode(e.target.checked)}
                  className="h-4 w-4 shrink-0"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Markdown vor dem Sprechen entfernen</label>
                <input
                  type="checkbox"
                  checked={ttsStripMarkdown}
                  onChange={(e) => setTTSStripMarkdown(e.target.checked)}
                  className="h-4 w-4"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <label className="text-sm font-medium">Automatische Wiedergabe</label>
                <input
                  type="checkbox"
                  checked={autoPlayTTS}
                  onChange={(e) => setAutoPlayTTS(e.target.checked)}
                  className="h-4 w-4"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Gespräch (Conversation) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5" />
          <h3 className="text-base font-semibold">Gespräch</h3>
        </div>

        <div className="space-y-3 pl-7">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium block">Durchgehendes Gespräch (Hands-free)</label>
              <p className="text-xs text-muted-foreground">
                Öffnet das Mikrofon nach jeder Antwort automatisch wieder - kein erneuter Klick nötig. Benötigt
                Aufnahme-Modus "Automatisch".
              </p>
            </div>
            <input
              type="checkbox"
              checked={continuousConversationMode}
              onChange={(e) => setContinuousConversationMode(e.target.checked)}
              className="h-4 w-4 shrink-0"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium block">Bei Stille nachfragen</label>
              <p className="text-xs text-muted-foreground">
                Wenn keine Sprache erkannt wurde, bietet der Agent einen erneuten Versuch an statt stumm abzubrechen.
              </p>
            </div>
            <input
              type="checkbox"
              checked={voiceRetryPromptEnabled}
              onChange={(e) => setVoiceRetryPromptEnabled(e.target.checked)}
              className="h-4 w-4 shrink-0"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium">Antwortstil im Sprachmodus</label>
            <select
              value={agentVoiceReplyStyle}
              onChange={(e) => setAgentVoiceReplyStyle(e.target.value as "adapt" | "unchanged")}
              className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="adapt">Anpassen (kürzer, ohne Markdown, fragt bei Unklarheit nach)</option>
              <option value="unchanged">Unverändert (wie im Text-Chat)</option>
            </select>
          </div>
        </div>
      </section>

      {/* Info */}
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-100">
        <p className="font-semibold mb-1">💡 Tipp:</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>Spracheingabe startet/stoppt mit dem 🎤 Button in der Chat-Eingabe</li>
          <li>Sprachausgabe startet mit dem 🔊 Button neben den Agent-Antworten</li>
          <li>Web Speech API funktioniert offline, aber mit Standard-Stimmen</li>
          <li>OpenAI/ElevenLabs-Zugangsdaten werden unter Settings → Speech eingetragen</li>
        </ul>
      </div>
    </div>
  );
}
