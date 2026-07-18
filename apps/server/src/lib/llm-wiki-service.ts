import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json"]);

interface IngestStats {
  scannedFiles: number;
  processedFiles: number;
  skippedFiles: number;
  memoriesCreated: number;
  updatedAt: string;
  lastError?: string;
}

interface WikiSearchResult {
  id: number;
  sourcePath: string;
  title: string;
  status: string;
  score: number;
  contentPreview: string;
  updatedAt: string;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeTitle(sourcePath: string): string {
  const base = sourcePath.replaceAll("\\", "/").split("/").pop() ?? sourcePath;
  return base.replace(/\.[a-z0-9]+$/i, "") || sourcePath;
}

function isTextFile(path: string): boolean {
  return ALLOWED_EXTENSIONS.has(extname(path).toLowerCase());
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs));
      continue;
    }
    if (entry.isFile()) out.push(abs);
  }
  return out;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((token) => token.length >= 2);
}

function chunkContent(content: string, chunkSize: number, overlap: number): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  const effectiveChunk = Math.max(300, chunkSize);
  const effectiveOverlap = Math.max(0, Math.min(effectiveChunk - 50, overlap));

  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + effectiveChunk);
    if (end < normalized.length) {
      const newlineIdx = normalized.lastIndexOf("\n", end);
      if (newlineIdx > cursor + 120) {
        end = newlineIdx;
      }
    }
    const part = normalized.slice(cursor, end).trim();
    if (part.length > 0) chunks.push(part);
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - effectiveOverlap);
  }

  return chunks;
}

async function removeExistingWikiMemoriesByPrefix(
  db: DatabaseService,
  sourcePrefix: string,
  options?: { broad?: boolean }
): Promise<void> {
  const entries = await db.getMemories(undefined, "semantic");
  const broad = options?.broad ?? false;
  const prefix = broad ? `[LLM-WIKI:${sourcePrefix}` : `[LLM-WIKI:${sourcePrefix}]`;
  for (const entry of entries) {
    if (entry.content.startsWith(prefix)) {
      await db.deleteMemory(entry.id);
    }
  }
}

function computeRecencyBoost(updatedAt: string): number {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageMs = Math.max(0, Date.now() - ts);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays <= 1) return 0.25;
  if (ageDays <= 7) return 0.15;
  if (ageDays <= 30) return 0.08;
  return 0;
}

function statusWeight(status: string): number {
  if (status === "approved") return 0.22;
  if (status === "candidate") return 0.08;
  return 0;
}

