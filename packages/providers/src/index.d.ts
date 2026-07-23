import type { LLMProvider } from "./base.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { LMStudioProvider } from "./lmstudio-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { SpeechToTextProvider } from "@ducki/shared";
import { OpenAISpeechToTextProvider } from "./openai-speech-to-text-provider.js";
import { SileroSpeechToTextProvider } from "./silero-speech-to-text-provider.js";
import { LocalCommandSpeechToTextProvider } from "./local-command-speech-to-text-provider.js";
import { NodejsWhisperSpeechToTextProvider } from "./nodejs-whisper-speech-to-text-provider.js";
export type ProviderName = "openai" | "openrouter" | "lmstudio" | "ollama";
export interface ProviderFactoryConfig {
    name: ProviderName;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
}
export declare function createProvider(config: ProviderFactoryConfig): LLMProvider;
export declare function createDefaultProvider(): LLMProvider;
export { OpenAIProvider, OpenRouterProvider, LMStudioProvider, OllamaProvider };
export type { LLMProvider };
export * from "./base.js";
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
export declare function createSpeechToTextProvider(config: SpeechToTextProviderFactoryConfig): SpeechToTextProvider;
export declare function getDefaultSpeechToTextProvider(): SpeechToTextProvider;
//# sourceMappingURL=index.d.ts.map