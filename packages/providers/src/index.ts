import type { LLMProvider } from "./base.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { LMStudioProvider } from "./lmstudio-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { ClaudeProvider } from "./claude-provider.js";
// Import new multi-provider adapters
import { BaseAdapter, AnthropicAdapter, GeminiAdapter, BedrockAdapter, ProviderRouter } from "./adapters/index.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialAwareRouter } from "./adapters/credential-aware-router.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "@ducki/shared";
// Export adapter configurations
export type { AdapterConfig, ProviderRouterConfig } from "./adapter-config.js";
export type { Credential, CredentialRotationConfig } from "./credential-manager.js";
import { OpenAISpeechToTextProvider } from "./openai-speech-to-text-provider.js";
import { SileroSpeechToTextProvider } from "./silero-speech-to-text-provider.js";
import { LocalCommandSpeechToTextProvider } from "./local-command-speech-to-text-provider.js";
import { NodejsWhisperSpeechToTextProvider } from "./nodejs-whisper-speech-to-text-provider.js";
import { OpenAITextToSpeechProvider } from "./openai-text-to-speech-provider.js";
import { ElevenLabsTextToSpeechProvider } from "./elevenlabs-text-to-speech-provider.js";
import { PiperTextToSpeechProvider, type PiperTextToSpeechProviderOptions } from "./piper-text-to-speech-provider.js";
import { LocalCommandTextToSpeechProvider } from "./local-command-text-to-speech-provider.js";

export type ProviderName = "openai" | "openrouter" | "lmstudio" | "ollama" | "claude";

export interface ProviderFactoryConfig {
  name: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function createProvider(config: ProviderFactoryConfig): LLMProvider {
  switch (config.name) {
    case "openai":
      return new OpenAIProvider({
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: config.apiKey,
        model: config.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
      });
    case "openrouter":
      return new OpenRouterProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model ?? process.env["OPENROUTER_MODEL"] ?? "anthropic/claude-3-5-sonnet",
      });
    case "lmstudio":
      return new LMStudioProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? process.env["LM_STUDIO_API_KEY"],
        model: config.model,
      });
    case "ollama":
      return new OllamaProvider({
        baseUrl: config.baseUrl,
        model: config.model,
      });
    case "claude":
      return new AnthropicAdapter({
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: config.apiKey ?? process.env["CLAUDE_API_KEY"],
        model: config.model ?? process.env["CLAUDE_MODEL"] ?? "claude-3-5-sonnet-20241022",
      });
    default:
      throw new Error(`Unknown provider: ${String(config.name)}`);
  }
}

export function createDefaultProvider(): LLMProvider {
  const providerName = (process.env["DEFAULT_PROVIDER"] ?? "lmstudio") as ProviderName;
  return createProvider({ name: providerName });
}

export { OpenAIProvider, OpenRouterProvider, LMStudioProvider, OllamaProvider, ClaudeProvider };
// Export new multi-provider adapters and credential management
export { BaseAdapter, AnthropicAdapter, GeminiAdapter, BedrockAdapter, ProviderRouter, CredentialManager, CredentialAwareRouter };
export type { LLMProvider };
export * from "./base.js";
export {
  ProviderConnectionError,
  isProviderConnectionError,
  looksLikeConnectionFailure,
  isAbortError,
} from "./errors.js";

// ============================================================
// Speech-to-Text Provider Factory
// ============================================================

export type { SpeechToTextProvider };
export { OpenAISpeechToTextProvider, SileroSpeechToTextProvider, LocalCommandSpeechToTextProvider, NodejsWhisperSpeechToTextProvider };

export type SpeechToTextProviderFactoryConfig = {
  name: "openai" | "ollama" | "silero" | "local" | "nodejs-whisper";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  command?: string;
  args?: string[];
  workingDirectory?: string;
  timeoutMs?: number;
  modelRootPath?: string;
  autoDownloadModel?: boolean;
  withCuda?: boolean;
};

