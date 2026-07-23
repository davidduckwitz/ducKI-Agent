import type { LLMMessage } from "@ducki/shared";
export interface HistoryEntry {
    timestamp: string;
    role: LLMMessage["role"];
    content: string;
    toolName?: string;
}
export declare class History {
    private entries;
    private readonly maxEntries;
    constructor(maxEntries?: number);
    add(message: LLMMessage, toolName?: string): void;
    getAll(): HistoryEntry[];
    getLast(count: number): HistoryEntry[];
    getByRole(role: LLMMessage["role"]): HistoryEntry[];
    clear(): void;
    get length(): number;
    toMessages(): LLMMessage[];
}
//# sourceMappingURL=history.d.ts.map