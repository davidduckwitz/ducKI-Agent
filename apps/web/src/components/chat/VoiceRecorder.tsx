import { useState, useRef } from "react";
import { Mic, Square } from "lucide-react";

interface VoiceRecorderProps {
  onTranscribed: (text: string) => void;
  onError: (error: string) => void;
  disabled?: boolean;
}

export function VoiceRecorder({ onTranscribed, onError, disabled = false }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);

  const isSupported = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  if (!isSupported) {
    return null;
  }

  const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;

  const handleStart = () => {
    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "de-DE";

      recognition.onstart = () => setIsRecording(true);

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript + " ";
        }
        if (transcript.trim()) {
          onTranscribed(transcript.trim());
        } else {
          onError("Keine Sprache erkannt");
        }
        setIsRecording(false);
      };

      recognition.onerror = (event: any) => {
        onError(`Fehler: ${event.error}`);
        setIsRecording(false);
      };

      recognition.onend = () => setIsRecording(false);

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fehler beim Starten der Spracheingabe";
      onError(message);
      setIsRecording(false);
    }
  };

  const handleStop = () => {
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    } catch {
      // Ignore stop errors
    }
    setIsRecording(false);
  };

  return (
    <button
      type="button"
      onClick={isRecording ? handleStop : handleStart}
      disabled={disabled}
      title={isRecording ? "Aufnahme beenden" : "Spracheingabe"}
      className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
        isRecording
          ? "bg-red-500 text-white hover:bg-red-600"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {isRecording ? <Square className="h-3 w-3 fill-current" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}
