import { useEffect, useRef, useState } from "react";
import { Volume2, Square } from "lucide-react";
import { useSpeechSynthesis } from "../../hooks/useSpeechSynthesis";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { useAgentTurnEndSignal } from "../../hooks/useAgentTurnEndSignal";
import { stripMarkdownForSpeech } from "../../lib/stripMarkdownForSpeech";
import { isReplyInterrupted, takeUnstreamedRemainder } from "../../lib/streamedSpeechRegistry";

interface VoicePlaybackProps {
  text: string;
  disabled?: boolean;
  /** Only true for a freshly-completed agent message - lets this instance auto-speak once on mount. */
  autoPlay?: boolean;
}

export function VoicePlayback({ text, disabled = false, autoPlay = false }: VoicePlaybackProps) {
  const { enableTTS, autoPlayTTS, ttsStripMarkdown, ttsStreamingMode } = useVoiceSettings();
  const { speak, stop, isPlaying, error } = useSpeechSynthesis();

  const speakable = ttsStripMarkdown ? stripMarkdownForSpeech(text) : text;
  const hasAutoPlayedRef = useRef(false);
  // True once this row had to speak (part of) its text itself in streaming mode - then it, not
  // StreamingRow, owns the "agent finished talking" signal for continuous conversation.
  const [streamFallbackPlayed, setStreamFallbackPlayed] = useState(false);

  // Fires once per mount - MessageRow mounts exactly once per completed agent message
  // (keyed by msg.id), so this never re-triggers on unrelated re-renders. In streaming mode
  // only the part useStreamingSpeech did not already speak is played (see
  // streamedSpeechRegistry.ts) - speaking everything again would repeat it.
  //
  // The ref guard also protects against React 18 StrictMode (dev only), which invokes a
  // fresh effect's setup twice on mount to catch missing cleanup - without it, this would
  // speak the same message twice in dev.
  useEffect(() => {
    if (hasAutoPlayedRef.current) return;
    if (!autoPlay || !autoPlayTTS || !enableTTS || !speakable.trim()) return;
    hasAutoPlayedRef.current = true;
    if (!ttsStreamingMode) {
      speak(speakable);
      return;
    }
    // Streaming mode: useStreamingSpeech normally spoke this block already, but only as far as
    // chat:chunk actually delivered it. Speak whatever it did not cover. Deferred because this
    // row's effect runs before StreamingRow's (tree order) in the same commit that closes the
    // block, i.e. before the streaming hook has flushed/recorded its part.
    const timer = setTimeout(() => {
      if (isReplyInterrupted()) return;
      const remainder = takeUnstreamedRemainder(text);
      const spoken = ttsStripMarkdown ? stripMarkdownForSpeech(remainder) : remainder;
      if (!spoken.trim()) return;
      setStreamFallbackPlayed(true);
      speak(spoken);
    }, 150);
    return () => {
      clearTimeout(timer);
      // StrictMode's simulated unmount must not swallow the autoplay.
      hasAutoPlayedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAgentTurnEndSignal(
    isPlaying,
    Boolean(autoPlay) && autoPlayTTS && enableTTS && (!ttsStreamingMode || streamFallbackPlayed)
  );

  if (!enableTTS || !text.trim()) {
    return null;
  }

  const handleToggle = () => {
    if (isPlaying) {
      stop();
    } else {
      speak(speakable);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        title={isPlaying ? "Sprachausgabe stoppen" : "Sprachausgabe starten"}
        className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
          isPlaying
            ? "bg-primary/20 text-primary hover:bg-primary/30"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isPlaying ? (
          <Square className="h-3 w-3 fill-current" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
