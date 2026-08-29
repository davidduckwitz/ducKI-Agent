import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { DatabaseService, LlmWikiEntrySelect } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { buildMatchSnippet, scoreKeywordRelevance, tokenizeText } from "@ducki/shared";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { upsertProfileEntry } from "./profile-memory.js";
import {
  spreadActivation,
  type ActivationGraphEdge,
  type ActivationResultNode,
  type ActivationSeed,
} from "./spreading-activation.js";

const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const IGNORED_DIR_NAMES = new Set([".obsidian", ".trash", ".git"]);

// A note tagged with either of these (frontmatter `tags:`, case-insensitive) gets promoted
// into a guaranteed-present agent instruction - see commandPrefix()/ingestNow() below.
const COMMAND_TAGS = new Set(["befehl", "command"]);

/**
 * Per-file prefix for a promoted "Befehl"-tagged note, mirroring AGENT_BEHAVIOR_PREFIX /
 * HUMAN_INFO_PREFIX in apps/server/src/routes/memory.ts but addressed per source file
 * instead of one global slot, since a wiki can have many independent command notes.
 */
export function commandPrefix(sourceFile: string): string {
  return `[PROFILE:COMMAND:${sourceFile}]`;
}

interface ParsedFrontmatter {
  tags: string[];
  body: string;
}

interface ParsedWikiLink {
  targetRaw: string;
  targetFile: string | null;
}

