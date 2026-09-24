import WebSocket from "ws";
import {
  BaseTextToSpeechProvider,
  type TextToSpeechProviderOptions,
  type StreamingTextToSpeechProvider,
} from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface BreezeTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  wsUrl?: string;
  sampleRate?: number;
  timeoutMs?: number;
}

// Breeze TTS 2 (https://breezeblue.ai/breeze-tts-2) exposes natural-language emotion direction
// rather than a fixed knob - map the Voice-tab's coarse presets onto phrases it understands,
// mirroring the ElevenLabs provider's EMOTION_STYLE_MAP pattern but for a free-text API.
const PRESET_TO_INSTRUCTION: Record<string, string> = {
  neutral: "calm, even, neutral delivery",
  calm: "slow, gentle, soothing, relaxed tone",
  empathetic: "warm, caring, softly reassuring tone",
  cheerful: "upbeat, warm, smiling, friendly tone",
  excited: "energetic, enthusiastic, animated delivery",
};

const DEFAULT_WS_URL = "wss://api.breezeblue.ai/v1/tts/stream";

/**
 * Bridges WebSocket event callbacks to async iteration for synthesizeStream(). Buffers items
 * that arrive before the consumer calls next() (WS events are not back-pressured), and lets the
 * consumer await new items when the buffer is empty.
 */
class AsyncPushQueue<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private error: Error | null = null;
  private waiting: ((result: IteratorResult<T>) => void) | null = null;

  push(item: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  fail(err: Error): void {
    this.error = err;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Breeze's headline feature is WebSocket PCM streaming (~120ms time-to-first-byte). The batch
 * `synthesize()` drains a stream to completion and wraps it as a playable WAV (used by the
 * existing /api/chat/speak route); `synthesizeStream()` yields the same PCM chunks as they
 * arrive instead, for the low-latency streaming playback path (see the voice-mode plan, Phase C).
 */
export class BreezeTextToSpeechProvider extends BaseTextToSpeechProvider implements StreamingTextToSpeechProvider {
  readonly name = "breeze";
  private readonly wsUrl: string;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;

  constructor(options: BreezeTextToSpeechProviderOptions) {
    super(options);
    this.wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
    this.sampleRate = options.sampleRate ?? 24000;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  get streamSampleRate(): number {
    return this.sampleRate;
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.synthesizeStream(text, options)) {
      chunks.push(chunk);
    }
    const wav = pcmToWav(Buffer.concat(chunks), this.sampleRate);
    return { audio: wav, mimeType: "audio/wav" };
  }

  async *synthesizeStream(text: string, options?: TextToSpeechSynthesizeOptions): AsyncIterable<Buffer> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error("Breeze API key is required for text-to-speech");
    }
    const instructions =
      options?.emotionInstructions || (options?.emotionStyle ? PRESET_TO_INSTRUCTION[options.emotionStyle] : undefined);
    const voice = options?.voice || this.options.voice;

    const queue = this.openStream(apiKey, text, voice, instructions);
    yield* queue;
  }

  private openStream(
    apiKey: string,
    text: string,
    voice: string | undefined,
    instructions: string | undefined
  ): AsyncPushQueue<Buffer> {
    const queue = new AsyncPushQueue<Buffer>();
    const socket = new WebSocket(this.wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    let receivedAny = false;

    const timeout = setTimeout(() => {
      socket.terminate();
      queue.fail(new Error(`Breeze TTS request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
    };

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "synthesize",
          text,
          voice,
          instructions,
          sample_rate: this.sampleRate,
        })
      );
    });

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        receivedAny = true;
        queue.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as { type?: string; error?: string };
        if (message.type === "done") {
          cleanup();
          socket.close();
          queue.end();
        } else if (message.type === "error") {
          cleanup();
          socket.close();
          queue.fail(new Error(`Breeze TTS error: ${message.error ?? "unknown error"}`));
        }
      } catch {
        // Non-JSON, non-binary frame - ignore.
      }
    });

    socket.on("error", (err) => {
      cleanup();
      queue.fail(new Error(`Breeze TTS connection failed: ${err.message}`));
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!receivedAny) {
        queue.fail(new Error("Breeze TTS connection closed before any audio was received"));
      } else {
        queue.end();
      }
    });

    return queue;
  }
}

export interface BreezeVoiceSummary {
  voiceId: string;
  name: string;
}

export async function listBreezeVoices(apiKey: string, query?: string): Promise<BreezeVoiceSummary[]> {
  const url = new URL("https://api.breezeblue.ai/v1/voices");
  if (query) url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Breeze voice listing failed: ${response.status} ${error}`);
  }
  const data = (await response.json()) as { voices?: Array<{ id: string; name: string }> };
  return (data.voices ?? []).map((v) => ({ voiceId: v.id, name: v.name }));
}
