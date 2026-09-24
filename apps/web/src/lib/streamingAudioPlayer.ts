import { getAudioStreamWsUrl } from "./backendUrl";
import { registerActivePlayback } from "./voicePlaybackRegistry";
import { onVoiceReplyInterrupted } from "./voiceCaptureBus";
import { registerVoiceOutput } from "./voiceOutputAnalyser";

export interface StreamingAudioPlayerOptions {
  voice?: string;
  emotionStyle?: string;
  emotionInstructions?: string;
  language?: string;
  volume?: number;
  playbackRate?: number;
}

export interface StreamingAudioPlayer {
  /** Opens the WS connection (idempotent) and prepares playback. */
  start: () => void;
  /** Queues a text chunk to be synthesized and played next, in submission order. */
  pushText: (text: string) => void;
  /** No more text for this turn; closes once any already-queued audio has played. */
  end: () => void;
  /** Immediately stops playback and tears down the connection. */
  stop: () => void;
  onPlayingChange: (listener: (isPlaying: boolean) => void) => () => void;
  onError: (listener: (message: string) => void) => () => void;
}

type ServerMessage =
  | { type: "meta"; sampleRate: number; containerMimeType?: string }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * Client side of apps/server/src/websocket/audio-stream.ts's protocol - see that file's
 * docstring for the wire format. One instance per active streaming turn; useStreamingSpeech.ts
 * creates a fresh one per agent turn rather than reusing across turns, to keep turn boundaries
 * (and therefore text-queue ordering) unambiguous.
 */
export function createStreamingAudioPlayer(options: StreamingAudioPlayerOptions): StreamingAudioPlayer {
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let socket: WebSocket | null = null;
  let audioContext: AudioContext | null = null;
  let outputAnalyser: AnalyserNode | null = null;
  let unregisterOutput: (() => void) | undefined;
  let sampleRate: number | null = null;
  let containerMimeType: string | undefined;
  let nextStartTime = 0;
  let pendingSources = 0;
  let isPlaying = false;
  let stopped = false;
  let ending = false;
  let pendingDecodes = 0;
  let unregisterPlayback: (() => void) | undefined;
  let unsubscribeInterrupt: (() => void) | undefined;

  const textQueue: string[] = [];
  let sending = false;

  const playingListeners = new Set<(v: boolean) => void>();
  const errorListeners = new Set<(m: string) => void>();

  const setPlaying = (value: boolean) => {
    if (isPlaying === value) return;
    isPlaying = value;
    if (value) unregisterPlayback ??= registerActivePlayback(stop);
    else { unregisterPlayback?.(); unregisterPlayback = undefined; }
    playingListeners.forEach((l) => l(value));
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    textQueue.length = 0;
    setPlaying(false);
    unsubscribeInterrupt?.();
    unsubscribeInterrupt = undefined;
    unregisterOutput?.();
    unregisterOutput = undefined;
    outputAnalyser = null;
    socket?.close();
    socket = null;
    if (audioContext) {
      void audioContext.close().catch(() => {});
      audioContext = null;
    }
  };
  const finishIfDrained = () => {
    if (ending && !sending && !textQueue.length && !pendingSources && !pendingDecodes) stop();
  };

  const reportError = (message: string) => {
    errorListeners.forEach((l) => l(message));
  };

  const ensureAudioContext = (): AudioContext | null => {
    if (!AudioContextCtor) return null;
    if (!audioContext) {
      audioContext = new AudioContextCtor();
      outputAnalyser = audioContext.createAnalyser();
      outputAnalyser.fftSize = 1024;
      outputAnalyser.smoothingTimeConstant = 0.75;
      outputAnalyser.connect(audioContext.destination);
      unregisterOutput = registerVoiceOutput(outputAnalyser);
    }
    // Must be resumed from a user-gesture call stack (start() is called from the mic button
    // click handler) - browsers block autoplay of a freshly-created/suspended context otherwise.
    void audioContext.resume().catch(() => {});
    return audioContext;
  };

  const schedulePcmChunk = (buffer: ArrayBuffer) => {
    const ctx = ensureAudioContext();
    if (!ctx || !sampleRate) return;
    const int16 = new Int16Array(buffer);
    if (int16.length === 0) return;
    const audioBuffer = ctx.createBuffer(1, int16.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) channel[i] = (int16[i] ?? 0) / 32768;
    scheduleAudioBuffer(ctx, audioBuffer);
  };

  const scheduleContainerChunk = async (buffer: ArrayBuffer) => {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    pendingDecodes++;
    try {
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      scheduleAudioBuffer(ctx, audioBuffer);
    } catch (err) {
      reportError(err instanceof Error ? err.message : "Audio-Dekodierung fehlgeschlagen");
    } finally {
      pendingDecodes--;
      finishIfDrained();
    }
  };

  const scheduleAudioBuffer = (ctx: AudioContext, audioBuffer: AudioBuffer) => {
    if (stopped) return;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = options.playbackRate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = options.volume ?? 1;
    source.connect(gain);
    gain.connect(outputAnalyser ?? ctx.destination);

    const startAt = Math.max(ctx.currentTime, nextStartTime);
    source.start(startAt);
    nextStartTime = startAt + audioBuffer.duration / (options.playbackRate ?? 1);
    pendingSources++;
    setPlaying(true);
    source.onended = () => {
      pendingSources--;
      if (pendingSources <= 0) setPlaying(false);
      source.disconnect();
      gain.disconnect();
      finishIfDrained();
    };
  };

  const sendNextQueued = () => {
    if (sending || stopped) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const text = textQueue.shift();
    if (text === undefined) { finishIfDrained(); return; }
    sending = true;
    socket.send(
      JSON.stringify({
        type: "speak",
        text,
        voice: options.voice,
        emotionStyle: options.emotionStyle,
        emotionInstructions: options.emotionInstructions,
        language: options.language,
      })
    );
  };

  const connect = () => {
    if (socket) return;
    socket = new WebSocket(getAudioStreamWsUrl());
    socket.binaryType = "arraybuffer";

    socket.onopen = () => sendNextQueued();

    socket.onmessage = (event) => {
      if (stopped) return;
      if (typeof event.data === "string") {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "meta") {
          sampleRate = msg.sampleRate;
          containerMimeType = msg.containerMimeType;
        } else if (msg.type === "done") {
          sending = false;
          sendNextQueued();
        } else if (msg.type === "error") {
          sending = false;
          reportError(msg.message);
          sendNextQueued();
        }
        return;
      }

      const buffer = event.data as ArrayBuffer;
      if (containerMimeType) {
        void scheduleContainerChunk(buffer);
      } else {
        schedulePcmChunk(buffer);
      }
    };

    socket.onerror = () => reportError("Streaming-Verbindung fehlgeschlagen");
    socket.onclose = () => {
      socket = null;
      if (!stopped) { reportError("Streaming-Verbindung geschlossen"); stop(); }
    };
  };

  return {
    start: () => {
      if (socket || stopped) return;
      unsubscribeInterrupt = onVoiceReplyInterrupted(stop);
      nextStartTime = 0;
      ensureAudioContext();
      connect();
    },
    pushText: (text: string) => {
      if (!text.trim() || stopped) return;
      textQueue.push(text);
      if (socket?.readyState === WebSocket.OPEN) sendNextQueued();
    },
    end: () => {
      ending = true;
      finishIfDrained();
    },
    stop,
    onPlayingChange: (listener) => {
      playingListeners.add(listener);
      return () => playingListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}
