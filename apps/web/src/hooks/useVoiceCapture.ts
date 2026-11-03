import { useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";
import { startVoiceActivityWatcher, unlockVoiceAudio, type VoiceActivityWatcherHandle } from "../lib/voiceActivityDetection";
import { emitVoiceCaptureStarted, emitVoiceCaptureStopped, emitWakeWordState, interruptVoiceReply, onVoiceEndRequested, onVoiceToggleRequested } from "../lib/voiceCaptureBus";
import { stopAllPlayback } from "../lib/voicePlaybackRegistry";
import { onAgentTurnEnded } from "../lib/voiceConversationBus";
import { playWakeChime, startWakeWordListener, stripWakePhrase, type WakeWordListenerHandle } from "../lib/wakeWord";

// Live previews only work with the faster-whisper STT server; after a refusal we stop asking for
// a while instead of paying a failed request on every recording.
let partialsUnsupportedUntil = 0;
const PARTIAL_INTERVAL_MS = 1200;
// After the wake phrase the request has to start within this time, otherwise we re-arm.
const WAKE_SPEECH_DEADLINE_MS = 5000;

/** Why a recording runs: manual/hands-free as before, or triggered by the wake-word flow. */
type CaptureTrigger = "manual" | "wake" | "followup";

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
  const startRef = useRef<(trigger?: CaptureTrigger) => Promise<void>>(async () => {});
  // Wake-word mode: one long-lived mic stream; the detector listens on it and each recording
  // uses a clone, so no getUserMedia round trip clips the first words after the phrase.
  const wakeStream = useRef<MediaStream | null>(null);
  const wakeListener = useRef<WakeWordListenerHandle | null>(null);
  const armRef = useRef<() => Promise<void>>(async () => {});
  // Set when a request was sent in wake mode, so the reply's end may open the follow-up window.
  const awaitingReply = useRef(false);
  const speechDeadline = useRef<ReturnType<typeof setTimeout>>();

  const release = () => {
    clearTimeout(timer.current);
    clearTimeout(speechDeadline.current);
    clearInterval(partialTimer.current);
    watcher.current?.stop();
    watcher.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
    emitVoiceCaptureStopped();
    setListening(false);
  };
  const disarm = () => {
    wakeListener.current?.stop();
    wakeListener.current = null;
  };
  const end = () => {
    enabled.current = false;
    session.current++;
    clearTimeout(restart.current);
    request.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    disarm();
    wakeStream.current?.getTracks().forEach((track) => track.stop());
    wakeStream.current = null;
    awaitingReply.current = false;
    emitWakeWordState("off");
    busy.current = false;
    latest.current.callbacks.onEnd();
  };
  const clearError = () => { setError(null); setRetry(false); };

  const openMic = () => navigator.mediaDevices.getUserMedia({ audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } });

  const start = async (trigger: CaptureTrigger = "manual") => {
    if (busy.current || !enabled.current) return;
    busy.current = true;
    const token = session.current;
    const current = () => token === session.current && enabled.current;
    const config = latest.current.settings;
    const wakeMode = config.wakeWordEnabled;
    // Wake-word recordings always end on silence - there is nobody to click "stop".
    const vadAuto = wakeMode || config.sttMode === "vad-auto";
    let heardSpeech = !vadAuto;
    try {
      clearError();
      if (!wakeStream.current && !navigator.mediaDevices?.getUserMedia) {
        // Browsers hide mediaDevices on plain http:// pages (anything but localhost) - typical when
        // opening the UI via a Tailscale IP / http://name.ts.net:5173 from an iPad.
        throw new Error(window.isSecureContext === false
          ? "Mikrofon nicht verfügbar: Die Seite läuft über unverschlüsseltes HTTP. Bitte über HTTPS öffnen (z. B. `tailscale serve`, https://<name>.ts.net)."
          : "Dieser Browser unterstützt keine Mikrofonaufnahme.");
      }
      const input = wakeStream.current ? wakeStream.current.clone() : await openMic();
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
          if (blob.size < 100) {
            if (wakeMode) return;
            throw new Error("Zu kurze Aufnahme. Bitte erneut sprechen.");
          }
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
            const raw = result.data?.text?.trim();
            const text = raw && wakeMode ? stripWakePhrase(raw, config.wakeWordPhrase).trim() : raw;
            if (!text) {
              // Wake mode: noise or only the phrase itself - silently go back to waiting.
              if (wakeMode) return;
              throw new Error("Keine Sprache erkannt. Bitte erneut sprechen.");
            }
            clearError();
            if (wakeMode) awaitingReply.current = true;
            latest.current.callbacks.onText(text);
          } finally { clearTimeout(timeout); }
        } catch (error) {
          if (current()) {
            setError(error instanceof Error ? error.message : "Transkription fehlgeschlagen");
            // In wake mode an error must not end the session - the next phrase simply retries.
            if (!wakeMode) {
              setRetry(config.voiceRetryPromptEnabled);
              enabled.current = false;
            }
          }
        } finally {
          if (token === session.current) {
            busy.current = false;
            if (enabled.current && latest.current.settings.wakeWordEnabled) {
              restart.current = setTimeout(() => void armRef.current(), 150);
            } else if (enabled.current && latest.current.settings.continuousConversationMode) {
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
      if (!vadAuto) {
        interruptVoiceReply();
        stopAllPlayback();
        latest.current.callbacks.onStop();
      }
      setListening(true);
      if (wakeMode) emitWakeWordState("active");
      emitVoiceCaptureStarted(input);
      if (trigger === "wake" || trigger === "followup") {
        // No request started in time: discard (heardSpeech stays false) and re-arm.
        speechDeadline.current = setTimeout(() => {
          if (!heardSpeech && capture.state === "recording") capture.stop();
        }, trigger === "wake" ? WAKE_SPEECH_DEADLINE_MS : Math.max(1000, config.wakeWordFollowUpMs));
      }
      timer.current = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, config.sttMaxRecordingMs);
      if (vadAuto) {
        watcher.current = startVoiceActivityWatcher(input, {
          silenceThreshold: config.sttSilenceThreshold,
          silenceTimeoutMs: config.sttSilenceTimeoutMs,
          minSpeechMs: config.sttMinSpeechMs,
          onSpeechStart: () => {
            heardSpeech = true;
            clearTimeout(speechDeadline.current);
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

  /** Wake mode idle state: mic open, detector running, nothing recorded or sent. */
  const arm = async () => {
    if (busy.current || !enabled.current || !latest.current.settings.wakeWordEnabled) return;
    const token = session.current;
    const current = () => token === session.current && enabled.current;
    disarm();
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(window.isSecureContext === false
          ? "Mikrofon nicht verfügbar: Die Seite läuft über unverschlüsseltes HTTP. Bitte über HTTPS öffnen (z. B. `tailscale serve`, https://<name>.ts.net)."
          : "Dieser Browser unterstützt keine Mikrofonaufnahme.");
      }
      if (!wakeStream.current) {
        emitWakeWordState("loading");
        const input = await openMic();
        if (!current()) { input.getTracks().forEach((track) => track.stop()); return; }
        wakeStream.current = input;
      }
      const handle = await startWakeWordListener(wakeStream.current, latest.current.settings, () => {
        wakeListener.current = null;
        if (!current() || busy.current) return;
        awaitingReply.current = false;
        // The phrase is a barge-in: it stops whatever the agent is saying right now.
        interruptVoiceReply();
        stopAllPlayback();
        latest.current.callbacks.onStop();
        if (latest.current.settings.wakeWordChime) playWakeChime();
        void startRef.current("wake");
      });
      if (!current() || busy.current) { handle.stop(); return; }
      wakeListener.current = handle;
      clearError();
      emitWakeWordState("armed");
    } catch (error) {
      if (!current()) return;
      end();
      setError(error instanceof Error && error.name === "NotAllowedError"
        ? "Mikrofon-Berechtigung erforderlich. Bitte Zugriff erlauben."
        : `Aktivierungswort: ${error instanceof Error ? error.message : "Erkennung konnte nicht starten."}`);
      setRetry(true);
    }
  };
  armRef.current = arm;

  const toggle = async () => {
    const wakeMode = latest.current.settings.wakeWordEnabled;
    if (wakeMode && enabled.current) { end(); return; }
    if (recorder.current?.state === "recording" && latest.current.settings.sttMode !== "vad-auto") {
      recorder.current.stop();
      return;
    }
    if (busy.current) { end(); return; }
    enabled.current = true;
    unlockVoiceAudio();
    await (wakeMode ? arm() : start());
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const offToggle = onVoiceToggleRequested(() => void toggleRef.current());
    const offEnd = onVoiceEndRequested(end);
    // Follow-up window: once the reply has been spoken, the next sentence needs no wake phrase.
    const offTurnEnd = onAgentTurnEnded(() => {
      const config = latest.current.settings;
      if (!enabled.current || !config.wakeWordEnabled || !awaitingReply.current || busy.current) return;
      awaitingReply.current = false;
      if (config.wakeWordFollowUpMs <= 0) return;
      disarm();
      void startRef.current("followup");
    });
    return () => { offToggle(); offEnd(); offTurnEnd(); end(); };
  }, []);

  // Switching the mode (or the engine/model) while a session runs takes effect right away.
  const wakeKey = [settings.wakeWordEnabled, settings.wakeWordProvider, settings.wakeWordOwwModel, settings.wakeWordOwwThreshold,
    settings.wakeWordPorcupineKeyword, settings.wakeWordPorcupineLanguage, settings.wakeWordPorcupineSensitivity, settings.wakeWordPorcupineAccessKey].join("|");
  const wakeKeyRef = useRef(wakeKey);
  useEffect(() => {
    if (wakeKeyRef.current === wakeKey) return;
    const modeChanged = wakeKeyRef.current.split("|")[0] !== wakeKey.split("|")[0];
    wakeKeyRef.current = wakeKey;
    if (!enabled.current) return;
    if (modeChanged) {
      end();
      enabled.current = true;
      void (settings.wakeWordEnabled ? armRef.current() : startRef.current());
    } else if (wakeListener.current) {
      void armRef.current();
    }
  }, [wakeKey]);
  return { isListening, voiceError, voiceRetryAvailable, partialText, toggle, clearError };
}
