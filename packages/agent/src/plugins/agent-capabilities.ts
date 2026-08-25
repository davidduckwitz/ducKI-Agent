/**
 * Curated, request-scoped API that lets a trust:"node" plugin USE the agent's built-in LLM-
 * backed abilities without exposing the raw provider. Browser access follows the same rule:
 * plugins receive a narrow adapter, never Puppeteer/CDP objects.
 */
import type { LLMProvider } from "@ducki/providers";
import type { LLMContent, LLMMessage } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { analyzeVideo, transcribeExtractedAudio } from "../media/video-processing.js";

export interface AgentImageInput {
  base64?: string;
  url?: string;
  mimeType?: string;
}

export interface AgentVideoAnalysisResult {
  transcript: string;
  durationSec: number;
  frameCount: number;
  truncated: boolean;
  analysis?: string;
  frames: { timestampSec: number; base64: string }[];
}

export interface PluginBrowserSessionInfo {
  sessionId: string;
  url?: string;
  title?: string;
  launchedAt?: string;
  isDefault?: boolean;
}

export interface PluginBrowserFrame {
  sessionId: string;
  data: string;
  format: string;
  timestamp: string;
  width?: number;
  height?: number;
}

export interface PluginBrowserCapabilities {
  listSessions(): Promise<PluginBrowserSessionInfo[]>;
  getFrame(sessionId?: string): Promise<PluginBrowserFrame>;
  startStream(sessionId?: string): Promise<string>;
  stopStream(sessionId: string): Promise<void>;
  subscribeFrames(sessionId: string, handler: (frame: PluginBrowserFrame) => void): () => void;
}

export interface AgentCapabilities {
  analyzeImage(images: AgentImageInput[], question?: string): Promise<string>;
  transcribeAudio(audioBuffer: Buffer, opts?: { language?: string }): Promise<string>;
  analyzeVideo(videoBuffer: Buffer, question?: string): Promise<AgentVideoAnalysisResult>;
  analyzeText(text: string, instruction: string): Promise<string>;
  /** Optional host-owned browser adapter. apps/server wires this in; metadata-only loaders omit it. */
  browser?: PluginBrowserCapabilities;
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
      if (blocks.length === 0) throw new Error("analyzeImage: no valid image provided (each entry needs 'base64' or 'url')");
      const provider = await getProvider();
      const prompt = question?.trim() || "Describe what is shown in this image.";
      const messages: LLMMessage[] = [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }];
      const response = await provider.generate(messages, { temperature: 0.2, maxTokens: 1200 });
      return response.content;
    },

    async transcribeAudio(audioBuffer, opts) {
      void opts;
      return transcribeExtractedAudio(db, audioBuffer);
    },

    async analyzeVideo(videoBuffer, question) {
      const result = await analyzeVideo(db, logger, videoBuffer);
      if (!result) throw new Error("Video analysis unavailable (ffmpeg missing/failed, or the file exceeds the size cap)");
      let analysis: string | undefined;
      if (question?.trim() && result.frames.length > 0) {
        const provider = await getProvider();
        const frameBlocks: LLMContent[] = result.frames.map((frame) => ({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`, detail: "high" },
        }));
        const transcriptLine = result.transcript ? `Transcript: ${result.transcript}` : "Transcript: (no speech detected)";
        const messages: LLMMessage[] = [{ role: "user", content: [...frameBlocks, { type: "text", text: `${transcriptLine}\n\n${question.trim()}` }] }];
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
