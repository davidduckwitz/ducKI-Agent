import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
export interface ReasoningResult {
    thinking: string;
    action: "respond" | "use_tool" | "ask_clarification" | "complete";
    response?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    confidence: number;
}
export declare class Reasoner {
    private readonly provider;
    private readonly logger;
    constructor(provider: LLMProvider, logger: Logger);
    reason(messages: LLMMessage[], availableTools: string[], context?: string): Promise<ReasoningResult>;
}
//# sourceMappingURL=reasoner.d.ts.map