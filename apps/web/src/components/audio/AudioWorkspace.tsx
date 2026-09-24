import { PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatContainer } from "../chat/ChatContainer";
import { VoiceOrb } from "./VoiceOrb";
import { ToolActivityBubble } from "./ToolActivityBubble";
import { ReplyBubble } from "./ReplyBubble";
import { requestVoiceToggle, requestVoiceEnd, interruptVoiceReply, onVoiceCaptureStarted, onVoiceCaptureStopped } from "../../lib/voiceCaptureBus";
import { useAppStore } from "../../lib/store";
import { stopAllPlayback } from "../../lib/voicePlaybackRegistry";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { ScreenSharePanel } from "./ScreenSharePanel";

/**
 * Voice-first workspace: an animated orb + floating tool-activity pill sit above the ordinary
 * chat view (whose transcript/tool-call list is hidden here - see ChatContainer's
 * hideTranscript). Sending, streaming, tool-call execution and TTS playback are all the
 * existing ChatContainer/ChatComposer pipeline, unmodified - this tab only adds the
 * voice-centric chrome and triggers the same capture flow via voiceCaptureBus.ts instead of
 * re-implementing it. Speaking a browser command here reaches the agent exactly like typing it
 * would: the agent already carries the browser-control skill and decides on its own whether to
 * call the `browser` tool (see packages/tools/src/browser.ts).
 */
export function AudioWorkspace() {
  const [listening, setListening] = useState(false);
  const {
    sttMode,
    continuousConversationMode,
    enableTTS,
    autoPlayTTS,
    ttsStreamingMode,
    setSTTMode,
    setContinuousConversationMode,
    setEnableTTS,
    setAutoPlayTTS,
    setTTSStreamingMode,
  } = useVoiceSettings();
  const priorSettingsRef = useRef<{
    sttMode: typeof sttMode;
    continuousConversationMode: boolean;
    enableTTS: boolean;
    autoPlayTTS: boolean;
    ttsStreamingMode: boolean;
  } | null>(null);

  useEffect(() => {
    const stopStarted = onVoiceCaptureStarted(() => setListening(true));
    const stopStopped = onVoiceCaptureStopped(() => setListening(false));
    return () => {
      stopStarted();
      stopStopped();
    };
  }, []);

  // The Audio tab is meant to be a hands-free voice agent (mic reopens automatically after each
  // reply) - force that on while the tab is open rather than requiring several manual Settings
  // toggles first, and restore whatever the user had configured for the normal Chat tab on the
  // way out. All three TTS flags matter, not just continuousConversationMode/sttMode: the
  // mic-reopen signal (useAgentTurnEndSignal, wired up in ChatMessageRow's StreamingRow) only
  // fires when `enableTTS && autoPlayTTS && ttsStreamingMode` are ALL true - if autoPlayTTS
  // happened to be off (its default), the agent's reply would render/speak fine but the turn
  // would never be reported as "ended", so the mic would silently never reopen.
  useEffect(() => {
    priorSettingsRef.current = { sttMode, continuousConversationMode, enableTTS, autoPlayTTS, ttsStreamingMode };
    setSTTMode("vad-auto");
    setContinuousConversationMode(true);
    setEnableTTS(true);
    setAutoPlayTTS(true);
    setTTSStreamingMode(true);
    return () => {
      requestVoiceEnd();
      interruptVoiceReply();
      stopAllPlayback();
      const prior = priorSettingsRef.current;
      if (prior) {
        setSTTMode(prior.sttMode);
        setContinuousConversationMode(prior.continuousConversationMode);
        setEnableTTS(prior.enableTTS);
        setAutoPlayTTS(prior.autoPlayTTS);
        setTTSStreamingMode(prior.ttsStreamingMode);
      }
    };
    // Only ever run this on mount/unmount - it deliberately overrides the persisted settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHangUp = () => {
    requestVoiceEnd();
    interruptVoiceReply();
    stopAllPlayback();
    useAppStore.getState().stopMessage();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col items-center justify-center gap-4 border-b border-white/5 bg-[#020306] px-4 py-6">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Sprachgespräch</p>
        <div className="flex min-h-[2rem] items-center">
          <ToolActivityBubble />
        </div>

        <button type="button" aria-label={listening ? "Mikrofon pausieren" : "Sprachgespräch starten"} aria-pressed={listening} onClick={() => requestVoiceToggle()} className="cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
          <VoiceOrb />
        </button>

        <p className="max-w-sm text-center text-xs text-slate-400">
          {listening ? "Sprich einfach weiter – du kannst den Agenten beim Arbeiten und Antworten unterbrechen." : "Tippe auf das Mikrofon, um das Gespräch zu starten."}
        </p>

        <ReplyBubble />

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleHangUp}
            title="Beenden"
            aria-label="Sprachgespräch beenden und Agenten stoppen"
            className="flex h-12 w-12 items-center justify-center rounded-full border border-red-500/40 bg-red-950/60 text-red-300 transition hover:bg-red-900/70"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
        <ScreenSharePanel />
      </div>

      <div className="min-h-0 flex-1">
        <ChatContainer hideTranscript />
      </div>
    </div>
  );
}
