/**
 * Dedicated low-latency WebSocket endpoint for streamed TTS playback (Phase C of the voice-mode
 * plan). Kept separate from the Socket.io hub (index.ts) so binary PCM frames never compete
 * with the general chat/tool-call event traffic there - see the plan's "Zweiter Realtime-Kanal"
 * risk note for the tradeoff.
 *
 * Protocol (client -> server, JSON text frames):
 *   {type: "speak", text: string, voice?: string, emotionStyle?: string, emotionInstructions?: string}
 *     - synthesizes `text` and streams it back as binary PCM frames (mono, 16-bit signed LE,
 *       sample rate given once via the "meta" message below), in the order chunks arrive.
 *   {type: "end"} - client is done sending text for this turn; connection may be reused for a
 *     later turn (no need to reconnect), but is otherwise idle until the next "speak".
 *
 * Protocol (server -> client):
 *   {type: "meta", sampleRate: number} - sent once, before the first binary frame, so the
 *     client's Web Audio decoder knows how to interpret the PCM bytes.
 *   <binary frame> - raw PCM chunk.
 *   {type: "done"} - the current "speak" request's audio has fully arrived.
 *   {type: "error", message: string} - the current "speak" request failed; connection stays open.
 *
 * Falls back to a single non-streaming chunk (via the batch synthesize()) for providers that
 * don't implement StreamingTextToSpeechProvider, so the client doesn't need its own fallback
 * logic - it always gets the same "meta / binary.../ done" shape regardless of provider.
 */
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { isStreamingTextToSpeechProvider } from "@ducki/providers";
import { resolveTextToSpeechProvider } from "../lib/audio-synthesis.js";

const logger = getRootLogger().child("AudioStream");

// A provider connection is only kept alive while its owning client WS connection is open (see
// the plan's session-management note) - closing the client socket is enough to let it be
// garbage-collected, no separate idle-timeout bookkeeping needed at this layer.
const FALLBACK_SAMPLE_RATE = 24000;

interface SpeakMessage {
  type: "speak";
  text: string;
  voice?: string;
  emotionStyle?: string;
  emotionInstructions?: string;
  language?: string;
}

interface EndMessage {
  type: "end";
}

function isSpeakMessage(msg: unknown): msg is SpeakMessage {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "speak";
}

const AUDIO_STREAM_PATH = "/ws/audio-stream";

export function setupAudioStreamServer(httpServer: HttpServer, db: DatabaseService): void {
  // `noServer: true` + a manually filtered 'upgrade' listener, rather than passing `server`
  // directly - letting `ws` attach its own 'upgrade' listener alongside Socket.io's broke the
  // Socket.io handshake entirely (observed as "Invalid frame header" on every /socket.io
  // connection attempt) even though this endpoint's own path never matched. Handling the
  // routing ourselves and only ever calling handleUpgrade() for our own path guarantees every
  // other upgrade request passes through completely untouched.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket: Socket, head) => {
    const pathname = req.url ? new URL(req.url, "http://internal").pathname : "";
    if (pathname !== AUDIO_STREAM_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    let metaSent = false;
    let processing = false;

    const send = (payload: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) return; // Client never sends binary frames in this protocol.

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send({ type: "error", message: "Invalid JSON message" });
        return;
      }

      if ((parsed as EndMessage).type === "end") return; // No per-turn server state to tear down yet.

      if (!isSpeakMessage(parsed) || !parsed.text?.trim()) {
        send({ type: "error", message: "Expected {type: 'speak', text: string}" });
        return;
      }

      if (processing) {
        send({ type: "error", message: "Already processing a previous speak request" });
        return;
      }

      processing = true;
      void handleSpeak(parsed)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("Streaming synthesis failed", { error: message });
          send({ type: "error", message });
        })
        .finally(() => {
          processing = false;
        });
    });

    async function handleSpeak(msg: SpeakMessage): Promise<void> {
      const provider = await resolveTextToSpeechProvider(db, {
        voice: msg.voice,
        emotionStyle: msg.emotionStyle,
        emotionInstructions: msg.emotionInstructions,
        language: msg.language,
      });

      if (isStreamingTextToSpeechProvider(provider)) {
        if (!metaSent) {
          send({ type: "meta", sampleRate: provider.streamSampleRate });
          metaSent = true;
        }
        for await (const chunk of provider.synthesizeStream(msg.text, {
          voice: msg.voice,
          emotionStyle: msg.emotionStyle,
          emotionInstructions: msg.emotionInstructions,
          language: msg.language,
        })) {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(chunk, { binary: true });
        }
        send({ type: "done" });
        return;
      }

      // Non-streaming provider: synthesize the whole thing, then hand it over as one frame -
      // the client's playback code treats this identically to many small frames.
      const result = await provider.synthesize(msg.text, {
        voice: msg.voice,
        emotionStyle: msg.emotionStyle,
        emotionInstructions: msg.emotionInstructions,
        language: msg.language,
      });
      if (!metaSent) {
        send({ type: "meta", sampleRate: FALLBACK_SAMPLE_RATE, containerMimeType: result.mimeType });
        metaSent = true;
      }
      if (socket.readyState === socket.OPEN) socket.send(result.audio, { binary: true });
      send({ type: "done" });
    }

    socket.on("error", (err) => {
      logger.warn("Audio stream socket error", { error: err.message });
    });
  });

  logger.info("Audio stream WebSocket server ready", { path: AUDIO_STREAM_PATH });
}