export function createSpeechToTextProvider(
  config: SpeechToTextProviderFactoryConfig
): SpeechToTextProvider {
  switch (config.name) {
    case "openai":
      return new OpenAISpeechToTextProvider({
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: config.apiKey || process.env["OPENAI_API_KEY"],
        model: config.model ?? "whisper-1",
      });
    case "silero":
      return new SileroSpeechToTextProvider({
        baseUrl: config.baseUrl ?? process.env["SILERO_BASE_URL"] ?? "http://localhost:11434",
        model: config.model ?? "silero-asr",
      });
    case "ollama":
      return new SileroSpeechToTextProvider({
        baseUrl: config.baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434",
        model: config.model ?? "silero-asr",
      });
    case "local":
      return new LocalCommandSpeechToTextProvider({
        command: config.command ?? process.env["LOCAL_STT_COMMAND"],
        args: config.args,
        workingDirectory: config.workingDirectory,
        timeoutMs: config.timeoutMs,
        baseUrl: config.baseUrl ?? "",
        model: config.model ?? process.env["LOCAL_STT_ARGS"] ?? "{input}",
      });
    case "nodejs-whisper":
      return new NodejsWhisperSpeechToTextProvider({
        baseUrl: config.baseUrl ?? "",
        model: config.model ?? process.env["NODEJS_WHISPER_MODEL_NAME"] ?? "base",
        modelName: config.model ?? process.env["NODEJS_WHISPER_MODEL_NAME"] ?? "base",
        modelRootPath: config.modelRootPath ?? process.env["NODEJS_WHISPER_MODEL_ROOT_PATH"],
        autoDownloadModel:
          config.autoDownloadModel ??
          (process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"]
            ? ["1", "true", "yes", "on"].includes(process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"].trim().toLowerCase())
            : true),
        withCuda:
          config.withCuda ??
          (process.env["NODEJS_WHISPER_USE_CUDA"]
            ? ["1", "true", "yes", "on"].includes(process.env["NODEJS_WHISPER_USE_CUDA"].trim().toLowerCase())
            : false),
        timeoutMs: config.timeoutMs,
      });
    default:
      throw new Error(`Unknown speech-to-text provider: ${String(config.name)}`);
  }
}

export function getDefaultSpeechToTextProvider(): SpeechToTextProvider {
  const providerName = (process.env["DEFAULT_SPEECH_TO_TEXT_PROVIDER"] ?? "local") as
    | "openai"
    | "ollama"
    | "silero"
    | "local"
    | "nodejs-whisper";
  return createSpeechToTextProvider({ name: providerName });
}

// ============================================================
// Text-to-Speech Provider Factory
// ============================================================

export type { TextToSpeechProvider };
export { OpenAITextToSpeechProvider, ElevenLabsTextToSpeechProvider, PiperTextToSpeechProvider, LocalCommandTextToSpeechProvider };
export { listElevenLabsVoices, type ElevenLabsVoiceSummary } from "./elevenlabs-text-to-speech-provider.js";

export type TextToSpeechProviderFactoryConfig = {
  name: "openai" | "elevenlabs" | "piper" | "local";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  stability?: number;
  similarityBoost?: number;
  // Piper-specific tuning (ignored by other providers)
  executablePath?: string;
  modelPath?: string;
  lengthScale?: number;
  noiseScale?: number;
  noiseW?: number;
  sentenceSilence?: number;
  speakerId?: number;
  // Generic local-command TTS (ignored by other providers)
  command?: string;
  args?: string[];
  workingDirectory?: string;
  timeoutMs?: number;
  outputExt?: string;
};

export function createTextToSpeechProvider(config: TextToSpeechProviderFactoryConfig): TextToSpeechProvider {
  switch (config.name) {
    case "openai":
      return new OpenAITextToSpeechProvider({
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"],
        model: config.model ?? process.env["OPENAI_TTS_MODEL"] ?? "tts-1",
        voice: config.voice ?? process.env["OPENAI_TTS_VOICE"] ?? "alloy",
      });
    case "elevenlabs":
      return new ElevenLabsTextToSpeechProvider({
        baseUrl: config.baseUrl ?? "https://api.elevenlabs.io/v1",
        apiKey: config.apiKey ?? process.env["ELEVENLABS_API_KEY"],
        model: config.model ?? process.env["ELEVENLABS_MODEL"] ?? "eleven_multilingual_v2",
        voice: config.voice ?? process.env["ELEVENLABS_VOICE_ID"],
        stability: config.stability,
        similarityBoost: config.similarityBoost,
      });
    case "piper": {
      const piperConfig: PiperTextToSpeechProviderOptions = {
        baseUrl: "",
        executablePath: config.executablePath,
        modelPath: config.modelPath ?? config.voice,
        lengthScale: config.lengthScale,
        noiseScale: config.noiseScale,
        noiseW: config.noiseW,
        sentenceSilence: config.sentenceSilence,
        speakerId: config.speakerId,
        timeoutMs: config.timeoutMs,
      };
      return new PiperTextToSpeechProvider(piperConfig);
    }
    case "local":
      return new LocalCommandTextToSpeechProvider({
        baseUrl: "",
        command: config.command,
        args: config.args,
        workingDirectory: config.workingDirectory,
        timeoutMs: config.timeoutMs,
        outputExt: config.outputExt,
        model: config.model,
        voice: config.voice,
      });
    default:
      throw new Error(`Unknown text-to-speech provider: ${String(config.name)}`);
  }
}

export function getDefaultTextToSpeechProvider(): TextToSpeechProvider {
  const providerName = (process.env["DEFAULT_TEXT_TO_SPEECH_PROVIDER"] ?? "openai") as "openai" | "elevenlabs" | "piper" | "local";
  return createTextToSpeechProvider({ name: providerName });
}
