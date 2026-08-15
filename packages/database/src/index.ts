import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, desc, and, lt, or, isNull, gt, like, notInArray } from "drizzle-orm";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { scoreKeywordRelevance, foldGerman, tokenizeText } from "@ducki/shared";
import * as schema from "./schema.js";
import { computeNextRun } from "./cron.js";
import type {
  ConversationInsert,
  ConversationSelect,
  MessageInsert,
  MessageSelect,
  ProjectInsert,
  ProjectSelect,
  TaskInsert,
  TaskSelect,
  MemoryInsert,
  MemorySelect,
  SettingInsert,
  SettingSelect,
  LogInsert,
  EmbeddingInsert,
  EmbeddingSelect,
  CronJobInsert,
  CronJobSelect,
  ArchivedConversationInsert,
  ArchivedConversationSelect,
  LlmWikiEntryInsert,
  LlmWikiEntrySelect,
  DynamicToolInsert,
  DynamicToolSelect,
} from "./schema.js";

export type { LibSQLDatabase };
export type Database = LibSQLDatabase<typeof schema>;
export * from "./schema.js";
export { openPluginDb, closeAllPluginDbs } from "./plugin-storage.js";
export { encryptSecret, decryptSecret, isEncrypted } from "./plugin-secrets.js";
export {
  getPluginSettings,
  setPluginSetting,
  getPluginRuntimeConfig,
  type PluginSettingSpecLike,
  type PluginRuntimeConfig,
} from "./plugin-settings.js";
export type { PluginStorage } from "./plugin-storage.js";
export * from "./cron.js";
export { testMysqlConnection, EXPECTED_APP_TABLES } from "./mysql-tester.js";
export type { MysqlTestConfig, MysqlTestResult } from "./mysql-tester.js";

export class DatabaseService {
  private db!: LibSQLDatabase<typeof schema>;
  private client!: Client;
  private logger: Logger;

  constructor(private readonly dbPath: string = "./storage/ducki.db") {
    this.logger = getRootLogger().child("Database");
  }

  async initialize(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.client = createClient({ url: `file:${this.dbPath}` });
    this.db = drizzle(this.client, { schema });
    const journalMode = await this.applyConnectionPragmas();
    await this.runMigrations();

    this.logger.info("Database initialized", { path: this.dbPath, journalMode });
  }

  /** Releases the underlying libsql client. Optional in long-running servers; useful for tests and
   *  short-lived scripts so the database file is not left locked. */
  close(): void {
    try {
      this.client?.close();
    } catch {
      // Already closed or never opened - nothing to release.
    }
  }

