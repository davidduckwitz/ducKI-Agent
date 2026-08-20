import { integer, sqliteTable, text, real, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// ============================================================
// Conversations
// ============================================================
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  projectId: integer("project_id").references(() => projects.id),
  /** Plugin slug (matches plugins/<slug>/) if this conversation was created by the
   *  agent-authored plugin wizard. Lets the chat continuation path re-derive the same
   *  [CODING_CONTEXT] marker CodingWorkspace uses, so follow-up messages get a proper
   *  coding iteration budget and the filesystem tool scoped to the plugin's own folder. */
  pluginContext: text("plugin_context"),
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
  parentTaskId: integer("parent_task_id").references((): AnySQLiteColumn => tasks.id),
  createdBy: text("created_by"), // ownership tag, e.g. "task_split:<id>", "workflow:<id>", "tool:<name>:<invocationId>"
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
// Dynamic Tools (runtime-registered tools, sandboxed script execution)
// ============================================================
export const dynamicTools = sqliteTable("dynamic_tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  parameters: text("parameters").notNull(), // JSON schema-like object
  script: text("script").notNull(), // vm.Script source
  enabled: integer("enabled").notNull().default(1),
  createdBy: text("created_by"), // ownership tag
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
  // German-folded copy of `content` (ä→ae, whole string lowercased via foldGerman) used ONLY as a
  // SQL prefilter for keyword retrieval. Because the keyword scorer matches a term iff a folded
  // content token starts with the folded term, `content_folded LIKE '%folded_term%'` is a guaranteed
  // superset of what the scorer would keep - so it narrows rows without changing ranking results.
  contentFolded: text("content_folded"),
  importance: integer("importance").notNull().default(1),
  status: text("status").notNull().default("approved"), // approved, pending
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
  targetType: text("target_type").notNull(), // task, prompt, tool, skill, workflow, coding
  targetRef: text("target_ref"),
  payload: text("payload"), // JSON
  enabled: integer("enabled").notNull().default(1),
  // One-shot execution: when set, the job fires once at runAt (ISO) and is disabled afterwards.
  // Used by point-in-time triggers such as calendar appointments.
  runAt: text("run_at"),
  runOnce: integer("run_once").notNull().default(0),
  conversationId: integer("conversation_id").references(() => conversations.id),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  lastStatus: text("last_status"), // success, failed
  lastError: text("last_error"),
  lastResult: text("last_result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Archived Conversations
// ============================================================
export const archivedConversations = sqliteTable("archived_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  originalConversationId: integer("original_conversation_id").notNull(),
  name: text("name").notNull(),
  projectId: integer("project_id"),
  messageCount: integer("message_count").notNull(),
  archivedAt: text("archived_at").notNull(),
  metadata: text("metadata"), // JSON - retention policy, reason, etc.
});

// ============================================================
// Plans (for plan mode: saved structured plans for projects)
// ============================================================
export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  projectId: integer("project_id").references(() => projects.id),
  goal: text("goal").notNull(),
  title: text("title"),
  complexity: integer("complexity"), // 1-5
  steps: text("steps").notNull(), // JSON array of step objects
  tools: text("tools"), // JSON array of tool names needed
  markdown: text("markdown"), // Rendered markdown version
  status: text("status").notNull().default("draft"), // draft, active, completed, archived
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

// ============================================================
// Crypto Payment System
// ============================================================
export const cryptoAddresses = sqliteTable("crypto_addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currency: text("currency").notNull(), // BTC, ETH, XRP
  address: text("address").notNull().unique(),
  publicKey: text("public_key"),
  encryptedPrivateKey: text("encrypted_private_key"), // AES-256-GCM encrypted
  label: text("label"),
  balance: text("balance").default("0"), // BigInt as string
  balanceUsd: real("balance_usd"),
  isMaster: integer("is_master").default(0),
  derivationPath: text("derivation_path"), // BIP44 path
  lastBalanceSync: text("last_balance_sync"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const cryptoTransactions = sqliteTable("crypto_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  addressId: integer("address_id").references(() => cryptoAddresses.id),
  currency: text("currency").notNull(),
  hash: text("hash").unique(),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  amount: text("amount").notNull(), // BigInt as string
  fee: text("fee"),
  status: text("status").default("pending"), // pending, confirmed, failed
  confirmations: integer("confirmations").default(0),
  timestamp: integer("timestamp"),
  blockNumber: integer("block_number"),
  note: text("note"),
  syncedAt: text("synced_at"),
  createdAt: text("created_at").notNull(),
});

export const cryptoApiCredentials = sqliteTable("crypto_api_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(), // bitref, etherscan, xrpscan
  encryptedApiKey: text("encrypted_api_key").notNull(), // AES-256-GCM encrypted
  encryptedApiSecret: text("encrypted_api_secret"), // Optional, encrypted
  isActive: integer("is_active").default(1),
  rateLimitPerMin: integer("rate_limit_per_min"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const cryptoPortfolioSettings = sqliteTable("crypto_portfolio_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currency: text("currency").default("USD"), // USD, EUR, etc.
  refreshIntervalSeconds: integer("refresh_interval_seconds").default(300),
  autoSyncEnabled: integer("auto_sync_enabled").default(1),
  notificationsEnabled: integer("notifications_enabled").default(0),
  exportFormat: text("export_format").default("json"), // json, csv
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Portfolio History for charting
export const cryptoPortfolioHistory = sqliteTable("crypto_portfolio_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  totalValueUsd: real("total_value_usd").notNull(),
  btcBalance: text("btc_balance"), // BigInt as string
  btcValueUsd: real("btc_value_usd"),
  ethBalance: text("eth_balance"),
  ethValueUsd: real("eth_value_usd"),
  xrpBalance: text("xrp_balance"),
  xrpValueUsd: real("xrp_value_usd"),
  timestamp: integer("timestamp").notNull(),
  createdAt: text("created_at").notNull(),
});

// Price snapshots for charting
export const cryptoPriceHistory = sqliteTable("crypto_price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currency: text("currency").notNull(), // BTC, ETH, XRP
  price: real("price").notNull(),
  priceUsd: real("price_usd").notNull(),
  change24h: real("change_24h"),
  marketCap: real("market_cap"),
  volume24h: real("volume_24h"),
  timestamp: integer("timestamp").notNull(),
  createdAt: text("created_at").notNull(),
});

// Price & Balance Alerts
export const cryptoPriceAlerts = sqliteTable("crypto_price_alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currency: text("currency").notNull(), // BTC, ETH, XRP
  alertType: text("alert_type").notNull(), // "price_above", "price_below", "change_percent"
  triggerValue: real("trigger_value").notNull(),
  isActive: integer("is_active").default(1),
  lastTriggeredAt: text("last_triggered_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const cryptoBalanceAlerts = sqliteTable("crypto_balance_alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  addressId: integer("address_id").references(() => cryptoAddresses.id),
  currency: text("currency").notNull(),
  alertType: text("alert_type").notNull(), // "balance_above", "balance_below"
  triggerValue: text("trigger_value").notNull(), // BigInt as string
  isActive: integer("is_active").default(1),
  lastTriggeredAt: text("last_triggered_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ============================================================
// Bitcoin Puzzle Solver Persistence
// ============================================================
export const bitcoinPuzzles = sqliteTable("bitcoin_puzzles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  targetAddress: text("target_address").notNull(),
  infoUrl: text("info_url"),
  status: text("status").notNull().default("pending"), // pending, running, paused, completed, error
  triedCombinationsCount: integer("tried_combinations_count").notNull().default(0),
  generatedCount: integer("generated_count").notNull().default(0),
  currentCombinationMode: text("current_combination_mode").notNull().default("random"),
  foundAddress: text("found_address"),
  foundMnemonic: text("found_mnemonic"),
  errorMessage: text("error_message"),
  attemptsFilePath: text("attempts_file_path"), // Path to CSV with mnemonic/address pairs
  startedAt: text("started_at").notNull(),
  lastCheckAt: text("last_check_at").notNull(),
  lastSaveAt: text("last_save_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type BitcoinPuzzleInsert = typeof bitcoinPuzzles.$inferInsert;
export type BitcoinPuzzleSelect = typeof bitcoinPuzzles.$inferSelect;

// ============================================================
// Session Checklist
// ============================================================
// Per-conversation, per-run checklist derived from a Plan. Externalizes the
// agent's open-goal state so it survives context compression and lets the
// run-loop focus on / verify one step at a time instead of relying on the LLM
// to implicitly remember what is still outstanding. One row = one step.
export const sessionChecklist = sqliteTable("session_checklist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id).notNull(),
  runId: text("run_id"), // a fresh run/re-plan starts a new set under a new runId
  stepIndex: integer("step_index").notNull(), // ordering (= Planner step index)
  title: text("title").notNull(),
  description: text("description"),
  // The verifiable acceptance criteria for this step. Named acceptance_criteria
  // (not "constraint") because CONSTRAINT is a reserved SQL keyword.
  acceptanceCriteria: text("acceptance_criteria"),
  constraintKind: text("constraint_kind"), // requirement|logic-assertion|style|shell-check|unit-test
  status: text("status").notNull().default("pending"), // pending|in_progress|done|failed|unverified|skipped
  confidence: text("confidence"), // verified|soft (set when status=done)
  verifyState: text("verify_state"), // JSON: compact excerpt of the last VerifyResult
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SessionChecklistInsert = typeof sessionChecklist.$inferInsert;
export type SessionChecklistSelect = typeof sessionChecklist.$inferSelect;

// ============================================================
// Skill Usage (persistent per-skill stats, feeds the skill curator cron job)
// ============================================================
// SkillSelector's own in-memory metrics reset on every process restart and carry
// no durable "last used" timestamp - this table is the persistent counterpart,
// written alongside it so a periodic curator job can find skills nobody has
// used in a while (see cronjob-manager.ts::runSkillCuratorJob).
export const skillUsage = sqliteTable("skill_usage", {
  slug: text("slug").primaryKey(),
  totalUses: integer("total_uses").notNull().default(0),
  successfulUses: integer("successful_uses").notNull().default(0),
  avgIterations: real("avg_iterations").notNull().default(0),
  lastUsedAt: text("last_used_at").notNull(),
  status: text("status").notNull().default("active"), // active, stale
});

export type SkillUsageInsert = typeof skillUsage.$inferInsert;
export type SkillUsageSelect = typeof skillUsage.$inferSelect;

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
export type ArchivedConversationInsert = typeof archivedConversations.$inferInsert;
export type ArchivedConversationSelect = typeof archivedConversations.$inferSelect;
export type LlmWikiEntryInsert = typeof llmWikiEntries.$inferInsert;
export type LlmWikiEntrySelect = typeof llmWikiEntries.$inferSelect;
export type DynamicToolInsert = typeof dynamicTools.$inferInsert;
export type DynamicToolSelect = typeof dynamicTools.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;
export type PlanSelect = typeof plans.$inferSelect;
export type CryptoAddressInsert = typeof cryptoAddresses.$inferInsert;
export type CryptoAddressSelect = typeof cryptoAddresses.$inferSelect;
export type CryptoTransactionInsert = typeof cryptoTransactions.$inferInsert;
export type CryptoTransactionSelect = typeof cryptoTransactions.$inferSelect;
export type CryptoApiCredentialInsert = typeof cryptoApiCredentials.$inferInsert;
export type CryptoApiCredentialSelect = typeof cryptoApiCredentials.$inferSelect;
export type CryptoPortfolioSettingInsert = typeof cryptoPortfolioSettings.$inferInsert;
export type CryptoPortfolioSettingSelect = typeof cryptoPortfolioSettings.$inferSelect;
export type CryptoPortfolioHistoryInsert = typeof cryptoPortfolioHistory.$inferInsert;
export type CryptoPortfolioHistorySelect = typeof cryptoPortfolioHistory.$inferSelect;
export type CryptoPriceHistoryInsert = typeof cryptoPriceHistory.$inferInsert;
export type CryptoPriceHistorySelect = typeof cryptoPriceHistory.$inferSelect;
export type CryptoPriceAlertInsert = typeof cryptoPriceAlerts.$inferInsert;
export type CryptoPriceAlertSelect = typeof cryptoPriceAlerts.$inferSelect;
export type CryptoBalanceAlertInsert = typeof cryptoBalanceAlerts.$inferInsert;
export type CryptoBalanceAlertSelect = typeof cryptoBalanceAlerts.$inferSelect;
