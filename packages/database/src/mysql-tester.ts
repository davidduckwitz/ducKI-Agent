/**
 * Read-only connection test + table inspection for an external MariaDB/MySQL database.
 *
 * Lives in the database package because that is where the `mysql2` driver dependency is declared.
 * It only ever runs SELECTs (server version + information_schema listing) and disconnects again - it
 * never creates, alters or drops anything, and never touches the app's live SQLite database.
 */

export interface MysqlTestConfig {
  host: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
  /** Overrides the default expected-table list if a caller wants to check a different set. */
  expectedTables?: string[];
}

export interface MysqlTestResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
  latencyMs?: number;
  database?: string;
  totalTablesInDb?: number;
  tables?: { expected: number; present: string[]; missing: string[]; allPresent: boolean };
}

/** Core application tables (mirrors the SQLite schema in this package). */
export const EXPECTED_APP_TABLES = [
  "projects", "conversations", "messages", "tasks", "tools", "memories", "embeddings",
  "settings", "logs", "tool_executions", "cron_jobs", "archived_conversations",
  "llm_wiki_entries", "llm_wiki_links", "dynamic_tools",
];

export async function testMysqlConnection(config: MysqlTestConfig): Promise<MysqlTestResult> {
  const host = String(config.host ?? "").trim();
  const database = String(config.database ?? "").trim();
  if (!host || !database) {
    return { ok: false, error: "Host and database name are required." };
  }

  // Lazy import so the server starts fine even when the optional driver is not installed.
  let mysql: any;
  try {
    mysql = await import("mysql2/promise");
  } catch {
    return { ok: false, error: "The MySQL/MariaDB driver (mysql2) is not installed on the server." };
  }

  const expected = config.expectedTables ?? EXPECTED_APP_TABLES;
  const started = Date.now();
  let connection: any;
  try {
    connection = await mysql.createConnection({
      host,
      port: Number(config.port) || 3306,
      user: String(config.user ?? "root"),
      password: String(config.password ?? ""),
      database,
      connectTimeout: 8000,
    });

    const [verRows] = await connection.query("SELECT VERSION() AS version");
    const serverVersion = Array.isArray(verRows) && verRows[0]
      ? String((verRows[0] as Record<string, unknown>)["version"] ?? "")
      : "";

    const [tblRows] = await connection.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?",
      [database]
    );
    const present = new Set(
      (Array.isArray(tblRows) ? tblRows : [])
        .map((r: Record<string, unknown>) => String(r["name"] ?? r["NAME"] ?? "").toLowerCase())
        .filter((n: string) => n.length > 0)
    );
    const presentExpected = expected.filter((t) => present.has(t));
    const missing = expected.filter((t) => !present.has(t));

    return {
      ok: true,
      serverVersion,
      latencyMs: Date.now() - started,
      database,
      totalTablesInDb: present.size,
      tables: {
        expected: expected.length,
        present: presentExpected,
        missing,
        allPresent: missing.length === 0,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (connection) {
      try { await connection.end(); } catch { /* best-effort close */ }
    }
  }
}
