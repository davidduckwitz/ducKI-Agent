import { Readable } from "node:stream";
import {
  BaseTextToSpeechProvider,
  type TextToSpeechProviderOptions,
  type StreamingTextToSpeechProvider,
} from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface PocketTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  /** Base URL of the locally-running Pocket TTS inference server, e.g. http://127.0.0.1:8893 */
  serverUrl?: string;
  timeoutMs?: number;
}

let reachableServer: { url: string; checkedAt: number } | undefined;

function toLanguageId(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return language.split("-")[0]?.toLowerCase();
}

/**
 * Pocket TTS (Kyutai, https://github.com/kyutai-labs/pocket-tts) is a ~100M-parameter model built for
 * CPUs. It runs as a persistent local HTTP server (apps/server/scripts/pocket_tts_server.py) so the
 * model isn't reloaded per request, and - unlike Chatterbox/Qwen3-TTS - it streams audio while it is
 * still being generated (~200 ms to the first chunk). It has no emotion/style control.
 */
export class PocketTextToSpeechProvider extends BaseTextToSpeechProvider implements StreamingTextToSpeechProvider {
  readonly name = "pocket-tts";
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  // The server resamples to this fixed rate if a model ever differs.
  readonly streamSampleRate = 24000;

  constructor(options: PocketTextToSpeechProviderOptions) {
    super(options);
    this.serverUrl = (options.serverUrl ?? "http://127.0.0.1:8893").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120000;
  }

  private async assertReachable(): Promise<void> {
    if (reachableServer?.url === this.serverUrl && Date.now() - reachableServer.checkedAt < 5000) return;
    if (!(await isPocketServerReachable(this.serverUrl, 2500))) {
      throw new Error(
        `Der lokale Pocket TTS-Server unter ${this.serverUrl} antwortet nicht. Starte ihn unter Settings → Sprache → Pocket TTS ` +
          `(Server starten) oder wähle einen anderen TTS-Provider.`
      );
    }
    reachableServer = { url: this.serverUrl, checkedAt: Date.now() };
  }

  private buildBody(text: string, options?: TextToSpeechSynthesizeOptions): string {
    return JSON.stringify({
      text,
      voice: options?.voice || this.options.voice || undefined,
      language: toLanguageId(options?.language),
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
        throw new Error(`Pocket TTS server request timed out after ${this.timeoutMs}ms (${this.serverUrl})`);
      }
      throw new Error(
        `Could not reach the local Pocket TTS server at ${this.serverUrl}. Is apps/server/scripts/pocket_tts_server.py running?`
      );
    }
    if (!response.ok) {
      clear();
      const errorText = await response.text().catch(() => "");
      throw new Error(`Pocket TTS failed: ${response.status} ${errorText}`);
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
      throw new Error("Pocket TTS streaming response had no body");
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

export interface PocketVoiceSummary {
  id: string;
  name: string;
}

export async function listPocketVoices(serverUrl: string): Promise<PocketVoiceSummary[]> {
  const base = serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/voices`);
  if (!response.ok) {
    throw new Error(`Pocket TTS voice listing failed: ${response.status}`);
  }
  const data = (await response.json()) as { voices?: PocketVoiceSummary[] };
  return data.voices ?? [];
}

export async function isPocketServerReachable(serverUrl: string, timeoutMs = 1500): Promise<boolean> {
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
