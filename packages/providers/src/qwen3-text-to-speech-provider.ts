import { Readable } from "node:stream";
import {
  BaseTextToSpeechProvider,
  type TextToSpeechProviderOptions,
  type StreamingTextToSpeechProvider,
} from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface Qwen3TextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  /** Base URL of the locally-running Qwen3-TTS inference server, e.g. http://127.0.0.1:8892 */
  serverUrl?: string;
  timeoutMs?: number;
}

// Qwen3-TTS takes a free-text style instruction (1.7B CustomVoice only - the server drops it for
// other models), so the Voice-tab presets map to short natural-language directions.
const EMOTION_STYLE_INSTRUCTIONS: Record<string, string> = {
  calm: "Speak calmly and softly.",
  empathetic: "Speak warmly and empathetically.",
  cheerful: "Speak in a cheerful, happy tone.",
  excited: "Speak in an excited, energetic tone.",
};

let reachableServer: { url: string; checkedAt: number } | undefined;

function toLanguageId(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return language.split("-")[0]?.toLowerCase();
}

/**
 * Qwen3-TTS (Alibaba/Qwen, Apache-2.0, https://github.com/QwenLM/Qwen3-TTS) is a PyTorch model,
 * so like Chatterbox it runs as a persistent local HTTP server
 * (apps/server/scripts/qwen3_tts_server.py) instead of being reloaded per request.
 */
export class Qwen3TextToSpeechProvider extends BaseTextToSpeechProvider implements StreamingTextToSpeechProvider {
  readonly name = "qwen3-tts";
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  // qwen-tts has no documented incremental-generation API yet; the server chunks the finished
  // PCM (same approach as Chatterbox), fixed to 24 kHz.
  readonly streamSampleRate = 24000;

  constructor(options: Qwen3TextToSpeechProviderOptions) {
    super(options);
    this.serverUrl = (options.serverUrl ?? "http://127.0.0.1:8892").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  private async assertReachable(): Promise<void> {
    if (reachableServer?.url === this.serverUrl && Date.now() - reachableServer.checkedAt < 5000) return;
    if (!(await isQwen3ServerReachable(this.serverUrl, 2500))) {
      throw new Error(
        `Der lokale Qwen3-TTS-Server unter ${this.serverUrl} antwortet nicht. Starte ihn unter Settings → Sprache → Qwen3-TTS ` +
          `(Server starten) oder wähle einen anderen TTS-Provider.`
      );
    }
    reachableServer = { url: this.serverUrl, checkedAt: Date.now() };
  }

  private buildBody(text: string, options?: TextToSpeechSynthesizeOptions): string {
    const instruct =
      options?.emotionInstructions?.trim() ||
      (options?.emotionStyle ? EMOTION_STYLE_INSTRUCTIONS[options.emotionStyle] : undefined);
    return JSON.stringify({
      text,
      voice: options?.voice || this.options.voice || undefined,
      language: toLanguageId(options?.language),
      instruct,
    });
  }

  private async post(path: string, body: string): Promise<{ response: Response; clear: () => void }> {
    await this.assertReachable();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const clear = () => clearTimeout(timeout);
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clear();
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Qwen3-TTS server request timed out after ${this.timeoutMs}ms (${this.serverUrl})`);
      }
      throw new Error(
        `Could not reach the local Qwen3-TTS server at ${this.serverUrl}. Is apps/server/scripts/qwen3_tts_server.py running?`
      );
    }
    if (!response.ok) {
      clear();
      const errorText = await response.text().catch(() => "");
      throw new Error(`Qwen3-TTS failed: ${response.status} ${errorText}`);
    }
    return { response, clear };
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const { response, clear } = await this.post("/synthesize", this.buildBody(text, options));
    try {
      const arrayBuffer = await response.arrayBuffer();
      return { audio: Buffer.from(arrayBuffer), mimeType: response.headers.get("content-type") || "audio/wav" };
    } finally {
      clear();
    }
  }

  async *synthesizeStream(text: string, options?: TextToSpeechSynthesizeOptions): AsyncIterable<Buffer> {
    const { response, clear } = await this.post("/synthesize_stream", this.buildBody(text, options));
    if (!response.body) {
      clear();
      throw new Error("Qwen3-TTS streaming response had no body");
    }
    try {
      const nodeStream = Readable.fromWeb(response.body as never);
      for await (const chunk of nodeStream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      }
    } finally {
      clear();
    }
  }
}

export interface Qwen3VoiceSummary {
  id: string;
  name: string;
}

export async function listQwen3Voices(serverUrl: string): Promise<Qwen3VoiceSummary[]> {
  const base = serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/voices`);
  if (!response.ok) {
    throw new Error(`Qwen3-TTS voice listing failed: ${response.status}`);
  }
  const data = (await response.json()) as { voices?: Qwen3VoiceSummary[] };
  return data.voices ?? [];
}

export async function isQwen3ServerReachable(serverUrl: string, timeoutMs = 1500): Promise<boolean> {
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
