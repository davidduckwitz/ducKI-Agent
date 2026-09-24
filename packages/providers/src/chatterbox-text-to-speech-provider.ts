import { Readable } from "node:stream";
import {
  BaseTextToSpeechProvider,
  type TextToSpeechProviderOptions,
  type StreamingTextToSpeechProvider,
} from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface ChatterboxTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  /** Base URL of the locally-running Chatterbox inference server, e.g. http://127.0.0.1:8890 */
  serverUrl?: string;
  /** Default 0-1 "emotion exaggeration" knob when no per-request emotionStyle is given. */
  emotionExaggeration?: number;
  timeoutMs?: number;
}

// Chatterbox's own "emotion exaggeration" dial (0-1) is the closest analog to the Voice-tab's
// coarse presets - map them the same way the ElevenLabs provider maps its `style` knob.
const EMOTION_STYLE_MAP: Record<string, number> = {
  neutral: 0.2,
  calm: 0.1,
  empathetic: 0.35,
  cheerful: 0.6,
  excited: 0.9,
};

// Provider instances are short-lived, but adjacent speech chunks use the same server.
let reachableServer: { url: string; checkedAt: number } | undefined;

/** "de-DE" -> "de", "en-US" -> "en" - the server's multilingual model wants a bare language code. */
function toLanguageId(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return language.split("-")[0]?.toLowerCase();
}

/**
 * Chatterbox (Resemble AI, MIT-licensed, https://github.com/resemble-ai/chatterbox) is a
 * PyTorch model, not a CLI binary - reloading it per request (the Piper/local-command pattern)
 * would defeat the "faster reactions" goal. Instead this talks HTTP to a persistent local
 * inference server (see apps/server/scripts/chatterbox_server.py) that loads the model once.
 */
export class ChatterboxTextToSpeechProvider extends BaseTextToSpeechProvider implements StreamingTextToSpeechProvider {
  readonly name = "chatterbox";
  private readonly serverUrl: string;
  private readonly emotionExaggeration: number;
  private readonly timeoutMs: number;
  // Chatterbox generates the full utterance before responding (no token-level streaming
  // synthesis) - synthesizeStream() below chunks that finished PCM progressively over the HTTP
  // response instead, which still lets the client start playing before the full transfer
  // completes. A true incrementally-generated stream would need model-level support Chatterbox
  // doesn't currently expose.
  readonly streamSampleRate = 24000;

  constructor(options: ChatterboxTextToSpeechProviderOptions) {
    super(options);
    this.serverUrl = (options.serverUrl ?? "http://127.0.0.1:8890").replace(/\/+$/, "");
    this.emotionExaggeration = options.emotionExaggeration ?? 0.5;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  // A down server otherwise only surfaces as the full 30s request timeout, since the actual
  // generation call needs that much headroom for legitimately slow (e.g. cold-start or
  // CPU-only) synthesis. This fails fast instead: /health has no model-loading work to do, so
  // a couple of seconds is enough to tell "not running" apart from "still generating".
  private async assertReachable(): Promise<void> {
    if (reachableServer?.url === this.serverUrl && Date.now() - reachableServer.checkedAt < 5000) return;
    const reachable = await isChatterboxServerReachable(this.serverUrl, 2500);
    if (!reachable) {
      throw new Error(
        `Der lokale Chatterbox-Server unter ${this.serverUrl} antwortet nicht. Starte ihn unter Settings → Speech → Chatterbox ` +
          `(Server starten) oder wähle in Settings → Speech einen anderen TTS-Provider.`
      );
    }
    reachableServer = { url: this.serverUrl, checkedAt: Date.now() };
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    await this.assertReachable();
    const emotionExaggeration = options?.emotionStyle
      ? (EMOTION_STYLE_MAP[options.emotionStyle] ?? this.emotionExaggeration)
      : this.emotionExaggeration;
    // Chatterbox has no natural-language style API - options.emotionInstructions is ignored here.

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: options?.voice || this.options.voice || undefined,
          emotion_exaggeration: emotionExaggeration,
          language: toLanguageId(options?.language),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Chatterbox server request timed out after ${this.timeoutMs}ms (${this.serverUrl})`);
      }
      throw new Error(
        `Could not reach the local Chatterbox server at ${this.serverUrl}. Is apps/server/scripts/chatterbox_server.py running?`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Chatterbox TTS failed: ${response.status} ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), mimeType: response.headers.get("content-type") || "audio/wav" };
  }

  async *synthesizeStream(text: string, options?: TextToSpeechSynthesizeOptions): AsyncIterable<Buffer> {
    await this.assertReachable();
    const emotionExaggeration = options?.emotionStyle
      ? (EMOTION_STYLE_MAP[options.emotionStyle] ?? this.emotionExaggeration)
      : this.emotionExaggeration;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/synthesize_stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: options?.voice || this.options.voice || undefined,
          emotion_exaggeration: emotionExaggeration,
          language: toLanguageId(options?.language),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Chatterbox server request timed out after ${this.timeoutMs}ms (${this.serverUrl})`);
      }
      throw new Error(
        `Could not reach the local Chatterbox server at ${this.serverUrl}. Is apps/server/scripts/chatterbox_server.py running?`
      );
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const errorText = await response.text().catch(() => "");
      throw new Error(`Chatterbox TTS streaming failed: ${response.status} ${errorText}`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      throw new Error("Chatterbox TTS streaming response had no body");
    }

    try {
      const nodeStream = Readable.fromWeb(response.body as never);
      for await (const chunk of nodeStream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface ChatterboxVoiceSummary {
  id: string;
  name: string;
}

export async function listChatterboxVoices(serverUrl: string): Promise<ChatterboxVoiceSummary[]> {
  const base = serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/voices`);
  if (!response.ok) {
    throw new Error(`Chatterbox voice listing failed: ${response.status}`);
  }
  const data = (await response.json()) as { voices?: ChatterboxVoiceSummary[] };
  return data.voices ?? [];
}

export async function isChatterboxServerReachable(serverUrl: string, timeoutMs = 1500): Promise<boolean> {
  const base = serverUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
