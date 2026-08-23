/**
 * Curated, request-scoped API that lets a trust:"node" plugin USE the agent's built-in LLM-
 * backed abilities (vision, transcription, video understanding, text analysis) without a core
 * agent.ts change per new plugin. Deliberately NOT the raw LLMProvider: handing that out would
 * let a plugin fire arbitrary prompts at any model with no cost/scope control, bypassing the
 * same governance core tools (vision-tools.ts, video-processing.ts) already sit behind. Each
 * method here wraps exactly one of those existing, narrow capabilities instead.
 *
 * `getProvider` is a lazy, no-cache lookup (see apps/server/src/lib/provider-settings.ts's
 * loadProviderFromSettings) so every call reflects whatever provider/model is CURRENTLY
 * configured, the same way transcribeExtractedAudio() re-reads whisper settings every call
 * rather than pinning them at plugin-load time.
 */
import type { LLMProvider } from "@ducki/providers";
import type { LLMContent, LLMMessage } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { analyzeVideo, transcribeExtractedAudio } from "../media/video-processing.js";

export interface AgentImageInput {
  /** Raw or data-URL base64. Provide this OR url. */
  base64?: string;
  url?: string;
  mimeType?: string;
}

export interface AgentVideoAnalysisResult {
  transcript: string;
  durationSec: number;
  frameCount: number;
  truncated: boolean;
  /** Only set when a `question` was passed - a vision pass over the sampled frames + transcript. */
  analysis?: string;
  /** The sampled frames themselves (base64 JPEG, no data: prefix), so a caller that wants to
   *  ask FOLLOW-UP questions later can pass them straight to analyzeImage() without re-running
   *  ffmpeg/yt-dlp against the original video - useful once the source file has been deleted. */
  frames: { timestampSec: number; base64: string }[];
}

export interface AgentCapabilities {
  /** Vision reasoning over one or more images - same underlying call as the core
   *  `analyze_ui_layout` tool (vision/vision-tools.ts), just without the UI-specific framing. */
  analyzeImage(images: AgentImageInput[], question?: string): Promise<string>;
  /** Whisper transcription of a raw audio buffer (same pipeline as
   *  apps/server/src/lib/audio-transcription.ts / the mic button / Discord voice). */
  transcribeAudio(audioBuffer: Buffer, opts?: { language?: string }): Promise<string>;
  /** Full video pipeline (media/video-processing.ts): audio transcript + sampled frames. Pass
   *  `question` to also get a vision-grounded text analysis over those frames; omit it to just
   *  get the transcript/frame count cheaply (no extra LLM call). */
  analyzeVideo(videoBuffer: Buffer, question?: string): Promise<AgentVideoAnalysisResult>;
  /** Plain text-in, text-out LLM call (summarize, classify, extract, rewrite, ...). */
  analyzeText(text: string, instruction: string): Promise<string>;
}

function buildImageContent(input: AgentImageInput): LLMContent | undefined {
  if (input.url) return { type: "image_url", image_url: { url: input.url, detail: "high" } };
  if (input.base64) {
    const mimeType = input.mimeType || "image/jpeg";
    const url = input.base64.startsWith("data:") ? input.base64 : `data:${mimeType};base64,${input.base64}`;
    return { type: "image_data", image_data: { url, mime_type: mimeType } };
  }
  return undefined;
}

export function createAgentCapabilities(
  db: DatabaseService,
  logger: Logger,
  getProvider: () => Promise<LLMProvider>
): AgentCapabilities {
  return {
    async analyzeImage(images, question) {
      const blocks = images.map(buildImageContent).filter((b): b is LLMContent => b !== undefined);
      if (blocks.length === 0) {
        throw new Error("analyzeImage: no valid image provided (each entry needs 'base64' or 'url')");
      }
      const provider = await getProvider();
      const prompt = question?.trim() || "Describe what is shown in this image.";
      const messages: LLMMessage[] = [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }];
      const response = await provider.generate(messages, { temperature: 0.2, maxTokens: 1200 });
      return response.content;
    },

    async transcribeAudio(audioBuffer, opts) {
      void opts; // language is currently fixed to "de" inside transcribeExtractedAudio, same as the core pipeline
      return transcribeExtractedAudio(db, audioBuffer);
    },

    async analyzeVideo(videoBuffer, question) {
      const result = await analyzeVideo(db, logger, videoBuffer);
      if (!result) {
        throw new Error("Video analysis unavailable (ffmpeg missing/failed, or the file exceeds the size cap)");
      }

      let analysis: string | undefined;
      if (question?.trim() && result.frames.length > 0) {
        const provider = await getProvider();
        const frameBlocks: LLMContent[] = result.frames.map((frame) => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`, detail: "high" },
        }));
        const transcriptLine = result.transcript ? `Transcript: ${result.transcript}` : "Transcript: (no speech detected)";
        const messages: LLMMessage[] = [
          { role: "user", content: [...frameBlocks, { type: "text", text: `${transcriptLine}\n\n${question.trim()}` }] },
        ];
        const response = await provider.generate(messages, { temperature: 0.2, maxTokens: 1500 });
        analysis = response.content;
      }

      return {
        transcript: result.transcript,
        durationSec: result.durationSec,
        frameCount: result.frames.length,
        truncated: result.truncated,
        frames: result.frames.map((frame) => ({ timestampSec: frame.timestampSec, base64: frame.buffer.toString("base64") })),
        analysis,
      };
    },

    async analyzeText(text, instruction) {
      const provider = await getProvider();
      const messages: LLMMessage[] = [{ role: "user", content: `${instruction.trim()}\n\n${text}` }];
      const response = await provider.generate(messages, { temperature: 0.3, maxTokens: 1500 });
      return response.content;
    },
  };
}
