import type { LLMMessage, LLMContent } from "@ducki/shared";

export interface HistoryEntry {
  timestamp: string;
  role: LLMMessage["role"];
  content: string | LLMContent[];
  toolName?: string;
}

export class History {
  private entries: HistoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  add(message: LLMMessage, toolName?: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      role: message.role,
      content: message.content,
      toolName,
    });

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getAll(): HistoryEntry[] {
    return [...this.entries];
  }

  getLast(count: number): HistoryEntry[] {
    return this.entries.slice(-count);
  }

  getByRole(role: LLMMessage["role"]): HistoryEntry[] {
    return this.entries.filter((e) => e.role === role);
  }

  clear(): void {
    this.entries = [];
  }

  clearByType(toolName: string): void {
    this.entries = this.entries.filter((e) => e.toolName !== toolName);
  }

  get length(): number {
    return this.entries.length;
  }

  toMessages(): LLMMessage[] {
    return this.entries.map((e) => ({
      role: e.role,
      content: e.content,
    }));
  }
}
