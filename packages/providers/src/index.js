import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { LMStudioProvider } from "./lmstudio-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAISpeechToTextProvider } from "./openai-speech-to-text-provider.js";
import { SileroSpeechToTextProvider } from "./silero-speech-to-text-provider.js";
import { LocalCommandSpeechToTextProvider } from "./local-command-speech-to-text-provider.js";
import { NodejsWhisperSpeechToTextProvider } from "./nodejs-whisper-speech-to-text-provider.js";
export function createProvider(config) {
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
        default:
            throw new Error(`Unknown provider: ${String(config.name)}`);
    }
}
export function createDefaultProvider() {
    const providerName = (process.env["DEFAULT_PROVIDER"] ?? "lmstudio");
    return createProvider({ name: providerName });
}
export { OpenAIProvider, OpenRouterProvider, LMStudioProvider, OllamaProvider };
export * from "./base.js";
export { OpenAISpeechToTextProvider, SileroSpeechToTextProvider, LocalCommandSpeechToTextProvider, NodejsWhisperSpeechToTextProvider };
export function createSpeechToTextProvider(config) {
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
                autoDownloadModel: config.autoDownloadModel ??
                    (process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"]
                        ? ["1", "true", "yes", "on"].includes(process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"].trim().toLowerCase())
                        : true),
                withCuda: config.withCuda ??
                    (process.env["NODEJS_WHISPER_USE_CUDA"]
                        ? ["1", "true", "yes", "on"].includes(process.env["NODEJS_WHISPER_USE_CUDA"].trim().toLowerCase())
                        : false),
                timeoutMs: config.timeoutMs,
            });
        default:
            throw new Error(`Unknown speech-to-text provider: ${String(config.name)}`);
    }
}
export function getDefaultSpeechToTextProvider() {
    const providerName = (process.env["DEFAULT_SPEECH_TO_TEXT_PROVIDER"] ?? "local");
    return createSpeechToTextProvider({ name: providerName });
}
//# sourceMappingURL=index.js.map