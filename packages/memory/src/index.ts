import type { DatabaseService } from "@ducki/database";
import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";

export interface KnowledgeEntry {
  id?: number;
  content: string;
  category?: string;
  importance: number;
  embedding?: number[];
}

export class KnowledgeBase {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  store(entry: KnowledgeEntry): void {
    this.db.addMemory({
      content: entry.content,
      importance: entry.importance,
      type: "semantic",
      conversationId: undefined,
    });
    this.logger.debug("Knowledge stored", { content: entry.content.slice(0, 50) });
  }

  async search(query: string, limit = 10): Promise<KnowledgeEntry[]> {
    const all = await this.db.getMemories(undefined, "semantic");
    const q = query.toLowerCase();
    return all
      .filter((m) => m.content.toLowerCase().includes(q))
      .slice(0, limit)
      .map((m) => ({ id: m.id, content: m.content, importance: m.importance }));
  }

  async getAll(): Promise<KnowledgeEntry[]> {
    return (await this.db.getMemories(undefined, "semantic")).map((m) => ({
      id: m.id,
      content: m.content,
      importance: m.importance,
    }));
  }
}

export class EmbeddingsManager {
  constructor(
    private readonly db: DatabaseService,
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    const dot = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
    const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
    const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
    return magA && magB ? dot / (magA * magB) : 0;
  }

  async store(content: string, metadata?: Record<string, unknown>): Promise<void> {
    // Store without embeddings for now (would need embedding endpoint)
    this.db.addEmbedding({
      content,
      embedding: JSON.stringify([]),
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    });
  }
}

export class Summarizer {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  async summarize(messages: LLMMessage[], maxLength = 500): Promise<string> {
    if (messages.length === 0) return "";

    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const response = await this.provider.generate([
      {
        role: "system",
        content: "Summarize the following conversation briefly and accurately.",
      },
      {
        role: "user",
        content: `Summarize in max ${maxLength} chars:\n\n${conversation}`,
      },
    ], { temperature: 0.3, maxTokens: 300 });

    return response.content;
  }
}

export class MemoryManager {
  readonly knowledgeBase: KnowledgeBase;
  readonly embeddings: EmbeddingsManager;
  readonly summarizer: Summarizer;

  constructor(
    db: DatabaseService,
    provider: LLMProvider,
    logger: Logger
  ) {
    this.knowledgeBase = new KnowledgeBase(db, logger);
    this.embeddings = new EmbeddingsManager(db, provider, logger);
    this.summarizer = new Summarizer(provider, logger);
  }
}

export { KnowledgeBase as KnowledgeBaseService };
