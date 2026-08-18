import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Per-plugin SQLite storage. Each plugin that opts into `storage.sqlite` gets its OWN
 * database file at plugins/<name>/data/<name>.sqlite with its OWN libsql connection -
 * completely separate from the main app database. This keeps the main DB small and avoids
 * one monolithic database growing without bound: a plugin's data lives (and is deleted)
 * with the plugin's folder.
 *
 * Reuses the same @libsql/client the main DB uses, so no new dependency is introduced.
 */

export interface PluginStorage {
  /** Run a write/DDL statement. */
  exec(sql: string, args?: unknown[]): Promise<void>;
  /** Run a query and get rows back. */
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T[]>;
  /** Simple KV convenience over an auto-created kv(key TEXT PRIMARY KEY, value TEXT) table. */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

const clients = new Map<string, Client>();
const pragmasReady = new Map<string, Promise<void>>();

/**
 * Same fix as the main DB's applyConnectionPragmas (packages/database/src/index.ts): the
 * default rollback journal takes an exclusive lock on the whole file for any write, so a
 * concurrent read/write from another connection (a second dev-server process, or a
 * settings-page read racing a migration write on boot) fails immediately as
 * "SQLITE_BUSY: database is locked" instead of waiting. WAL lets readers/writer run
 * concurrently; busy_timeout makes any remaining contention wait instead of erroring.
 */
function applyPragmas(client: Client): Promise<void> {
  return (async () => {
    try {
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA busy_timeout = 5000");
      await client.execute("PRAGMA synchronous = NORMAL");
    } catch {
      // Non-fatal (e.g. file on a network share where WAL is unsupported) - fall back to
      // default locking behavior rather than breaking plugin storage entirely.
    }
  })();
}

/** Resolve the plugins root once; kept overridable for tests via env. */
function pluginsRoot(): string {
  return process.env["DUCKI_PLUGINS_DIR"] ?? resolve(process.cwd(), "plugins");
}

/** Strict single-segment plugin name -> no path traversal into other folders. */
function assertSafeName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Unsafe plugin name for storage: '${name}'`);
  }
}

function kvInit(client: Client): Promise<unknown> {
  return client.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
}

/**
 * Open (or reuse) a plugin's private database. The file lives under
 * plugins/<name>/data/<name>.sqlite and is created on first use.
 */
export function openPluginDb(name: string): PluginStorage {
  assertSafeName(name);
  let client = clients.get(name);
  if (!client) {
    const filePath = join(pluginsRoot(), name, "data", `${name}.sqlite`);
    mkdirSync(dirname(filePath), { recursive: true });
    client = createClient({ url: `file:${filePath}` });
    clients.set(name, client);
    pragmasReady.set(name, applyPragmas(client));
  }
  const c = client;
  const ensurePragmas = () => pragmasReady.get(name) ?? Promise.resolve();

  let kvReady: Promise<unknown> | null = null;
  const ensureKv = () => (kvReady ??= ensurePragmas().then(() => kvInit(c)));

  return {
    async exec(sql, args = []) {
      await ensurePragmas();
      await c.execute({ sql, args: args as never[] });
    },
    async query<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
      await ensurePragmas();
      const res = await c.execute({ sql, args: args as never[] });
      return res.rows as unknown as T[];
    },
    async get(key) {
      await ensureKv();
      const res = await c.execute({ sql: "SELECT value FROM kv WHERE key = ?", args: [key] });
      const row = res.rows[0] as { value?: string } | undefined;
      return row?.value;
    },
    async set(key, value) {
      await ensureKv();
      await c.execute({ sql: "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [key, value] });
    },
    async delete(key) {
      await ensureKv();
      await c.execute({ sql: "DELETE FROM kv WHERE key = ?", args: [key] });
    },
    async close() {
      pragmasReady.delete(name);
      clients.delete(name);
      c.close();
    },
  };
}

/** Close every open plugin connection (tests / shutdown). */
export function closeAllPluginDbs(): void {
  for (const [, client] of clients) client.close();
  clients.clear();
}