export class LlmWikiService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stats: IngestStats = {
    scannedFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    memoriesCreated: 0,
    updatedAt: new Date().toISOString(),
  };

  constructor(private readonly db: DatabaseService, private readonly logger: Logger) {}

  async start(): Promise<void> {
    const root = this.resolveWikiRoot();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });

    const intervalMs = await this.getIntervalMs();
    await this.ingestNow();
    this.timer = setInterval(() => {
      void this.ingestNow();
    }, intervalMs);
    this.logger.info("LLM wiki service started", {
      root,
      intervalMs,
      enabled: await this.isEnabled(),
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStats(): IngestStats {
    return { ...this.stats };
  }

  async isEnabled(): Promise<boolean> {
    const setting = await this.db.getSetting("WIKI_ENABLED");
    const env = process.env["WIKI_ENABLED"];
    return parseBoolean(setting ?? env, false);
  }

  async ingestNow(): Promise<IngestStats> {
    if (this.running) return this.getStats();
    this.running = true;

    try {
      const enabled = await this.isEnabled();
      if (!enabled) {
        this.stats = {
          ...this.stats,
          updatedAt: new Date().toISOString(),
          lastError: undefined,
        };
        return this.getStats();
      }

      const root = this.resolveWikiRoot();
      if (!existsSync(root)) mkdirSync(root, { recursive: true });

      const files = listFilesRecursive(root).filter((file) => isTextFile(file));
      const existing = await this.db.listLlmWikiEntries(2000);
      const existingByPath = new Map(existing.map((entry) => [entry.sourcePath, entry]));

      const autoMemoryRaw = await this.db.getSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY");
      const autoMemory = parseBoolean(autoMemoryRaw, true);
      const autoApproveRaw = await this.db.getSetting("WIKI_AUTO_APPROVE");
      const autoApprove = parseBoolean(autoApproveRaw, false);
      const chunkSizeRaw = await this.db.getSetting("WIKI_CHUNK_SIZE_CHARS");
      const chunkOverlapRaw = await this.db.getSetting("WIKI_CHUNK_OVERLAP_CHARS");
      const chunkSize = Number.parseInt(chunkSizeRaw ?? "1400", 10);
      const chunkOverlap = Number.parseInt(chunkOverlapRaw ?? "200", 10);

      let processedFiles = 0;
      let skippedFiles = 0;
      let memoriesCreated = 0;

      for (const abs of files) {
        const rel = relative(root, abs).replaceAll("\\", "/");
        const st = statSync(abs);
        const maxSizeKbRaw = await this.db.getSetting("WIKI_SHARED_SOURCE_MAX_FILE_SIZE_KB");
        const maxSizeKb = Number.parseInt(maxSizeKbRaw ?? "256", 10);
        if (st.size > Math.max(32, maxSizeKb) * 1024) {
          skippedFiles += 1;
          continue;
        }

        const content = readFileSync(abs, "utf8");
        const contentHash = hashContent(content);
        const basePrefix = `${rel}#chunk-`;
        const previous = existingByPath.get(`${basePrefix}1`);
        if (previous && previous.contentHash === contentHash) {
          skippedFiles += 1;
          continue;
        }

        await this.db.deleteLlmWikiEntriesBySourcePrefix(basePrefix);
        await removeExistingWikiMemoriesByPrefix(this.db, rel, { broad: true });

        const chunks = chunkContent(content, chunkSize, chunkOverlap);
        if (chunks.length === 0) {
          skippedFiles += 1;
          continue;
        }

        const status = autoApprove ? "approved" : "candidate";
        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx] ?? "";
          const sourcePath = `${basePrefix}${idx + 1}`;
          const title = `${normalizeTitle(rel)} (chunk ${idx + 1}/${chunks.length})`;
          await this.db.upsertLlmWikiEntry({
            sourcePath,
            title,
            content: chunk,
            contentHash,
            status,
            metadata: JSON.stringify({
              sourceFile: rel,
              chunkIndex: idx + 1,
              chunkCount: chunks.length,
              size: st.size,
              updatedAt: st.mtime.toISOString(),
            }),
          });

          if (autoMemory && status === "approved") {
            await this.db.addMemory({
              type: "semantic",
              content: `[LLM-WIKI:${sourcePath}] ${chunk.slice(0, 12000)}`,
              importance: 7,
            });
            memoriesCreated += 1;
          }
        }

        processedFiles += 1;
      }

      this.stats = {
        scannedFiles: files.length,
        processedFiles,
        skippedFiles,
        memoriesCreated,
        updatedAt: new Date().toISOString(),
      };
      return this.getStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stats = {
        ...this.stats,
        updatedAt: new Date().toISOString(),
        lastError: message,
      };
      this.logger.warn("LLM wiki ingest failed", { error: message });
      return this.getStats();
    } finally {
      this.running = false;
    }
  }

  private resolveWikiRoot(): string {
    const sharedRoot = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");
    const configured = process.env["WIKI_SHARED_SOURCE_PATH"]?.trim() || "llm-wiki";
    const clean = configured.replaceAll("\\", "/").replace(/^\/+/, "");
    return resolve(sharedRoot, clean);
  }

  private async getIntervalMs(): Promise<number> {
    const raw = await this.db.getSetting("WIKI_INGEST_INTERVAL_MS");
    const parsed = Number.parseInt(raw ?? "30000", 10);
    return Math.max(5000, Number.isFinite(parsed) ? parsed : 30000);
  }

  async listEntries(limit = 200, status?: string): Promise<Awaited<ReturnType<DatabaseService["listLlmWikiEntries"]>>> {
    const entries = await this.db.listLlmWikiEntries(limit);
    if (!status || status === "all") return entries;
    return entries.filter((entry) => entry.status === status);
  }

  async search(query: string, limit = 20, includeCandidates = false): Promise<WikiSearchResult[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    const queryTokens = new Set(tokenize(normalized));
    if (queryTokens.size === 0) return [];

    const entries = await this.db.listLlmWikiEntries(3000);
    const scoped = entries.filter((entry) => {
      if (entry.status === "rejected" || entry.status === "error") return false;
      if (entry.status === "approved") return true;
      if (entry.status === "candidate") return includeCandidates;
      return false;
    });

    const scored = scoped
      .map((entry) => {
        const hayTokens = new Set(tokenize(`${entry.title} ${entry.content}`));
        if (hayTokens.size === 0) return undefined;
        let overlap = 0;
        for (const token of queryTokens) {
          if (hayTokens.has(token)) overlap += 1;
        }
        if (overlap === 0) return undefined;
        const overlapScore = overlap / Math.max(queryTokens.size, 1);
        const recency = computeRecencyBoost(entry.updatedAt);
        const moderated = statusWeight(entry.status);
        const score = overlapScore + recency + moderated;
        return {
          id: entry.id,
          sourcePath: entry.sourcePath,
          title: entry.title,
          status: entry.status,
          score,
          contentPreview: entry.content.slice(0, 240),
          updatedAt: entry.updatedAt,
        };
      })
      .filter((item): item is WikiSearchResult => Boolean(item))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(100, limit)));

    return scored;
  }

  async setEntryStatus(id: number, status: "approved" | "rejected"): Promise<{ id: number; status: string }> {
    const entry = await this.db.getLlmWikiEntry(id);
    if (!entry) {
      throw new Error("Wiki entry not found");
    }

    const updated = await this.db.updateLlmWikiEntryStatus(id, status);
    if (!updated) {
      throw new Error("Failed to update wiki status");
    }

    if (status === "approved") {
      const autoMemoryRaw = await this.db.getSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY");
      const autoMemory = parseBoolean(autoMemoryRaw, true);
      if (autoMemory) {
        await removeExistingWikiMemoriesByPrefix(this.db, entry.sourcePath, { broad: false });
        await this.db.addMemory({
          type: "semantic",
          content: `[LLM-WIKI:${entry.sourcePath}] ${entry.content.slice(0, 12000)}`,
          importance: 7,
        });
      }
    }

    if (status === "rejected") {
      await removeExistingWikiMemoriesByPrefix(this.db, entry.sourcePath, { broad: false });
    }

    return { id: updated.id, status: updated.status };
  }
}
