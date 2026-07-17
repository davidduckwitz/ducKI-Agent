declare module "nodejs-whisper" {
  export interface NodeWhisperOptions {
    modelName: string;
    modelRootPath?: string;
    autoDownloadModelName?: string;
    withCuda?: boolean;
    removeWavFileAfterTranscription?: boolean;
    whisperOptions?: {
      language?: string;
      outputInText?: boolean;
      outputInJson?: boolean;
      outputInSrt?: boolean;
      outputInVtt?: boolean;
      outputInCsv?: boolean;
      outputInLrc?: boolean;
      outputInWords?: boolean;
      outputInJsonFull?: boolean;
      translateToEnglish?: boolean;
      wordTimestamps?: boolean;
      noGpu?: boolean;
      splitOnWord?: boolean;
      timestamps_length?: number;
    };
    logger?: Pick<Console, "debug" | "log" | "warn" | "error">;
  }

  export function nodewhisper(filePath: string, options: NodeWhisperOptions): Promise<string>;
}
