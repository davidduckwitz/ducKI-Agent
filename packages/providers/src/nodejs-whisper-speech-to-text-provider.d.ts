import { BaseSpeechToTextProvider, type SpeechToTextProviderOptions } from "./speech-to-text-base.js";
interface NodejsWhisperSpeechToTextProviderOptions extends SpeechToTextProviderOptions {
    modelName?: string;
    modelRootPath?: string;
    autoDownloadModel?: boolean;
    withCuda?: boolean;
    timeoutMs?: number;
}
export declare class NodejsWhisperSpeechToTextProvider extends BaseSpeechToTextProvider {
    readonly name = "nodejs-whisper";
    private readonly whisperOptions;
    constructor(options: NodejsWhisperSpeechToTextProviderOptions);
    transcribe(audioBuffer: Buffer, options?: {
        language?: string;
    }): Promise<string>;
}
export {};
//# sourceMappingURL=nodejs-whisper-speech-to-text-provider.d.ts.map