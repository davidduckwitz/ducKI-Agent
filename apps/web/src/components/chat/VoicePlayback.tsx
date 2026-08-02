import { useState } from "react";
import { Volume2, Square, Loader2 } from "lucide-react";
import { useSpeechSynthesis } from "../../hooks/useSpeechSynthesis";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";

interface VoicePlaybackProps {
  text: string;
  disabled?: boolean;
}

export function VoicePlayback({ text, disabled = false }: VoicePlaybackProps) {
  const { enableTTS } = useVoiceSettings();
  const { speak, stop, isPlaying } = useSpeechSynthesis();
  const [error, setError] = useState<string | null>(null);

  if (!enableTTS || !text.trim()) {
    return null;
  }

  const handleToggle = () => {
    setError(null);
    if (isPlaying) {
      stop();
    } else {
      speak(text);
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
