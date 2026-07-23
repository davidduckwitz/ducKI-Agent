import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";
export interface ReflectionResult {
    quality: "poor" | "adequate" | "good" | "excellent";
    issues: string[];
    suggestions: string[];
    shouldRetry: boolean;
    improvedResponse?: string;
}
export declare class Reflection {
    private readonly provider;
    private readonly logger;
    constructor(provider: LLMProvider, logger: Logger);
    evaluate(originalRequest: string, agentResponse: string, context?: string): Promise<ReflectionResult>;
}
//# sourceMappingURL=reflection.d.ts.map