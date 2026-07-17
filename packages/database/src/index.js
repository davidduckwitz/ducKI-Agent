import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { getRootLogger } from "@ducki/logger";
import * as schema from "./schema.js";
export * from "./schema.js";
export class DatabaseService {
    dbPath;
    db;
    sqlite;
    logger;
    constructor(dbPath = "./storage/ducki.db") {
        this.dbPath = dbPath;
        this.logger = getRootLogger().child("Database");
    }
    initialize() {
        const dir = dirname(this.dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.sqlite = new Database(this.dbPath);
        this.sqlite.pragma("journal_mode = WAL");
        this.sqlite.pragma("foreign_keys = ON");
        this.db = drizzle(this.sqlite, { schema });
        this.runMigrations();
        this.logger.info("Database initialized", { path: this.dbPath });
    }
    runMigrations() {
        this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        folder TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_result TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        subtasks TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_schema TEXT,
        last_used TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER REFERENCES conversations(id),
        type TEXT NOT NULL DEFAULT 'short-term',
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        input TEXT,
        output TEXT,
        success INTEGER NOT NULL,
        execution_time REAL,
        conversation_id INTEGER REFERENCES conversations(id),
        created_at TEXT NOT NULL
      );
    `);
    }
    // ============================================================
    // Conversations
    // ============================================================
    createConversation(data) {
        const now = new Date().toISOString();
        const result = this.db
            .insert(schema.conversations)
            .values({ ...data, createdAt: now, updatedAt: now })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to create conversation");
        return result;
    }
    getConversation(id) {
        return this.db
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, id))
            .get();
    }
    listConversations(projectId) {
        if (projectId !== undefined) {
            return this.db
                .select()
                .from(schema.conversations)
                .where(eq(schema.conversations.projectId, projectId))
                .orderBy(desc(schema.conversations.createdAt))
                .all();
        }
        return this.db
            .select()
            .from(schema.conversations)
            .orderBy(desc(schema.conversations.createdAt))
            .all();
    }
    deleteConversation(id) {
        this.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();
    }
    // ============================================================
    // Messages
    // ============================================================
    addMessage(data) {
        const result = this.db
            .insert(schema.messages)
            .values({ ...data, createdAt: new Date().toISOString() })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to add message");
        return result;
    }
    getMessages(conversationId) {
        return this.db
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.conversationId, conversationId))
            .orderBy(schema.messages.id)
            .all();
    }
    // ============================================================
    // Projects
    // ============================================================
    createProject(data) {
        const now = new Date().toISOString();
        const result = this.db
            .insert(schema.projects)
            .values({ ...data, createdAt: now, updatedAt: now })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to create project");
        return result;
    }
    getProject(id) {
        return this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    }
    listProjects() {
        return this.db
            .select()
            .from(schema.projects)
            .orderBy(desc(schema.projects.createdAt))
            .all();
    }
    updateProject(id, data) {
        const result = this.db
            .update(schema.projects)
            .set({ ...data, updatedAt: new Date().toISOString() })
            .where(eq(schema.projects.id, id))
            .returning()
            .get();
        return result;
    }
    deleteProject(id) {
        this.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    }
    // ============================================================
    // Tasks
    // ============================================================
    createTask(data) {
        const now = new Date().toISOString();
        const result = this.db
            .insert(schema.tasks)
            .values({ ...data, createdAt: now, updatedAt: now })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to create task");
        return result;
    }
    getTask(id) {
        return this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    }
    listTasks(projectId) {
        if (projectId !== undefined) {
            return this.db
                .select()
                .from(schema.tasks)
                .where(eq(schema.tasks.projectId, projectId))
                .orderBy(desc(schema.tasks.createdAt))
                .all();
        }
        return this.db
            .select()
            .from(schema.tasks)
            .orderBy(desc(schema.tasks.createdAt))
            .all();
    }
    updateTask(id, data) {
        return this.db
            .update(schema.tasks)
            .set({ ...data, updatedAt: new Date().toISOString() })
            .where(eq(schema.tasks.id, id))
            .returning()
            .get();
    }
    deleteTask(id) {
        this.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
    }
    // ============================================================
    // Memories
    // ============================================================
    addMemory(data) {
        const result = this.db
            .insert(schema.memories)
            .values({ ...data, createdAt: new Date().toISOString() })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to add memory");
        return result;
    }
    getMemories(conversationId, type) {
        const conditions = [];
        if (conversationId !== undefined) {
            conditions.push(eq(schema.memories.conversationId, conversationId));
        }
        if (type !== undefined) {
            conditions.push(eq(schema.memories.type, type));
        }
        if (conditions.length === 0) {
            return this.db
                .select()
                .from(schema.memories)
                .orderBy(desc(schema.memories.importance))
                .all();
        }
        return this.db
            .select()
            .from(schema.memories)
            .where(and(...conditions))
            .orderBy(desc(schema.memories.importance))
            .all();
    }
    // ============================================================
    // Embeddings
    // ============================================================
    addEmbedding(data) {
        const result = this.db
            .insert(schema.embeddings)
            .values({ ...data, createdAt: new Date().toISOString() })
            .returning()
            .get();
        if (!result)
            throw new Error("Failed to add embedding");
        return result;
    }
    getEmbeddings() {
        return this.db.select().from(schema.embeddings).all();
    }
    // ============================================================
    // Settings
    // ============================================================
    getSetting(key) {
        const row = this.db
            .select()
            .from(schema.settings)
            .where(eq(schema.settings.key, key))
            .get();
        return row?.value;
    }
    setSetting(key, value) {
        const now = new Date().toISOString();
        const existing = this.db
            .select()
            .from(schema.settings)
            .where(eq(schema.settings.key, key))
            .get();
        if (existing) {
            this.db
                .update(schema.settings)
                .set({ value, updatedAt: now })
                .where(eq(schema.settings.key, key))
                .run();
        }
        else {
            this.db
                .insert(schema.settings)
                .values({ key, value, createdAt: now, updatedAt: now })
                .run();
        }
    }
    getAllSettings() {
        return this.db.select().from(schema.settings).all();
    }
    // ============================================================
    // Logs
    // ============================================================
    addLog(data) {
        this.db
            .insert(schema.logs)
            .values({ ...data, timestamp: new Date().toISOString() })
            .run();
    }
    getLogs(level, limit = 100) {
        if (level) {
            return this.db
                .select()
                .from(schema.logs)
                .where(eq(schema.logs.level, level))
                .orderBy(desc(schema.logs.timestamp))
                .limit(limit)
                .all();
        }
        return this.db
            .select()
            .from(schema.logs)
            .orderBy(desc(schema.logs.timestamp))
            .limit(limit)
            .all();
    }
    // ============================================================
    // Raw access
    // ============================================================
    get raw() {
        return this.db;
    }
    close() {
        this.sqlite.close();
        this.logger.info("Database connection closed");
    }
}
let instance;
export function getDatabase(dbPath) {
    if (!instance) {
        instance = new DatabaseService(dbPath ?? process.env["DATABASE_PATH"] ?? "./storage/ducki.db");
        instance.initialize();
    }
    return instance;
}
//# sourceMappingURL=index.js.map