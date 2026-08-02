import { useState, useRef, useCallback } from "react";

export interface UseMediaRecorderResult {
  isRecording: boolean;
  isSupported: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
}

export function useMediaRecorder(): UseMediaRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const isSupported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError("Spracheingabe wird von diesem Browser nicht unterstützt.");
      return;
    }

    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        setError(`Aufnahmefehler: ${event.error}`);
        setIsRecording(false);
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unbekannter Fehler beim Starten der Aufnahme";
      setError(message);
      setIsRecording(false);
    }
  }, [isSupported]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || !isRecording) {
        resolve(null);
        return;
      }

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType });
        audioChunksRef.current = [];
        setIsRecording(false);

        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }

        resolve(audioBlob);
      };

      mediaRecorderRef.current.stop();
    });
  }, [isRecording]);

  return {
    isRecording,
    isSupported,
    startRecording,
    stopRecording,
    error,
  };
}
