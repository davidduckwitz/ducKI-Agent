import { Volume2, Mic } from "lucide-react";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";

export function VoiceSettings() {
  const {
    // STT
    enableSTT,
    setEnableSTT,
    sttLanguage,
    setSTTLanguage,
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
    autoPlayTTS,
    setAutoPlayTTS,
    ttsQuality,
    setTTSQuality,
  } = useVoiceSettings();

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
                  onChange={(e) => setTTSProvider(e.target.value as "web-speech-api" | "openai" | "silero")}
                  className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="web-speech-api">Web Speech API (Browser-native)</option>
                  <option value="silero" disabled>
                    Silero TTS (Server) - Kommt bald
                  </option>
                  <option value="openai" disabled>
                    OpenAI TTS (API) - Kommt bald
                  </option>
                </select>
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

      {/* Info */}
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-900 dark:text-blue-100">
        <p className="font-semibold mb-1">💡 Tipp:</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>Spracheingabe startet/stoppt mit dem 🎤 Button in der Chat-Eingabe</li>
          <li>Sprachausgabe startet mit dem 🔊 Button neben den Agent-Antworten</li>
          <li>Web Speech API funktioniert offline, aber mit Standard-Stimmen</li>
          <li>Silero TTS und OpenAI TTS für höhere Qualität folgen bald</li>
        </ul>
      </div>
    </div>
  );
}