interface IngestStats {
  scannedFiles: number;
  processedFiles: number;
  skippedFiles: number;
  prunedFiles: number;
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
    if (entry.isDirectory() && IGNORED_DIR_NAMES.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs));
      continue;
    }
    if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * Strips a leading YAML frontmatter block (`---\n...\n---`, Obsidian's note-property
 * format) and pulls out `tags`/`aliases` if present. Only a flat list form is
 * supported (`tags: [a, b]` or `tags:\n  - a\n  - b`) - enough for Obsidian's default
 * property editor without pulling in a full YAML parser dependency.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { tags: [], body: content };

  const block = match[1] ?? "";
  const body = content.slice(match[0].length);
  const tags: string[] = [];

  const inlineMatch = /^tags:\s*\[(.*)]\s*$/m.exec(block);
  if (inlineMatch) {
    for (const raw of (inlineMatch[1] ?? "").split(",")) {
      const tag = raw.trim().replace(/^["']|["']$/g, "");
      if (tag) tags.push(tag);
    }
  } else {
    const listMatch = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(block);
    if (listMatch) {
      for (const line of (listMatch[1] ?? "").split("\n")) {
        const item = /^\s*-\s*(.+)\s*$/.exec(line);
        const tag = item?.[1]?.trim().replace(/^["']|["']$/g, "");
        if (tag) tags.push(tag);
      }
    }
  }

  return { tags, body };
}

/**
 * Extracts `[[Target]]` / `[[Target|Alias]]` wikilinks from raw note content and
 * resolves each against the known files in the vault the way Obsidian does by
 * default: match by filename, case-insensitive, extension optional.
 */
export interface WikiNoteNode {
  id: string;
  title: string;
  status: string;
  tags: string[];
  kind?: "note" | "folder";
}

export interface FolderStructureEdge {
  source: string;
  target: string;
}

/**
 * Basename-only titles are ambiguous for "index.md" specifically: the wiki-index
 * skill (see apps/server/skills/wiki-index) deliberately creates one per folder, so
 * "index" is never unique once more than the root exists. Every other display in the
 * UI (graph labels, the "add connection" dropdown) reads this title directly, so the
 * disambiguation has to happen once, here, rather than in every consumer.
 */
function titleForSourceFile(sourceFile: string): string {
  const slashIdx = sourceFile.lastIndexOf("/");
  const base = (slashIdx >= 0 ? sourceFile.slice(slashIdx + 1) : sourceFile).replace(/\.[a-z0-9]+$/i, "");
  if (base.toLowerCase() !== "index" || slashIdx < 0) return base;
  const parentFolder = sourceFile.slice(0, slashIdx).split("/").pop();
  return parentFolder ? `${parentFolder}/index` : base;
}

/**
 * Folds chunk-level `llm_wiki_entries` rows (`sourceFile#chunk-N`) down to one node
 * per source file - the graph's unit is a note, not a chunk. Shared between the
 * `/api/wiki/graph` route and `LlmWikiService.expand()` so both operate on the exact
 * same node set instead of two independent re-implementations of the same fold.
 */
export function aggregateWikiNotes(entries: LlmWikiEntrySelect[]): WikiNoteNode[] {
  const byFile = new Map<string, WikiNoteNode>();
  for (const entry of entries) {
    let meta: Record<string, unknown> = {};
    try {
      meta = entry.metadata ? JSON.parse(entry.metadata) : {};
    } catch {
      meta = {};
    }
    const sourceFile = typeof meta["sourceFile"] === "string" ? (meta["sourceFile"] as string) : entry.sourcePath.split("#chunk-")[0];
    if (!sourceFile || byFile.has(sourceFile)) continue;
    byFile.set(sourceFile, {
      id: sourceFile,
      title: titleForSourceFile(sourceFile),
      status: entry.status,
      tags: Array.isArray(meta["tags"]) ? (meta["tags"] as string[]) : [],
      kind: "note",
    });
  }
  return Array.from(byFile.values());
}

/**
 * Derives one synthetic "folder" node per directory level a note lives under - the
 * FULL ancestor chain, not just the immediate parent, so a note two levels deep
 * (e.g. `Gesundheit/chs_cannabinoid_.../file.md`) produces both a
 * `folder:Gesundheit/chs_cannabinoid_...` node AND a `folder:Gesundheit` node, linked
 * to each other. Without the full chain, a top-level grouping folder that has no
 * files directly inside it (only subfolders) would never appear in the graph at all -
 * indexing would visibly "start" one level deeper than the real folder structure.
 *
 * Still bounded and non-explosive: one file -> immediate-folder edge, plus one
 * folder -> parent-folder edge per directory level (deduplicated), so the edge count
 * is O(notes * average path depth), never O(notes^2) - folder depth in practice is a
 * handful of levels, not hundreds.
 */
export function deriveFolderStructure(notes: WikiNoteNode[]): { folderNodes: WikiNoteNode[]; folderEdges: FolderStructureEdge[] } {
  const folderNodes = new Map<string, WikiNoteNode>();
  const edgeKeys = new Set<string>();
  const folderEdges: FolderStructureEdge[] = [];

  function ensureFolder(path: string): string {
    const id = `folder:${path}`;
    if (!folderNodes.has(id)) {
      folderNodes.set(id, {
        id,
        title: path.split("/").pop() ?? path,
        status: "folder",
        tags: [],
        kind: "folder",
      });
    }
    return id;
  }

  function addEdge(source: string, target: string): void {
    const key = `${source}=>${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    folderEdges.push({ source, target });
  }

  for (const note of notes) {
    const slashIdx = note.id.lastIndexOf("/");
    if (slashIdx <= 0) continue; // root-level file - no parent folder to link through
    const segments = note.id.slice(0, slashIdx).split("/");

    addEdge(note.id, ensureFolder(segments.join("/")));

    for (let i = segments.length; i > 1; i--) {
      const childId = ensureFolder(segments.slice(0, i).join("/"));
      const parentId = ensureFolder(segments.slice(0, i - 1).join("/"));
      addEdge(childId, parentId);
    }
  }

  return { folderNodes: Array.from(folderNodes.values()), folderEdges };
}

export function parseWikiLinks(content: string, knownFilesByStem: Map<string, string>): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  const seen = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?]]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const targetRaw = (m[1] ?? "").trim();
    if (!targetRaw || seen.has(targetRaw)) continue;
    seen.add(targetRaw);
    const stem = targetRaw.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
    links.push({ targetRaw, targetFile: knownFilesByStem.get(stem) ?? null });
  }
  return links;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Search tokens for wiki content.
 *
 * Stopwords are kept out (they appear in every entry and made every document look
 * equally relevant) and umlauts stay inside their word instead of splitting it - the
 * previous /[^a-z0-9_-]+/ split turned "Ausführung" into ["ausf","hrung"], so a German
 * wiki was largely unsearchable with German queries.
 */
function tokenize(value: string): string[] {
  return tokenizeText(normalizeWhitespace(value));
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
    prunedFiles: 0,
    memoriesCreated: 0,
    updatedAt: new Date().toISOString(),
  };

  constructor(private readonly db: DatabaseService, private readonly logger: Logger) {}

  async start(): Promise<void> {
    const root = await this.resolveWikiRoot();
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

      const root = await this.resolveWikiRoot();
      if (!existsSync(root)) mkdirSync(root, { recursive: true });

      const files = listFilesRecursive(root).filter((file) => isTextFile(file));
      const existing = await this.db.listLlmWikiEntries(2000);
      const existingByPath = new Map(existing.map((entry) => [entry.sourcePath, entry]));

      const knownFilesByStem = new Map<string, string>();
      for (const abs of files) {
        const rel = relative(root, abs).replaceAll("\\", "/");
        const stem = rel.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
        const base = (rel.split("/").pop() ?? rel).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
        knownFilesByStem.set(stem, rel);
        if (!knownFilesByStem.has(base)) knownFilesByStem.set(base, rel);
      }

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
      let prunedFiles = 0;

      // Files the user deleted by hand on disk never show up in `files` again, so
      // nothing in the main loop below would ever notice them. Diff the source files
      // still referenced in the DB against what is actually on disk right now and
      // drop the ones that vanished: their entries, their own outgoing links, their
      // "[LLM-WIKI:...]" memories, and flip any *incoming* link that pointed at them
      // to unresolved (mirrors how Obsidian shows a link to a deleted note).
      const knownSourceFiles = new Set(Array.from(knownFilesByStem.values()));
      const existingSourceFiles = new Set<string>();
      for (const entry of existing) {
        let meta: Record<string, unknown> = {};
        try {
          meta = entry.metadata ? JSON.parse(entry.metadata) : {};
        } catch {
          meta = {};
        }
        const sourceFile = typeof meta["sourceFile"] === "string" ? (meta["sourceFile"] as string) : entry.sourcePath.split("#chunk-")[0];
        if (sourceFile) existingSourceFiles.add(sourceFile);
      }

      for (const sourceFile of existingSourceFiles) {
        if (knownSourceFiles.has(sourceFile)) continue;
        for (const entry of existing) {
          if (entry.sourcePath === sourceFile || entry.sourcePath.startsWith(`${sourceFile}#chunk-`)) {
            await this.db.deleteLlmWikiEntryBySourcePath(entry.sourcePath);
          }
        }
        await removeExistingWikiMemoriesByPrefix(this.db, sourceFile, { broad: true });
        await this.db.removeLlmWikiLinksBySourceFile(sourceFile);
        await this.db.unresolveLlmWikiLinksByTargetFile(sourceFile);
        // A deleted file's promoted command instruction (if any) must not linger as a
        // guaranteed-present memory forever - demote it the same way an untagged edit would.
        await upsertProfileEntry(this.db, "long-term", commandPrefix(sourceFile), "", 9);
        prunedFiles += 1;
      }

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

        await removeExistingWikiMemoriesByPrefix(this.db, rel, { broad: true });

        const { tags, body } = parseFrontmatter(content);
        const links = parseWikiLinks(body, knownFilesByStem);
        await this.db.syncParsedLlmWikiLinks(rel, links);

        // "Befehl"/"command" tag: promote this note into a guaranteed-present agent
        // instruction (importance 9, same tier as the agent-behavior/human-info profile
        // blobs) instead of an ordinary semantic memory that has to compete for a context
        // slot. Untagging or editing re-runs this on the next ingest and keeps it in sync;
        // an untagged note demotes (upsertProfileEntry deletes-only on empty content).
        const isCommandNote = tags.some((t) => COMMAND_TAGS.has(t.toLowerCase()));
        await upsertProfileEntry(this.db, "long-term", commandPrefix(rel), isCommandNote ? body : "", 9);

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
              tags,
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
        prunedFiles,
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

  private async resolveWikiRoot(): Promise<string> {
    const sharedRoot = SHARED_WORKSPACE_ROOT;
    const setting = await this.db.getSetting("WIKI_SHARED_SOURCE_PATH");
    const configured = setting?.trim() || process.env["WIKI_SHARED_SOURCE_PATH"]?.trim() || "llm-wiki";
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
    const queryTokens = Array.from(new Set(tokenize(normalized)));
    if (queryTokens.length === 0) return [];

    const entries = await this.db.listLlmWikiEntries(3000);
    const scoped = entries.filter((entry) => {
      if (entry.status === "rejected" || entry.status === "error") return false;
      if (entry.status === "approved") return true;
      if (entry.status === "candidate") return includeCandidates;
      return false;
    });

    const scored = scoped
      .map((entry) => {
        const contentScore = scoreKeywordRelevance(entry.content, queryTokens);
        // A hit in the title says far more about what an entry is about than a passing
        // mention somewhere in its body, so it is weighted separately rather than being
        // flattened into one bag of words with the whole document.
        const titleScore = scoreKeywordRelevance(entry.title, queryTokens) * 1.5;
        const relevance = contentScore + titleScore;
        if (relevance <= 0) return undefined;

        const recency = computeRecencyBoost(entry.updatedAt);
        const moderated = statusWeight(entry.status);
        return {
          id: entry.id,
          sourcePath: entry.sourcePath,
          title: entry.title,
          status: entry.status,
          score: relevance + recency + moderated,
          // Show the passage that actually matched, not the first 240 characters of the
          // document - which for a long note is almost never where the answer is.
          contentPreview: buildMatchSnippet(entry.content, queryTokens),
          updatedAt: entry.updatedAt,
        };
      })
      .filter((item): item is WikiSearchResult => Boolean(item))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(100, limit)));

    return scored;
  }

  /**
   * Spreading-activation expansion from a keyword query or explicit seed notes,
   * over the link graph (see spreading-activation.ts). Pure/deterministic given the
   * current graph - no LLM calls, hard-capped output, safe to call freely.
   */
  async expand(options: { query?: string; seedIds?: string[]; maxHops?: number; maxNodes?: number }): Promise<ActivationResultNode[]> {
    const entries = await this.db.listLlmWikiEntries(3000);
    const noteNodes = aggregateWikiNotes(entries);
    const { folderNodes, folderEdges } = deriveFolderStructure(noteNodes);
    const notes = [...noteNodes, ...folderNodes];

    const links = await this.db.listLlmWikiLinks("active");
    const edges: ActivationGraphEdge[] = [
      ...links.filter((link) => link.targetFile).map((link) => ({ source: link.sourceFile, target: link.targetFile as string })),
      ...folderEdges,
    ];

    let seeds: ActivationSeed[];
    const seedIds = options.seedIds?.filter((id) => id.trim().length > 0) ?? [];
    if (seedIds.length > 0) {
      seeds = seedIds.map((id) => ({ id, activation: 1 }));
    } else {
      const query = (options.query ?? "").trim();
      if (!query) return [];
      const queryTokens = Array.from(new Set(tokenize(query)));
      if (queryTokens.length === 0) return [];

      const bestByFile = new Map<string, number>();
      for (const entry of entries) {
        if (entry.status === "rejected" || entry.status === "error") continue;
        const contentScore = scoreKeywordRelevance(entry.content, queryTokens);
        const titleScore = scoreKeywordRelevance(entry.title, queryTokens) * 1.5;
        const relevance = contentScore + titleScore;
        if (relevance <= 0) continue;
        let meta: Record<string, unknown> = {};
        try {
          meta = entry.metadata ? JSON.parse(entry.metadata) : {};
        } catch {
          meta = {};
        }
        const sourceFile = typeof meta["sourceFile"] === "string" ? (meta["sourceFile"] as string) : entry.sourcePath.split("#chunk-")[0];
        if (!sourceFile) continue;
        const prev = bestByFile.get(sourceFile) ?? 0;
        if (relevance > prev) bestByFile.set(sourceFile, relevance);
      }
      if (bestByFile.size === 0) return [];
      const max = Math.max(...Array.from(bestByFile.values()));
      seeds = Array.from(bestByFile.entries()).map(([id, score]) => ({ id, activation: score / max }));
    }

    return spreadActivation(notes, edges, seeds, { maxHops: options.maxHops, maxNodes: options.maxNodes });
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
