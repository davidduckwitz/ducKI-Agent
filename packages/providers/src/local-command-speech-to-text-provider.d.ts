import { BaseSpeechToTextProvider, type SpeechToTextProviderOptions } from "./speech-to-text-base.js";
interface LocalSpeechToTextProviderOptions extends SpeechToTextProviderOptions {
    command?: string;
    args?: string[];
    workingDirectory?: string;
    timeoutMs?: number;
}
export declare class LocalCommandSpeechToTextProvider extends BaseSpeechToTextProvider {
    readonly name = "local";
    private readonly localOptions;
    constructor(options: LocalSpeechToTextProviderOptions);
    transcribe(audioBuffer: Buffer, options?: {
        language?: string;
    }): Promise<string>;
}
export {};
//# sourceMappingURL=local-command-speech-to-text-provider.d.ts.map