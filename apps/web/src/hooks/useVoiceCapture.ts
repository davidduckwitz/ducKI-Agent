import { useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";
import { startVoiceActivityWatcher, unlockVoiceAudio, type VoiceActivityWatcherHandle } from "../lib/voiceActivityDetection";
import { emitVoiceCaptureStarted, emitVoiceCaptureStopped, interruptVoiceReply, onVoiceEndRequested, onVoiceToggleRequested } from "../lib/voiceCaptureBus";
import { stopAllPlayback } from "../lib/voicePlaybackRegistry";

// Live previews only work with the faster-whisper STT server; after a refusal we stop asking for
// a while instead of paying a failed request on every recording.
let partialsUnsupportedUntil = 0;
const PARTIAL_INTERVAL_MS = 1200;

function whisperLanguage(locale: string): string {
  return (locale || "").split("-")[0]?.toLowerCase() || "de";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

// One owner for permission requests, recording, transcription and hands-free restarts.
export function useVoiceCapture(callbacks: { onText: (text: string) => void; onStop: () => void; onEnd: () => void }) {
  const settings = useVoiceSettings();
  const latest = useRef({ settings, callbacks });
  latest.current = { settings, callbacks };
  const [isListening, setListening] = useState(false);
  const [voiceError, setError] = useState<string | null>(null);
  const [voiceRetryAvailable, setRetry] = useState(false);
  const [partialText, setPartialText] = useState("");
  const session = useRef(0);
  const enabled = useRef(false);
  const busy = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const watcher = useRef<VoiceActivityWatcherHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const restart = useRef<ReturnType<typeof setTimeout>>();
  const partialTimer = useRef<ReturnType<typeof setInterval>>();
  const request = useRef<AbortController | null>(null);
  const startRef = useRef<() => Promise<void>>(async () => {});

  const release = () => {
    clearTimeout(timer.current);
    clearInterval(partialTimer.current);
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
      if (!navigator.mediaDevices?.getUserMedia) {
        // Browsers hide mediaDevices on plain http:// pages (anything but localhost) - typical when
        // opening the UI via a Tailscale IP / http://name.ts.net:5173 from an iPad.
        throw new Error(window.isSecureContext === false
          ? "Mikrofon nicht verfügbar: Die Seite läuft über unverschlüsseltes HTTP. Bitte über HTTPS öffnen (z. B. `tailscale serve`, https://<name>.ts.net)."
          : "Dieser Browser unterstützt keine Mikrofonaufnahme.");
      }
      const input = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!current()) { input.getTracks().forEach((track) => track.stop()); return; }
      stream.current = input;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
        .find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(input, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      const chunks: Blob[] = [];
      capture.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      capture.onstop = async () => {
        if (!current()) return;
        release();
        setPartialText("");
        try {
          if (!heardSpeech) return;
          const blob = new Blob(chunks, { type: capture.mimeType });
          if (blob.size < 100) throw new Error("Zu kurze Aufnahme. Bitte erneut sprechen.");
          setError("Transkribiere …");
          const audio = await blobToBase64(blob);
          if (!current()) return;
          const controller = new AbortController();
          request.current = controller;
          const timeout = setTimeout(() => controller.abort(), 60000);
          try {
            const response = await fetch("/api/chat/transcribe", {
              method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
              body: JSON.stringify({ audio, mimeType: capture.mimeType, language: whisperLanguage(config.sttLanguage) }),
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
      // Timeslice so partial previews can transcribe the audio recorded so far (chunk 0 carries
      // the container header, so chunks[0..n] is always a decodable file).
      capture.start(500);
      let partialInFlight = false;
      partialTimer.current = setInterval(async () => {
        if (partialInFlight || Date.now() < partialsUnsupportedUntil || !heardSpeech || capture.state !== "recording" || !chunks.length) return;
        partialInFlight = true;
        try {
          const audio = await blobToBase64(new Blob(chunks, { type: capture.mimeType }));
          const response = await fetch("/api/chat/transcribe", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio, mimeType: capture.mimeType, language: whisperLanguage(config.sttLanguage), partial: true }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) { partialsUnsupportedUntil = Date.now() + 60_000; return; }
          if (current() && capture.state === "recording") setPartialText(result.data?.text?.trim() ?? "");
        } catch { /* previews are best effort */ }
        finally { partialInFlight = false; }
      }, PARTIAL_INTERVAL_MS);
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
    unlockVoiceAudio();
    await start();
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const offToggle = onVoiceToggleRequested(() => void toggleRef.current());
    const offEnd = onVoiceEndRequested(end);
    return () => { offToggle(); offEnd(); end(); };
  }, []);
  return { isListening, voiceError, voiceRetryAvailable, partialText, toggle, clearError };
}
