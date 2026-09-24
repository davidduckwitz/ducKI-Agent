import { useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";
import { startVoiceActivityWatcher, type VoiceActivityWatcherHandle } from "../lib/voiceActivityDetection";
import { emitVoiceCaptureStarted, emitVoiceCaptureStopped, interruptVoiceReply, onVoiceEndRequested, onVoiceToggleRequested } from "../lib/voiceCaptureBus";
import { stopAllPlayback } from "../lib/voicePlaybackRegistry";

// One owner for permission requests, recording, transcription and hands-free restarts.
export function useVoiceCapture(callbacks: { onText: (text: string) => void; onStop: () => void; onEnd: () => void }) {
  const settings = useVoiceSettings();
  const latest = useRef({ settings, callbacks });
  latest.current = { settings, callbacks };
  const [isListening, setListening] = useState(false);
  const [voiceError, setError] = useState<string | null>(null);
  const [voiceRetryAvailable, setRetry] = useState(false);
  const session = useRef(0);
  const enabled = useRef(false);
  const busy = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const watcher = useRef<VoiceActivityWatcherHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const restart = useRef<ReturnType<typeof setTimeout>>();
  const request = useRef<AbortController | null>(null);
  const startRef = useRef<() => Promise<void>>(async () => {});

  const release = () => {
    clearTimeout(timer.current);
    watcher.current?.stop();
    watcher.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
    emitVoiceCaptureStopped();
    setListening(false);
  };
  const end = () => {
    enabled.current = false;
    session.current++;
    clearTimeout(restart.current);
    request.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    busy.current = false;
    latest.current.callbacks.onEnd();
  };
  const clearError = () => { setError(null); setRetry(false); };

  const start = async () => {
    if (busy.current || !enabled.current) return;
    busy.current = true;
    const token = session.current;
    const current = () => token === session.current && enabled.current;
    const config = latest.current.settings;
    let heardSpeech = config.sttMode !== "vad-auto";
    try {
      clearError();
      const input = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!current()) { input.getTracks().forEach((track) => track.stop()); return; }
      stream.current = input;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(input, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      const chunks: Blob[] = [];
      capture.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      capture.onstop = async () => {
        if (!current()) return;
        release();
        try {
          if (!heardSpeech) return;
          const blob = new Blob(chunks, { type: capture.mimeType });
          if (blob.size < 100) throw new Error("Zu kurze Aufnahme. Bitte erneut sprechen.");
          setError("Transkribiere …");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          }
          if (!current()) return;
          const controller = new AbortController();
          request.current = controller;
          const timeout = setTimeout(() => controller.abort(), 60000);
          try {
            const response = await fetch("/api/chat/transcribe", {
              method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
              body: JSON.stringify({ audio: btoa(binary), mimeType: capture.mimeType }),
            });
            const result = await response.json();
            if (!current()) return;
            if (!response.ok) throw new Error(result.error || "Transkription fehlgeschlagen");
            const text = result.data?.text?.trim();
            if (!text) throw new Error("Keine Sprache erkannt. Bitte erneut sprechen.");
            clearError();
            latest.current.callbacks.onText(text);
          } finally { clearTimeout(timeout); }
        } catch (error) {
          if (current()) {
            setError(error instanceof Error ? error.message : "Transkription fehlgeschlagen");
            setRetry(config.voiceRetryPromptEnabled);
            enabled.current = false;
          }
        } finally {
          if (token === session.current) {
            busy.current = false;
            if (enabled.current && latest.current.settings.continuousConversationMode) {
              restart.current = setTimeout(() => void startRef.current(), 150);
            }
          }
        }
      };
      capture.onerror = () => {
        end();
        setError("Aufnahmefehler. Bitte Mikrofon prüfen und erneut starten.");
        setRetry(true);
      };
      capture.start();
      if (config.sttMode !== "vad-auto") {
        interruptVoiceReply();
        stopAllPlayback();
        latest.current.callbacks.onStop();
      }
      setListening(true);
      emitVoiceCaptureStarted(input);
      timer.current = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, config.sttMaxRecordingMs);
      if (config.sttMode === "vad-auto") {
        watcher.current = startVoiceActivityWatcher(input, {
          silenceThreshold: config.sttSilenceThreshold,
          silenceTimeoutMs: config.sttSilenceTimeoutMs,
          minSpeechMs: config.sttMinSpeechMs,
          onSpeechStart: () => {
            heardSpeech = true;
            interruptVoiceReply();
            stopAllPlayback();
            latest.current.callbacks.onStop();
          },
          onSilenceStop: () => { if (capture.state === "recording") capture.stop(); },
        });
      }
    } catch (error) {
      if (!current()) return;
      end();
      setError(error instanceof Error && error.name === "NotAllowedError"
        ? "Mikrofon-Berechtigung erforderlich. Bitte Zugriff erlauben."
        : error instanceof Error ? error.message : "Sprachaufnahme konnte nicht starten.");
      setRetry(true);
    }
  };
  startRef.current = start;
  const toggle = async () => {
    if (recorder.current?.state === "recording" && latest.current.settings.sttMode !== "vad-auto") {
      recorder.current.stop();
      return;
    }
    if (busy.current) { end(); return; }
    enabled.current = true;
    await start();
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const offToggle = onVoiceToggleRequested(() => void toggleRef.current());
    const offEnd = onVoiceEndRequested(end);
    return () => { offToggle(); offEnd(); end(); };
  }, []);
  return { isListening, voiceError, voiceRetryAvailable, toggle, clearError };
}
