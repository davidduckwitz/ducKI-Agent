import { integer, sqliteTable, text, real } from "drizzle-orm/sqlite-core";

// ============================================================
// Conversations
// ============================================================
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  projectId: integer("project_id").references(() => projects.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Messages
// ============================================================
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  role: text("role").notNull(), // user, assistant, system, tool
  content: text("content").notNull(),
  metadata: text("metadata"),
  toolCallId: text("tool_call_id"),
  toolResult: text("tool_result"),
  createdAt: text("created_at").notNull(),
});

// ============================================================
// Projects
// ============================================================
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  folder: text("folder"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Tasks
// ============================================================
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed
  priority: text("priority").notNull().default("medium"), // low, medium, high, critical
  subtasks: text("subtasks"), // JSON
  result: text("result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Tools
// ============================================================
export const tools = sqliteTable("tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  enabled: integer("enabled").notNull().default(1),
  configSchema: text("config_schema"), // JSON
  lastUsed: text("last_used"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Memories
// ============================================================
export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  type: text("type").notNull().default("short-term"), // short-term, long-term, episodic, semantic
  content: text("content").notNull(),
  importance: integer("importance").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

// ============================================================
// Embeddings
// ============================================================
export const embeddings = sqliteTable("embeddings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  embedding: text("embedding").notNull(), // JSON array of floats
  metadata: text("metadata"), // JSON
  createdAt: text("created_at").notNull(),
});

// ============================================================
// Settings
// ============================================================
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Logs
// ============================================================
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  level: text("level").notNull(), // error, warn, info, debug
  message: text("message").notNull(),
  context: text("context"), // JSON
  timestamp: text("timestamp").notNull(),
});

// ============================================================
// Tool Executions (for tracking / analytics)
// ============================================================
export const toolExecutions = sqliteTable("tool_executions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  toolName: text("tool_name").notNull(),
  input: text("input"), // JSON
  output: text("output"), // JSON
  success: integer("success").notNull(),
  executionTime: real("execution_time"),
  conversationId: integer("conversation_id").references(() => conversations.id),
  createdAt: text("created_at").notNull(),
});

// ============================================================
// Cron Jobs
// ============================================================
export const cronJobs = sqliteTable("cron_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  schedule: text("schedule").notNull(),
  targetType: text("target_type").notNull(), // task, prompt, tool, skill
  targetRef: text("target_ref"),
  payload: text("payload"), // JSON
  enabled: integer("enabled").notNull().default(1),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  lastStatus: text("last_status"), // success, failed
  lastError: text("last_error"),
  lastResult: text("last_result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// LLM Wiki Entries
// ============================================================
export const llmWikiEntries = sqliteTable("llm_wiki_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourcePath: text("source_path").notNull().unique(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  status: text("status").notNull().default("candidate"), // candidate, approved, rejected, error
  metadata: text("metadata"), // JSON
  learnedAt: text("learned_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ConversationInsert = typeof conversations.$inferInsert;
export type ConversationSelect = typeof conversations.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
export type MessageSelect = typeof messages.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type ProjectSelect = typeof projects.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type TaskSelect = typeof tasks.$inferSelect;
export type ToolInsert = typeof tools.$inferInsert;
export type ToolSelect = typeof tools.$inferSelect;
export type MemoryInsert = typeof memories.$inferInsert;
export type MemorySelect = typeof memories.$inferSelect;
export type EmbeddingInsert = typeof embeddings.$inferInsert;
export type EmbeddingSelect = typeof embeddings.$inferSelect;
export type SettingInsert = typeof settings.$inferInsert;
export type SettingSelect = typeof settings.$inferSelect;
export type LogInsert = typeof logs.$inferInsert;
export type LogSelect = typeof logs.$inferSelect;
export type CronJobInsert = typeof cronJobs.$inferInsert;
export type CronJobSelect = typeof cronJobs.$inferSelect;
export type LlmWikiEntryInsert = typeof llmWikiEntries.$inferInsert;
export type LlmWikiEntrySelect = typeof llmWikiEntries.$inferSelect;
