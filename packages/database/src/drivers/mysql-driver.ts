import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Database driver interface
 */
export interface DatabaseDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  queryOne(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null>;
  transaction(callback: (db: DatabaseDriver) => Promise<void>): Promise<void>;
  getStatus(): { connected: boolean; driver: string; poolSize?: number };
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

export interface DatabaseConfig {
  url: string;
}

// Only import mysql2 if it's actually installed (lazy load)
let mysql: any;

/**
 * MySQL/MariaDB database driver
 * Supports connection pooling for better concurrency
 */
export class MySQLDriver implements DatabaseDriver {
  private logger: Logger;
  private pool: any | null = null;
  private connection: any | null = null;
  private config: DatabaseConfig;
  private isConnected = false;

  constructor(config: DatabaseConfig) {
    this.logger = getRootLogger().child("MySQLDriver");
    this.config = config;
  }

  /**
   * Connect to MySQL/MariaDB database
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      this.logger.debug("Already connected to MySQL");
      return;
    }

    try {
      // Lazy load mysql2
      if (!mysql) {
        try {
          mysql = await import("mysql2/promise");
        } catch (error) {
          throw new Error(
            "mysql2 package is not installed. Install it with: npm install mysql2"
          );
        }
      }

      const url = new URL(this.config.url);
      const host = url.hostname;
      const port = url.port ? parseInt(url.port) : 3306;
      const database = url.pathname.slice(1);
      const username = url.username || "root";
      const password = url.password || "";

      // Use connection pooling for better performance
      this.pool = await mysql.createPool({
        host,
        port,
        database,
        user: username,
        password,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelayMs: 0,
      });

      this.isConnected = true;
      this.logger.info("Connected to MySQL/MariaDB", {
        host,
        port,
        database,
        poolSize: 10,
      });
    } catch (error) {
      this.logger.error("Failed to connect to MySQL/MariaDB", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    try {
      if (this.connection) {
        await this.connection.end();
        this.connection = null;
      }
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
      this.isConnected = false;
      this.logger.info("Disconnected from MySQL/MariaDB");
    } catch (error) {
      this.logger.error("Error disconnecting from MySQL/MariaDB", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute a query
   */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.pool && !this.connection) {
      throw new Error("Not connected to database");
    }

    const executor = this.pool || this.connection;
    if (!executor) throw new Error("No database executor available");

    try {
      const [rows] = await executor.execute(sql, params || []);
      return {
        rows: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
      };
    } catch (error) {
      this.logger.error("Query execution failed", {
        sql: sql.substring(0, 100),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute query and get first row
   */
  async queryOne(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null> {
    const result = await this.query(sql, params);
    return (result.rows[0] as Record<string, unknown>) || null;
  }

  /**
   * Execute multiple queries in a transaction
   */
  async transaction(
    callback: (db: DatabaseDriver) => Promise<void>
  ): Promise<void> {
    if (!this.pool) {
      throw new Error("Connection pool not available");
    }

    const connection = await this.pool.getConnection();
    const previousConnection = this.connection;

    try {
      this.connection = connection;
      await connection.beginTransaction();

      await callback(this);

      await connection.commit();
      this.logger.debug("Transaction committed");
    } catch (error) {
      try {
        await connection.rollback();
        this.logger.debug("Transaction rolled back");
      } catch (rollbackError) {
        this.logger.error("Rollback failed", {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    } finally {
      this.connection = previousConnection;
      await connection.release();
    }
  }

  /**
   * Check if connected
   */
  getStatus(): {
    connected: boolean;
    driver: string;
    poolSize?: number;
  } {
    return {
      connected: this.isConnected,
      driver: "MySQL/MariaDB",
      poolSize: 10,
    };
  }
}
