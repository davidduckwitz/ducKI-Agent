import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, desc, and, lt } from "drizzle-orm";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { getRootLogger } from "@ducki/logger";
import * as schema from "./schema.js";
import { computeNextRun } from "./cron.js";
export * from "./schema.js";
export * from "./cron.js";
export class DatabaseService {
    dbPath;
    db;
    client;
    logger;
    constructor(dbPath = "./storage/ducki.db") {
        this.dbPath = dbPath;
        this.logger = getRootLogger().child("Database");
    }
    async initialize() {
        const dir = dirname(this.dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.client = createClient({ url: `file:${this.dbPath}` });
        this.db = drizzle(this.client, { schema });
        await this.runMigrations();
        this.logger.info("Database initialized", { path: this.dbPath });
    }
    async runMigrations() {
        const tables = [
            `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, folder TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project_id INTEGER REFERENCES projects(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, tool_call_id TEXT, tool_result TEXT, created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', subtasks TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config_schema TEXT, last_used TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES conversations(id), type TEXT NOT NULL DEFAULT 'short-term', content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, context TEXT, timestamp TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS tool_executions (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, input TEXT, output TEXT, success INTEGER NOT NULL, execution_time REAL, conversation_id INTEGER REFERENCES conversations(id), created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS cron_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, schedule TEXT NOT NULL, target_type TEXT NOT NULL, target_ref TEXT, payload TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at TEXT, last_status TEXT, last_error TEXT, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS llm_wiki_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', metadata TEXT, learned_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
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
    }
    // ============================================================
    // Conversations
    // ============================================================
    async createConversation(data) {
        const now = new Date().toISOString();
        const result = await this.db.insert(schema.conversations).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
        if (!result)
            throw new Error("Failed to create conversation");
        return result;
    }
    async getConversation(id) {
        return this.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
    }
    async listConversations(projectId) {
        if (projectId !== undefined) {
            return this.db.select().from(schema.conversations).where(eq(schema.conversations.projectId, projectId)).orderBy(desc(schema.conversations.createdAt)).all();
        }
        return this.db.select().from(schema.conversations).orderBy(desc(schema.conversations.createdAt)).all();
    }
    async listConversationsPage(args) {
        const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 30)));
        const projectId = args?.projectId;
        const beforeId = args?.beforeId;
        const conditions = [];
        if (projectId !== undefined)
            conditions.push(eq(schema.conversations.projectId, projectId));
        if (beforeId !== undefined)
            conditions.push(lt(schema.conversations.id, beforeId));
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
    async deleteConversation(id) {
        await this.db.delete(schema.messages).where(eq(schema.messages.conversationId, id)).run();
        await this.db.delete(schema.memories).where(eq(schema.memories.conversationId, id)).run();
        await this.db.delete(schema.toolExecutions).where(eq(schema.toolExecutions.conversationId, id)).run();
        await this.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();
    }
    // ============================================================
    // Messages
    // ============================================================
    async addMessage(data) {
        const result = await this.db.insert(schema.messages).values({ ...data, createdAt: new Date().toISOString() }).returning().get();
        if (!result)
            throw new Error("Failed to add message");
        return result;
    }
    async getMessages(conversationId) {
        return this.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.id).all();
    }
    async getMessagesPage(args) {
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
    // ============================================================
    // Projects
    // ============================================================
    async createProject(data) {
        const now = new Date().toISOString();
        const result = await this.db.insert(schema.projects).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
        if (!result)
            throw new Error("Failed to create project");
        return result;
    }
    async getProject(id) {
        return this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    }
    async listProjects() {
        return this.db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).all();
    }
    async updateProject(id, data) {
        return this.db.update(schema.projects).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.projects.id, id)).returning().get();
    }
    async deleteProject(id) {
        const projectConversations = await this.db
            .select({ id: schema.conversations.id })
            .from(schema.conversations)
            .where(eq(schema.conversations.projectId, id))
            .all();
        for (const conversation of projectConversations) {
            await this.deleteConversation(conversation.id);
        }
        await this.db.delete(schema.tasks).where(eq(schema.tasks.projectId, id)).run();
        await this.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    }
    // ============================================================
    // Tasks
    // ============================================================
    async createTask(data) {
        const now = new Date().toISOString();
        const result = await this.db.insert(schema.tasks).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
        if (!result)
            throw new Error("Failed to create task");
        return result;
    }
    async getTask(id) {
        return this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    }
    async listTasks(projectId) {
        if (projectId !== undefined) {
            return this.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(desc(schema.tasks.createdAt)).all();
        }
        return this.db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).all();
    }
    async updateTask(id, data) {
        return this.db.update(schema.tasks).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, id)).returning().get();
    }
    async deleteTask(id) {
        await this.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
    }
    // ============================================================
    // Memories
    // ============================================================
    async addMemory(data) {
        const result = await this.db.insert(schema.memories).values({ ...data, createdAt: new Date().toISOString() }).returning().get();
        if (!result)
            throw new Error("Failed to add memory");
        return result;
    }
    async getMemories(conversationId, type, status) {
        const conditions = [];
        if (conversationId !== undefined)
            conditions.push(eq(schema.memories.conversationId, conversationId));
        if (type !== undefined)
            conditions.push(eq(schema.memories.type, type));
        if (status !== undefined)
            conditions.push(eq(schema.memories.status, status));
        if (conditions.length === 0)
            return this.db.select().from(schema.memories).orderBy(desc(schema.memories.importance)).all();
        return this.db.select().from(schema.memories).where(and(...conditions)).orderBy(desc(schema.memories.importance)).all();
    }
    async updateMemoryStatus(id, status) {
        return this.db.update(schema.memories).set({ status }).where(eq(schema.memories.id, id)).returning().get();
    }
    async deleteMemory(id) {
        await this.db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
    }
    // ============================================================
    // Embeddings
    // ============================================================
    async addEmbedding(data) {
        const result = await this.db.insert(schema.embeddings).values({ ...data, createdAt: new Date().toISOString() }).returning().get();
        if (!result)
            throw new Error("Failed to add embedding");
        return result;
    }
    async getEmbeddings() {
        return this.db.select().from(schema.embeddings).all();
    }
    // ============================================================
    // LLM Wiki Entries
    // ============================================================
    async listLlmWikiEntries(limit = 200) {
        const capped = Math.max(1, Math.min(1000, Number(limit)));
        return this.db
            .select()
            .from(schema.llmWikiEntries)
            .orderBy(desc(schema.llmWikiEntries.updatedAt))
            .limit(capped)
            .all();
    }
    async getLlmWikiEntry(id) {
        return this.db
            .select()
            .from(schema.llmWikiEntries)
            .where(eq(schema.llmWikiEntries.id, id))
            .get();
    }
    async upsertLlmWikiEntry(data) {
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
            if (!updated)
                throw new Error("Failed to update llm wiki entry");
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
        if (!created)
            throw new Error("Failed to create llm wiki entry");
        return created;
    }
    async deleteLlmWikiEntryBySourcePath(sourcePath) {
        await this.db
            .delete(schema.llmWikiEntries)
            .where(eq(schema.llmWikiEntries.sourcePath, sourcePath))
            .run();
    }
    async deleteLlmWikiEntriesBySourcePrefix(prefix) {
        const all = await this.listLlmWikiEntries(5000);
        const matches = all.filter((entry) => entry.sourcePath.startsWith(prefix));
        for (const entry of matches) {
            await this.db
                .delete(schema.llmWikiEntries)
                .where(eq(schema.llmWikiEntries.id, entry.id))
                .run();
        }
        return matches.length;
    }
    async updateLlmWikiEntryStatus(id, status) {
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
    async getSetting(key) {
        const row = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
        return row?.value;
    }
    async setSetting(key, value) {
        const now = new Date().toISOString();
        const existing = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
        if (existing) {
            await this.db.update(schema.settings).set({ value, updatedAt: now }).where(eq(schema.settings.key, key)).run();
        }
        else {
            await this.db.insert(schema.settings).values({ key, value, createdAt: now, updatedAt: now }).run();
        }
    }
    async getAllSettings() {
        return this.db.select().from(schema.settings).all();
    }
    async deleteSetting(key) {
        await this.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    }
    // ============================================================
    // Logs
    // ============================================================
    async addLog(data) {
        await this.db.insert(schema.logs).values({ ...data, timestamp: new Date().toISOString() }).run();
    }
    async getLogs(level, limit = 100) {
        if (level) {
            return this.db.select().from(schema.logs).where(eq(schema.logs.level, level)).orderBy(desc(schema.logs.timestamp)).limit(limit).all();
        }
        return this.db.select().from(schema.logs).orderBy(desc(schema.logs.timestamp)).limit(limit).all();
    }
    // ============================================================
    // Cron Jobs
    // ============================================================
    async createCronJob(data) {
        const now = new Date().toISOString();
        const nextRunAt = computeNextRun(data.schedule, new Date()).toISOString();
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
        if (!result)
            throw new Error("Failed to create cron job");
        return result;
    }
    async getCronJob(id) {
        return this.db.select().from(schema.cronJobs).where(eq(schema.cronJobs.id, id)).get();
    }
    async listCronJobs(enabledOnly = false) {
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
    async updateCronJob(id, data) {
        const patch = {
            ...data,
            updatedAt: new Date().toISOString(),
        };
        if (data.schedule) {
            patch.nextRunAt = computeNextRun(data.schedule, new Date()).toISOString();
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
    async setCronJobRunResult(id, data) {
        const existing = await this.getCronJob(id);
        if (!existing)
            return;
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
    async deleteCronJob(id) {
        await this.db.delete(schema.cronJobs).where(eq(schema.cronJobs.id, id)).run();
    }
    get raw() {
        return this.db;
    }
}
let instance;
export async function getDatabase(dbPath) {
    if (!instance) {
        instance = new DatabaseService(dbPath ?? process.env["DATABASE_PATH"] ?? "./storage/ducki.db");
        await instance.initialize();
    }
    return instance;
}
//# sourceMappingURL=index.js.map