  /**
   * SQLite's defaults are the wrong ones for a server process.
   *
   * With the default rollback journal a writer takes an exclusive lock on the whole
   * database, so any concurrent read turns a write into "database is locked" - and
   * without a busy timeout that failure is immediate instead of waiting for the lock
   * to clear. Both bit us on ordinary traffic (gateway writing a message while a
   * request read conversations).
   *
   * Returns the journal mode actually in effect, which is logged so a failed WAL
   * switch (e.g. database on a network share, where WAL is unsupported) is visible
   * rather than silent.
   */
  private async applyConnectionPragmas(): Promise<string> {
    let journalMode = "unknown";
    try {
      // WAL persists in the file header, so this only has to succeed once, and it lets
      // readers and the writer work concurrently.
      const result = await this.client.execute("PRAGMA journal_mode = WAL");
      journalMode = String(result.rows[0]?.["journal_mode"] ?? "unknown");

      // Wait up to 5s for a contended lock instead of failing straight away.
      await this.client.execute("PRAGMA busy_timeout = 5000");

      // The documented safe companion to WAL: fsync at checkpoints rather than on
      // every commit.
      await this.client.execute("PRAGMA synchronous = NORMAL");
    } catch (error) {
      this.logger.warn("Could not apply SQLite connection pragmas", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (journalMode.toLowerCase() !== "wal") {
      this.logger.warn(
        "SQLite is not running in WAL mode - concurrent access may fail with 'database is locked'",
        { journalMode, path: this.dbPath }
      );
    }

    return journalMode;
  }

  private async runMigrations(): Promise<void> {
    const tables = [
      `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, folder TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project_id INTEGER REFERENCES projects(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, tool_call_id TEXT, tool_result TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', subtasks TEXT, result TEXT, parent_task_id INTEGER REFERENCES tasks(id), created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config_schema TEXT, last_used TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES conversations(id), type TEXT NOT NULL DEFAULT 'short-term', content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, context TEXT, timestamp TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tool_executions (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, input TEXT, output TEXT, success INTEGER NOT NULL, execution_time REAL, conversation_id INTEGER REFERENCES conversations(id), created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cron_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, schedule TEXT NOT NULL, target_type TEXT NOT NULL, target_ref TEXT, payload TEXT, enabled INTEGER NOT NULL DEFAULT 1, conversation_id INTEGER REFERENCES conversations(id), last_run_at TEXT, next_run_at TEXT, last_status TEXT, last_error TEXT, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS archived_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, original_conversation_id INTEGER NOT NULL, name TEXT NOT NULL, project_id INTEGER, message_count INTEGER NOT NULL, archived_at TEXT NOT NULL, metadata TEXT)`,
      `CREATE TABLE IF NOT EXISTS llm_wiki_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', metadata TEXT, learned_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS dynamic_tools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, parameters TEXT NOT NULL, script TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, currency TEXT NOT NULL, address TEXT NOT NULL UNIQUE, public_key TEXT, encrypted_private_key TEXT, label TEXT, balance TEXT DEFAULT '0', balance_usd REAL, is_master INTEGER DEFAULT 0, derivation_path TEXT, last_balance_sync TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, address_id INTEGER REFERENCES crypto_addresses(id), currency TEXT NOT NULL, hash TEXT UNIQUE, from_address TEXT, to_address TEXT, amount TEXT NOT NULL, fee TEXT, status TEXT DEFAULT 'pending', confirmations INTEGER DEFAULT 0, timestamp INTEGER, block_number INTEGER, note TEXT, synced_at TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_api_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, encrypted_api_key TEXT NOT NULL, encrypted_api_secret TEXT, is_active INTEGER DEFAULT 1, rate_limit_per_min INTEGER, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_portfolio_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, currency TEXT DEFAULT 'USD', refresh_interval_seconds INTEGER DEFAULT 300, auto_sync_enabled INTEGER DEFAULT 1, notifications_enabled INTEGER DEFAULT 0, export_format TEXT DEFAULT 'json', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_portfolio_history (id INTEGER PRIMARY KEY AUTOINCREMENT, total_value_usd REAL NOT NULL, btc_balance TEXT, btc_value_usd REAL, eth_balance TEXT, eth_value_usd REAL, xrp_balance TEXT, xrp_value_usd REAL, timestamp INTEGER NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS crypto_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, currency TEXT NOT NULL, price REAL NOT NULL, price_usd REAL NOT NULL, change_24h REAL, market_cap REAL, volume_24h REAL, timestamp INTEGER NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS session_checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL REFERENCES conversations(id), run_id TEXT, step_index INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, acceptance_criteria TEXT, constraint_kind TEXT, status TEXT NOT NULL DEFAULT 'pending', confidence TEXT, verify_state TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    ];
    for (const sql of tables) {
      await this.client.execute(sql);
    }

    await this.client.execute(`ALTER TABLE messages ADD COLUMN metadata TEXT`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });

    await this.client.execute(`ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });

    await this.client.execute(`ALTER TABLE memories ADD COLUMN content_folded TEXT`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });
    // One-time backfill of the folded prefilter column for rows that predate it. Cheap on a normal
    // memory table; the LIKE prefilter only skips rows once every candidate has a folded value.
    try {
      const pending = await this.db
        .select({ id: schema.memories.id, content: schema.memories.content })
        .from(schema.memories)
        .where(isNull(schema.memories.contentFolded))
        .all();
      for (const row of pending) {
        await this.db
          .update(schema.memories)
          .set({ contentFolded: foldGerman(row.content) })
          .where(eq(schema.memories.id, row.id))
          .run();
      }
      if (pending.length > 0) {
        this.logger.info("Backfilled folded content for memory prefilter", { rows: pending.length });
      }
    } catch (error) {
      this.logger.warn("Could not backfill memory content_folded column", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.client.execute(`ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });

    await this.client.execute(`ALTER TABLE tasks ADD COLUMN created_by TEXT`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });

    await this.client.execute(`ALTER TABLE cron_jobs ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)`).catch(() => {
      // Older databases may already have the column or reject duplicate adds.
    });

    // One-shot trigger fields (point-in-time jobs, e.g. calendar appointments).
    await this.client.execute(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`).catch(() => {});
    await this.client.execute(`ALTER TABLE cron_jobs ADD COLUMN run_once INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  }

  // ============================================================
  // Conversations
  // ============================================================
  async createConversation(data: Omit<ConversationInsert, "createdAt" | "updatedAt">): Promise<ConversationSelect> {
    const now = new Date().toISOString();
    const result = await this.db.insert(schema.conversations).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
    if (!result) throw new Error("Failed to create conversation");
    return result;
  }

  async getConversation(id: number): Promise<ConversationSelect | undefined> {
    return this.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
  }

  async updateConversation(id: number, data: Partial<Omit<ConversationInsert, "id" | "createdAt">>): Promise<ConversationSelect | undefined> {
    return this.db.update(schema.conversations).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.conversations.id, id)).returning().get();
  }

  async listConversations(projectId?: number): Promise<ConversationSelect[]> {
    if (projectId !== undefined) {
      return this.db.select().from(schema.conversations).where(eq(schema.conversations.projectId, projectId)).orderBy(desc(schema.conversations.createdAt)).all();
    }
    return this.db.select().from(schema.conversations).orderBy(desc(schema.conversations.createdAt)).all();
  }

  async listConversationsPage(args?: {
    projectId?: number;
    limit?: number;
    beforeId?: number;
  }): Promise<ConversationSelect[]> {
    const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 30)));
    const projectId = args?.projectId;
    const beforeId = args?.beforeId;
    const conditions = [];
    if (projectId !== undefined) conditions.push(eq(schema.conversations.projectId, projectId));
    if (beforeId !== undefined) conditions.push(lt(schema.conversations.id, beforeId));

    if (conditions.length === 0) {
      return this.db
        .select()
        .from(schema.conversations)
        .orderBy(desc(schema.conversations.id))
        .limit(limit)
        .all();
    }

    return this.db
      .select()
      .from(schema.conversations)
      .where(and(...conditions))
      .orderBy(desc(schema.conversations.id))
      .limit(limit)
      .all();
  }

  async deleteConversation(id: number): Promise<void> {
    await this.db.delete(schema.messages).where(eq(schema.messages.conversationId, id)).run();
    await this.db.delete(schema.memories).where(eq(schema.memories.conversationId, id)).run();
    await this.db.delete(schema.toolExecutions).where(eq(schema.toolExecutions.conversationId, id)).run();
    await this.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();
  }

  async deleteMessages(conversationId: number): Promise<void> {
    await this.db.delete(schema.messages).where(eq(schema.messages.conversationId, conversationId)).run();
  }

  // ============================================================
  // Messages
  // ============================================================
  /**
   * `createdAt` defaults to the insert time, but callers that already stamped a timestamp
   * on the thing being stored should pass it in: the agent emits an event to the socket and
   * persists it separately, and if the two carry different timestamps the client cannot
   * recognise the persisted copy as the same event (it dedups on type+content+time) and
   * renders it twice.
   */
  async addMessage(data: Omit<MessageInsert, "createdAt"> & { createdAt?: string }): Promise<MessageSelect> {
    const result = await this.db.insert(schema.messages).values({ ...data, createdAt: data.createdAt ?? new Date().toISOString() }).returning().get();
    if (!result) throw new Error("Failed to add message");
    return result;
  }

  async getMessages(conversationId: number): Promise<MessageSelect[]> {
    return this.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.id).all();
  }

  async getMessagesPage(args: {
    conversationId: number;
    limit?: number;
    beforeId?: number;
  }): Promise<MessageSelect[]> {
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
    const conditions = [eq(schema.messages.conversationId, args.conversationId)];
    if (args.beforeId !== undefined) {
      conditions.push(lt(schema.messages.id, args.beforeId));
    }

    const page = await this.db
      .select()
      .from(schema.messages)
      .where(and(...conditions))
      .orderBy(desc(schema.messages.id))
      .limit(limit)
      .all();

    return [...page].sort((a, b) => a.id - b.id);
  }

  async deleteMessagesAfter(conversationId: number, afterId: number): Promise<void> {
    await this.db
      .delete(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), gt(schema.messages.id, afterId)))
      .run();
  }

  // ============================================================
  // Projects
  // ============================================================
  async createProject(data: Omit<ProjectInsert, "createdAt" | "updatedAt">): Promise<ProjectSelect> {
    const now = new Date().toISOString();
    const result = await this.db.insert(schema.projects).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
    if (!result) throw new Error("Failed to create project");
    return result;
  }

  async getProject(id: number): Promise<ProjectSelect | undefined> {
    return this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  }

  async listProjects(): Promise<ProjectSelect[]> {
    return this.db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).all();
  }

  async updateProject(id: number, data: Partial<Omit<ProjectInsert, "id" | "createdAt">>): Promise<ProjectSelect | undefined> {
    return this.db.update(schema.projects).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.projects.id, id)).returning().get();
  }

  async getProjectDependencies(id: number): Promise<{
    codingFolder?: boolean;
    conversationCount: number;
    taskCount: number;
    workflowCount: number;
  }> {
    const conversationCount = await this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.projectId, id))
      .all()
      .then(r => r.length);

    const taskCount = await this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, id))
      .all()
      .then(r => r.length);

    return {
      codingFolder: true,
      conversationCount,
      taskCount,
      workflowCount: 0,
    };
  }

  async deleteProject(id: number, options?: {
    deleteCodingFolder?: boolean;
    deleteConversations?: boolean;
    deleteTasks?: boolean;
    deleteWorkflows?: boolean;
  }): Promise<void> {
    const shouldDeleteConversations = options?.deleteConversations !== false;
    const shouldDeleteTasks = options?.deleteTasks !== false;

    // Always delete archived conversations (they reference the project)
    await this.db.delete(schema.archivedConversations).where(eq(schema.archivedConversations.projectId, id)).run();

    if (shouldDeleteConversations) {
      const projectConversations = await this.db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.projectId, id))
        .all();

      for (const conversation of projectConversations) {
        await this.deleteConversation(conversation.id);
      }
    }

    if (shouldDeleteTasks) {
      await this.db.delete(schema.tasks).where(eq(schema.tasks.projectId, id)).run();
    }

    await this.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
  }

  // ============================================================
  // Tasks
  // ============================================================
  async createTask(data: Omit<TaskInsert, "createdAt" | "updatedAt">): Promise<schema.TaskSelect> {
    const now = new Date().toISOString();
    const result = await this.db.insert(schema.tasks).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
    if (!result) throw new Error("Failed to create task");
    return result;
  }

  async getTask(id: number): Promise<schema.TaskSelect | undefined> {
    return this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  }

  async listTasks(projectId?: number): Promise<schema.TaskSelect[]> {
    if (projectId !== undefined) {
      return this.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(desc(schema.tasks.createdAt)).all();
    }
    return this.db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).all();
  }

  async updateTask(id: number, data: Partial<Omit<TaskInsert, "id" | "createdAt">>): Promise<schema.TaskSelect | undefined> {
    return this.db.update(schema.tasks).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, id)).returning().get();
  }

  async deleteTask(id: number): Promise<void> {
    await this.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
  }

  async getSubtasks(parentTaskId: number): Promise<schema.TaskSelect[]> {
    return this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.parentTaskId, parentTaskId))
      .orderBy(schema.tasks.id)
      .all();
  }

  async listTasksByOwner(createdBy: string): Promise<schema.TaskSelect[]> {
    return this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.createdBy, createdBy))
      .orderBy(desc(schema.tasks.createdAt))
      .all();
  }

  // ============================================================
  // Session Checklist
  // ============================================================
  /** Create a checklist (one row per step) for a conversation run. Steps are inserted
   *  in the given order; stepIndex is assigned from the array position unless provided. */
  async createChecklist(
    conversationId: number,
    runId: string | undefined,
    items: Array<Pick<schema.SessionChecklistInsert, "title"> &
      Partial<Pick<schema.SessionChecklistInsert, "description" | "acceptanceCriteria" | "constraintKind" | "stepIndex" | "status">>>
  ): Promise<schema.SessionChecklistSelect[]> {
    if (items.length === 0) return [];
    const now = new Date().toISOString();
    const rows: schema.SessionChecklistInsert[] = items.map((item, idx) => ({
      conversationId,
      runId: runId ?? null,
      stepIndex: item.stepIndex ?? idx,
      title: item.title,
      description: item.description ?? null,
      acceptanceCriteria: item.acceptanceCriteria ?? null,
      constraintKind: item.constraintKind ?? null,
      status: item.status ?? "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));
    return this.db.insert(schema.sessionChecklist).values(rows).returning().all();
  }

  /** All checklist items for a conversation, ordered by step. When runId is given,
   *  only that run's items are returned (a re-plan creates a fresh runId). */
  async getChecklist(conversationId: number, runId?: string): Promise<schema.SessionChecklistSelect[]> {
    const conditions = [eq(schema.sessionChecklist.conversationId, conversationId)];
    if (runId !== undefined) {
      conditions.push(eq(schema.sessionChecklist.runId, runId));
    }
    return this.db
      .select()
      .from(schema.sessionChecklist)
      .where(and(...conditions))
      .orderBy(schema.sessionChecklist.stepIndex, schema.sessionChecklist.id)
      .all();
  }

  /** Open (not yet resolved) items for a run, ordered by step. "Open" = pending or in_progress. */
  async getOpenChecklistItems(conversationId: number, runId?: string): Promise<schema.SessionChecklistSelect[]> {
    const conditions = [
      eq(schema.sessionChecklist.conversationId, conversationId),
      or(eq(schema.sessionChecklist.status, "pending"), eq(schema.sessionChecklist.status, "in_progress"))!,
    ];
    if (runId !== undefined) {
      conditions.push(eq(schema.sessionChecklist.runId, runId));
    }
    return this.db
      .select()
      .from(schema.sessionChecklist)
      .where(and(...conditions))
      .orderBy(schema.sessionChecklist.stepIndex, schema.sessionChecklist.id)
      .all();
  }

  async updateChecklistItem(
    id: number,
    data: Partial<Omit<schema.SessionChecklistInsert, "id" | "conversationId" | "createdAt">>
  ): Promise<schema.SessionChecklistSelect | undefined> {
    return this.db
      .update(schema.sessionChecklist)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(schema.sessionChecklist.id, id))
      .returning()
      .get();
  }

  /** Remove all checklist rows for a conversation (or a single run of it). */
  async deleteChecklist(conversationId: number, runId?: string): Promise<void> {
    const conditions = [eq(schema.sessionChecklist.conversationId, conversationId)];
    if (runId !== undefined) {
      conditions.push(eq(schema.sessionChecklist.runId, runId));
    }
    await this.db.delete(schema.sessionChecklist).where(and(...conditions)).run();
  }

  // ============================================================
  // Memories
  // ============================================================
  async addMemory(data: Omit<MemoryInsert, "createdAt">): Promise<MemorySelect> {
    const result = await this.db.insert(schema.memories).values({
      ...data,
      // Keep the folded prefilter column in sync on write so retrieval never has to fall back to a
      // full scan for freshly stored memories.
      contentFolded: data.contentFolded ?? foldGerman(data.content),
      createdAt: new Date().toISOString(),
    }).returning().get();
    if (!result) throw new Error("Failed to add memory");
    return result;
  }

  async getMemories(conversationId?: number, type?: string, status?: string): Promise<MemorySelect[]> {
    const conditions = [];
    if (conversationId !== undefined) conditions.push(eq(schema.memories.conversationId, conversationId));
    if (type !== undefined) conditions.push(eq(schema.memories.type, type));
    if (status !== undefined) conditions.push(eq(schema.memories.status, status));
    if (conditions.length === 0) return this.db.select().from(schema.memories).orderBy(desc(schema.memories.importance)).all();
    return this.db.select().from(schema.memories).where(and(...conditions)).orderBy(desc(schema.memories.importance)).all();
  }

  async updateMemoryStatus(id: number, status: string): Promise<MemorySelect | undefined> {
    return this.db.update(schema.memories).set({ status }).where(eq(schema.memories.id, id)).returning().get();
  }

  async deleteMemory(id: number): Promise<void> {
    await this.db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
  }

  /**
   * Relevance search over memories.
   *
   * `conversationId` ranks, it does not filter: matches from that conversation are
   * boosted, but memories learned in other conversations still surface. Long-term memory
   * is global everywhere else in this codebase (getKnowledgePool reads across all
   * conversations), and only this path filtered on an exact conversation match - so the
   * agent's own retrieval could only ever return things it had learned inside the very
   * chat it was already in, which is exactly when it needs memory least.
   *
   * Pass `scopeToConversation` to get the old hard-scoped behaviour.
   */
  async searchMemories(
    keywords: string[],
    conversationId?: number,
    type?: string,
    status: string = "approved",
    limit: number = 10,
    scopeToConversation: boolean = false
  ): Promise<MemorySelect[]> {
    const conditions = [];
    if (conversationId !== undefined && scopeToConversation) {
      conditions.push(
        or(eq(schema.memories.conversationId, conversationId), isNull(schema.memories.conversationId))
      );
    }
    if (type !== undefined) conditions.push(eq(schema.memories.type, type));
    if (status !== undefined) conditions.push(eq(schema.memories.status, status));

    // SQL prefilter: only load rows whose folded content contains at least one folded keyword as a
    // substring. The scorer matches a keyword iff a folded content TOKEN starts with the folded
    // keyword, and "token starts with X" implies "folded content contains X" - so this LIKE is a
    // guaranteed SUPERSET of the rows the JS scorer keeps. `_`/`%` inside a keyword only widen the
    // match (still a superset), and rows with a NULL folded column (pre-backfill) are always kept, so
    // the prefilter can never drop a result - it just moves the heavy tokenization off the full table.
    const foldedKeywords = keywords
      .map((k) => foldGerman(String(k)).trim())
      .filter((k) => k.length > 0);
    if (foldedKeywords.length > 0) {
      const likeClauses = foldedKeywords.map((k) => like(schema.memories.contentFolded, `%${k}%`));
      conditions.push(or(...likeClauses, isNull(schema.memories.contentFolded)));
    }

    const memories = conditions.length > 0
      ? await this.db.select().from(schema.memories).where(and(...conditions)).all()
      : await this.db.select().from(schema.memories).all();

    const now = Date.now();
    return memories
      .map(m => ({
        entry: m,
        // Conversation-local memories win ties against global ones of equal relevance, and a mild
        // recency boost keeps recall fresh so newer learnings edge out equally-relevant stale ones
        // without overriding relevance (max +0.3 vs. keyword scores that typically range 1-3).
        score: scoreKeywordRelevance(m.content, keywords)
          + (conversationId !== undefined && m.conversationId === conversationId ? 0.15 : 0)
          + this.recencyBoost(m.createdAt, now),
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.entry.importance - a.entry.importance))
      .slice(0, limit)
      .map(s => s.entry);
  }

  /** Exponential recency weight in [0, 0.3]; ~30-day decay constant. NaN dates contribute nothing. */
  private recencyBoost(createdAt: string, now: number): number {
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) return 0;
    const ageDays = Math.max(0, (now - ts) / 86_400_000);
    return 0.3 * Math.exp(-ageDays / 30);
  }

  /**
   * Short-term memories are written on every run but are never read back by retrieval (which only
   * pulls long-term/semantic), so left unchecked they grow the table forever as pure dead weight.
   * Keep only the newest `keep` short-term rows and drop the rest. Best-effort; a failure here never
   * blocks a run.
   */
  async pruneShortTermMemories(keep = 200): Promise<number> {
    try {
      // keep <= 0 means "delete all short-term". This MUST be handled before the survivors query:
      // drizzle/libsql treats `.limit(0)` as "no limit" (returns every row), so the survivor set would
      // contain all rows and notInArray(...) would delete nothing - the exact bug behind a prune that
      // reported success but removed 0 rows.
      if (keep <= 0) {
        const result = await this.db.delete(schema.memories).where(eq(schema.memories.type, "short-term")).run();
        const removed = Number((result as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0);
        if (removed > 0) this.logger.debug("Pruned short-term memories", { removed, kept: 0 });
        return removed;
      }

      const survivors = await this.db
        .select({ id: schema.memories.id })
        .from(schema.memories)
        .where(eq(schema.memories.type, "short-term"))
        .orderBy(desc(schema.memories.id))
        .limit(keep)
        .all();
      const keepIds = survivors.map((r) => r.id);
      const result = keepIds.length > 0
        ? await this.db.delete(schema.memories)
            .where(and(eq(schema.memories.type, "short-term"), notInArray(schema.memories.id, keepIds)))
            .run()
        : await this.db.delete(schema.memories).where(eq(schema.memories.type, "short-term")).run();
      const removed = Number((result as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0);
      if (removed > 0) this.logger.debug("Pruned short-term memories", { removed, kept: keepIds.length });
      return removed;
    } catch (error) {
      this.logger.warn("Failed to prune short-term memories", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Collapses near-duplicate approved long-term memories that the write-time novelty check (>=0.9
   * identical) let through in a slightly reworded form. Greedily clusters by content-word overlap
   * (Jaccard over stopword-filtered tokens); within each cluster of 2+, the strongest entry is kept
   * (highest importance, then longest, then newest) and the redundant ones are deleted. This only
   * removes redundancy - no memory content is invented or merged - and never touches short-term,
   * semantic, pending, or settings rows. Best-effort; failures never throw.
   */
  async consolidateLongTermMemories(threshold = 0.7): Promise<{ groups: number; removed: number; kept: number }> {
    try {
      const entries = (await this.getMemories(undefined, "long-term", "approved"))
        .map((entry) => ({ entry, tokens: new Set(tokenizeText(entry.content, { removeStopwords: true, minLength: 3 })) }))
        .filter((item) => item.tokens.size > 0);

      const jaccard = (a: Set<string>, b: Set<string>): number => {
        let intersection = 0;
        for (const token of a) if (b.has(token)) intersection++;
        const union = a.size + b.size - intersection;
        return union === 0 ? 0 : intersection / union;
      };

      const used = new Set<number>();
      let groups = 0;
      let removed = 0;
      for (let i = 0; i < entries.length; i++) {
        const base = entries[i];
        if (!base || used.has(base.entry.id)) continue;
        const cluster = [base];
        for (let j = i + 1; j < entries.length; j++) {
          const other = entries[j];
          if (!other || used.has(other.entry.id)) continue;
          if (jaccard(base.tokens, other.tokens) >= threshold) cluster.push(other);
        }
        if (cluster.length < 2) continue;
        groups++;
        // Keep the strongest representative; delete the rest.
        cluster.sort((x, y) =>
          (y.entry.importance - x.entry.importance)
          || (y.entry.content.length - x.entry.content.length)
          || (y.entry.id - x.entry.id));
        for (const dup of cluster) used.add(dup.entry.id);
        for (const dup of cluster.slice(1)) {
          await this.deleteMemory(dup.entry.id);
          removed++;
        }
      }

      const kept = entries.length - removed;
      if (removed > 0) this.logger.info("Consolidated long-term memories", { groups, removed, kept });
      return { groups, removed, kept };
    } catch (error) {
      this.logger.warn("Failed to consolidate long-term memories", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { groups: 0, removed: 0, kept: 0 };
    }
  }

  // ============================================================
  // Embeddings
  // ============================================================
  async addEmbedding(data: Omit<EmbeddingInsert, "createdAt">): Promise<EmbeddingSelect> {
    const result = await this.db.insert(schema.embeddings).values({ ...data, createdAt: new Date().toISOString() }).returning().get();
    if (!result) throw new Error("Failed to add embedding");
    return result;
  }

  async getEmbeddings(): Promise<EmbeddingSelect[]> {
    return this.db.select().from(schema.embeddings).all();
  }

  // ============================================================
  // LLM Wiki Entries
  // ============================================================
  async listLlmWikiEntries(limit = 200): Promise<LlmWikiEntrySelect[]> {
    const capped = Math.max(1, Math.min(1000, Number(limit)));
    return this.db
      .select()
      .from(schema.llmWikiEntries)
      .orderBy(desc(schema.llmWikiEntries.updatedAt))
      .limit(capped)
      .all();
  }

  async getLlmWikiEntry(id: number): Promise<LlmWikiEntrySelect | undefined> {
    return this.db
      .select()
      .from(schema.llmWikiEntries)
      .where(eq(schema.llmWikiEntries.id, id))
      .get();
  }

  async upsertLlmWikiEntry(data: {
    sourcePath: string;
    title: string;
    content: string;
    contentHash: string;
    status?: string;
    metadata?: string | null;
  }): Promise<LlmWikiEntrySelect> {
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(schema.llmWikiEntries)
      .where(eq(schema.llmWikiEntries.sourcePath, data.sourcePath))
      .get();

    if (existing) {
      const updated = await this.db
        .update(schema.llmWikiEntries)
        .set({
          title: data.title,
          content: data.content,
          contentHash: data.contentHash,
          status: data.status ?? existing.status,
          metadata: data.metadata ?? existing.metadata,
          updatedAt: now,
        })
        .where(eq(schema.llmWikiEntries.id, existing.id))
        .returning()
        .get();
      if (!updated) throw new Error("Failed to update llm wiki entry");
      return updated;
    }

    const created = await this.db
      .insert(schema.llmWikiEntries)
      .values({
        sourcePath: data.sourcePath,
        title: data.title,
        content: data.content,
        contentHash: data.contentHash,
        status: data.status ?? "candidate",
        metadata: data.metadata ?? null,
        learnedAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    if (!created) throw new Error("Failed to create llm wiki entry");
    return created;
  }

  async deleteLlmWikiEntryBySourcePath(sourcePath: string): Promise<void> {
    await this.db
      .delete(schema.llmWikiEntries)
      .where(eq(schema.llmWikiEntries.sourcePath, sourcePath))
      .run();
  }

  async clearLogs(): Promise<void> {
    await this.db.delete(schema.logs).run();
  }

  async updateLlmWikiEntryStatus(id: number, status: "candidate" | "approved" | "rejected" | "error"): Promise<LlmWikiEntrySelect | undefined> {
    return this.db
      .update(schema.llmWikiEntries)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(schema.llmWikiEntries.id, id))
      .returning()
      .get();
  }

  // ============================================================
  // Settings
  // ============================================================
  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (existing) {
      await this.db.update(schema.settings).set({ value, updatedAt: now }).where(eq(schema.settings.key, key)).run();
    } else {
      await this.db.insert(schema.settings).values({ key, value, createdAt: now, updatedAt: now }).run();
    }
  }

  async getAllSettings(): Promise<SettingSelect[]> {
    return this.db.select().from(schema.settings).all();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
  }

  /**
   * Konsistenten Snapshot der DB in eine neue Datei schreiben (fuer Backups). `VACUUM INTO`
   * liest den aktuellen, konsistenten Zustand auch im WAL-Modus korrekt aus (anders als ein
   * rohes fs.copyFile der .db-Datei, das eine noch nicht in die Haupt-Datei geschriebene
   * WAL-Aenderung verpassen wuerde). destPath darf nicht existieren (SQLite-Vorgabe).
   */
  async vacuumInto(destPath: string): Promise<void> {
    const escaped = destPath.replace(/'/g, "''");
    await this.client.execute(`VACUUM INTO '${escaped}'`);
  }

  /**
   * Add skills to EVER_USED_SKILLS set (merge with existing)
   */
  async addEverUsedSkills(skillSlugs: string[]): Promise<void> {
    if (skillSlugs.length === 0) return;

    const existing = await this.getSetting("EVER_USED_SKILLS");
    let everUsed: string[] = [];
    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        everUsed = Array.isArray(parsed) ? parsed : [];
      } catch {
        everUsed = [];
      }
    }

    // Merge with new skills
    const merged = Array.from(new Set([...everUsed, ...skillSlugs])).sort();
    await this.setSetting("EVER_USED_SKILLS", JSON.stringify(merged));
  }

  /**
   * Get EVER_USED_SKILLS as array
   */
  async getEverUsedSkills(): Promise<string[]> {
    const existing = await this.getSetting("EVER_USED_SKILLS");
    if (!existing) return [];
    try {
      const parsed = JSON.parse(existing);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ============================================================
  // Logs
  // ============================================================
  async addLog(data: Omit<LogInsert, "timestamp">): Promise<void> {
    await this.db.insert(schema.logs).values({ ...data, timestamp: new Date().toISOString() }).run();
  }

  async getLogs(level?: string, limit = 100): Promise<schema.LogSelect[]> {
    if (level) {
      return this.db.select().from(schema.logs).where(eq(schema.logs.level, level)).orderBy(desc(schema.logs.timestamp)).limit(limit).all();
    }
    return this.db.select().from(schema.logs).orderBy(desc(schema.logs.timestamp)).limit(limit).all();
  }

  async cleanupLogs(maxEntries: number = 100): Promise<number> {
    const allLogs = await this.db.select({ id: schema.logs.id }).from(schema.logs).orderBy(desc(schema.logs.id)).all();

    if (allLogs.length <= maxEntries) {
      return 0;
    }

    const idsToDelete = allLogs.slice(maxEntries).map(log => log.id);
    if (idsToDelete.length === 0) return 0;

    for (const id of idsToDelete) {
      await this.db.delete(schema.logs).where(eq(schema.logs.id, id)).run();
    }

    return idsToDelete.length;
  }

  // ============================================================
  // Cron Jobs
  // ============================================================
  async createCronJob(
    data: Omit<CronJobInsert, "id" | "createdAt" | "updatedAt" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastError" | "lastResult">
  ): Promise<CronJobSelect> {
    const now = new Date().toISOString();
    // A one-shot job (runAt set) fires at that exact time; otherwise the recurring schedule drives it.
    const nextRunAt = data.runAt ? data.runAt : computeNextRun(data.schedule, new Date()).toISOString();
    const result = await this.db
      .insert(schema.cronJobs)
      .values({
        ...data,
        enabled: data.enabled ?? 1,
        createdAt: now,
        updatedAt: now,
        nextRunAt,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastResult: null,
      })
      .returning()
      .get();
    if (!result) throw new Error("Failed to create cron job");
    return result;
  }

  async getCronJob(id: number): Promise<CronJobSelect | undefined> {
    return this.db.select().from(schema.cronJobs).where(eq(schema.cronJobs.id, id)).get();
  }

  async listCronJobs(enabledOnly = false): Promise<CronJobSelect[]> {
    if (enabledOnly) {
      return this.db
        .select()
        .from(schema.cronJobs)
        .where(eq(schema.cronJobs.enabled, 1))
        .orderBy(desc(schema.cronJobs.createdAt))
        .all();
    }
    return this.db.select().from(schema.cronJobs).orderBy(desc(schema.cronJobs.createdAt)).all();
  }

  async updateCronJob(
    id: number,
    data: Partial<Omit<CronJobInsert, "id" | "createdAt">>
  ): Promise<CronJobSelect | undefined> {
    const patch: Partial<Omit<CronJobInsert, "id" | "createdAt">> = {
      ...data,
      updatedAt: new Date().toISOString(),
    };

    if (data.schedule) {
      patch.nextRunAt = computeNextRun(data.schedule, new Date()).toISOString();
    }

    // A patched one-shot time wins over a schedule-derived nextRunAt.
    if (data.runAt) {
      patch.nextRunAt = data.runAt;
    }

    if (data.enabled === 0) {
      patch.nextRunAt = null;
    }

    if (data.enabled === 1 && !patch.nextRunAt) {
      const existing = await this.getCronJob(id);
      if (existing) {
        patch.nextRunAt = computeNextRun(data.schedule ?? existing.schedule, new Date()).toISOString();
      }
    }

    return this.db.update(schema.cronJobs).set(patch).where(eq(schema.cronJobs.id, id)).returning().get();
  }

  async setCronJobRunResult(
    id: number,
    data: { status: "success" | "failed"; error?: string; result?: string; nextRunAt?: string }
  ): Promise<void> {
    const existing = await this.getCronJob(id);
    if (!existing) return;

    const nextRunAt = data.nextRunAt ?? (existing.enabled ? computeNextRun(existing.schedule, new Date()).toISOString() : null);
    await this.db
      .update(schema.cronJobs)
      .set({
        lastRunAt: new Date().toISOString(),
        lastStatus: data.status,
        lastError: data.error ?? null,
        lastResult: data.result ?? null,
        nextRunAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.cronJobs.id, id))
      .run();
  }

  async deleteCronJob(id: number): Promise<void> {
    await this.db.delete(schema.cronJobs).where(eq(schema.cronJobs.id, id)).run();
  }

  // ============================================================
  // Dynamic Tools
  // ============================================================
  async createDynamicTool(data: Omit<DynamicToolInsert, "id" | "createdAt" | "updatedAt">): Promise<DynamicToolSelect> {
    const now = new Date().toISOString();
    const result = await this.db
      .insert(schema.dynamicTools)
      .values({ ...data, createdAt: now, updatedAt: now })
      .returning()
      .get();
    if (!result) throw new Error("Failed to create dynamic tool");
    return result;
  }

  async getDynamicToolByName(name: string): Promise<DynamicToolSelect | undefined> {
    return this.db.select().from(schema.dynamicTools).where(eq(schema.dynamicTools.name, name)).get();
  }

  async listDynamicTools(createdBy?: string): Promise<DynamicToolSelect[]> {
    if (createdBy !== undefined) {
      return this.db
        .select()
        .from(schema.dynamicTools)
        .where(eq(schema.dynamicTools.createdBy, createdBy))
        .orderBy(desc(schema.dynamicTools.createdAt))
        .all();
    }
    return this.db.select().from(schema.dynamicTools).orderBy(desc(schema.dynamicTools.createdAt)).all();
  }

  async deleteDynamicTool(name: string): Promise<void> {
    await this.db.delete(schema.dynamicTools).where(eq(schema.dynamicTools.name, name)).run();
  }

  async deleteDynamicToolsByOwner(createdBy: string): Promise<number> {
    const owned = await this.listDynamicTools(createdBy);
    for (const tool of owned) {
      await this.db.delete(schema.dynamicTools).where(eq(schema.dynamicTools.id, tool.id)).run();
    }
    return owned.length;
  }

  // ============================================================
  // Conversation Archival & Cleanup
  // ============================================================
  async getMessageCount(conversationId: number): Promise<number> {
    const result = await this.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
    return result.length;
  }

  async archiveConversation(conversationId: number, reason?: string): Promise<ArchivedConversationSelect> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} not found`);

    const messageCount = await this.getMessageCount(conversationId);
    const now = new Date().toISOString();

    const archived = await this.db
      .insert(schema.archivedConversations)
      .values({
        originalConversationId: conversationId,
        name: conversation.name,
        projectId: conversation.projectId,
        messageCount,
        archivedAt: now,
        metadata: reason ? JSON.stringify({ reason }) : null,
      })
      .returning()
      .get();

    if (!archived) throw new Error("Failed to archive conversation");
    return archived;
  }

  async deleteOldMessages(conversationId: number, keepLatestCount: number): Promise<number> {
    const allMessages = await this.getMessages(conversationId);
    const toDelete = Math.max(0, allMessages.length - keepLatestCount);

    if (toDelete === 0) return 0;

    const idsToDelete = allMessages.slice(0, toDelete).map(m => m.id);
    for (const id of idsToDelete) {
      await this.db.delete(schema.messages).where(eq(schema.messages.id, id)).run();
    }

    return idsToDelete.length;
  }

  async cleanupConversations(keepLatestPerConversation: number): Promise<{ conversationsProcessed: number; messagesDeleted: number }> {
    const conversations = await this.listConversations();
    let messagesDeleted = 0;

    for (const conversation of conversations) {
      const deleted = await this.deleteOldMessages(conversation.id, keepLatestPerConversation);
      messagesDeleted += deleted;
    }

    return { conversationsProcessed: conversations.length, messagesDeleted };
  }

  async listArchivedConversations(limit = 100): Promise<ArchivedConversationSelect[]> {
    const capped = Math.max(1, Math.min(1000, Number(limit)));
    return this.db
      .select()
      .from(schema.archivedConversations)
      .orderBy(desc(schema.archivedConversations.archivedAt))
      .limit(capped)
      .all();
  }

  async deleteArchivedConversation(id: number): Promise<void> {
    await this.db.delete(schema.archivedConversations).where(eq(schema.archivedConversations.id, id)).run();
  }

  // ============================================================
  // Crypto Addresses
  // ============================================================
  async addCryptoAddress(data: Omit<schema.CryptoAddressInsert, "createdAt" | "updatedAt">): Promise<schema.CryptoAddressSelect | undefined> {
    const now = new Date().toISOString();
    try {
      const result = await this.db
        .insert(schema.cryptoAddresses)
        .values({ ...data, createdAt: now, updatedAt: now })
        .returning()
        .get();
      return result;
    } catch (error) {
      // Return undefined if insertion fails (e.g., unique constraint)
      this.logger.warn("Failed to add crypto address", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async getCryptoAddresses(currency?: string): Promise<schema.CryptoAddressSelect[]> {
    if (currency) {
      return this.db.select().from(schema.cryptoAddresses).where(eq(schema.cryptoAddresses.currency, currency)).all();
    }
    return this.db.select().from(schema.cryptoAddresses).all();
  }

  async getCryptoAddressById(id: number): Promise<schema.CryptoAddressSelect | undefined> {
    return this.db.select().from(schema.cryptoAddresses).where(eq(schema.cryptoAddresses.id, id)).get();
  }

  get raw(): LibSQLDatabase<typeof schema> {
    return this.db;
  }
}

let instance: DatabaseService | undefined;

export async function getDatabase(dbPath?: string): Promise<DatabaseService> {
  if (!instance) {
    instance = new DatabaseService(dbPath ?? process.env["DATABASE_PATH"] ?? "./storage/ducki.db");
    await instance.initialize();
  }
  return instance;
}

/**
 * Schliesst die gecachte DB-Verbindung und verwirft die Singleton-Instanz, damit der naechste
 * getDatabase()-Aufruf die (z.B. per Restore ausgetauschte) Datei frisch oeffnet. Nur fuer
 * kontrollierte Restore-Flows gedacht — normale Server-Requests sollen weiter getDatabase()
 * benutzen, ohne sich um den Instanz-Lifecycle zu kuemmern.
 */
export function resetDatabaseInstance(): void {
  instance?.close();
  instance = undefined;
}

/**
 * Konsistenten Snapshot einer beliebigen SQLite-Datei erstellen (z.B. eine Plugin-DB fuer
 * Backups), ueber eine kurzlebige, eigene Verbindung — beruehrt NICHT den gecachten
 * Verbindungspool aus plugin-storage.ts. destPath darf nicht existieren (SQLite-Vorgabe).
 */
export async function vacuumSqliteFile(srcPath: string, destPath: string): Promise<void> {
  const client = createClient({ url: `file:${srcPath}` });
  try {
    const escaped = destPath.replace(/'/g, "''");
    await client.execute(`VACUUM INTO '${escaped}'`);
  } finally {
    client.close();
  }
}
