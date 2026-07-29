import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Database factory to support multiple database engines
 * Selects SQLite, MySQL, or MariaDB based on connection URL
 */
export class DatabaseFactory {
  private logger: Logger;

  constructor() {
    this.logger = getRootLogger().child("DatabaseFactory");
  }

  /**
   * Detect database type from URL
   */
  static detectDatabaseType(
    url: string
  ): "sqlite" | "mysql" | "mariadb" | "libsql" {
    const lower = url.toLowerCase();

    if (lower.startsWith("mysql://")) return "mysql";
    if (lower.startsWith("mariadb://")) return "mariadb";
    if (lower.startsWith("file:")) return "sqlite";
    if (lower.startsWith("libsql://") || lower.startsWith("https://")) return "libsql";

    // Default to SQLite for local paths
    return "sqlite";
  }

  /**
   * Create appropriate database connection
   */
  async createConnection(url: string) {
    const dbType = DatabaseFactory.detectDatabaseType(url);
    this.logger.info("Creating database connection", {
      type: dbType,
      url: url.split("@")[0], // Hide credentials
    });

    switch (dbType) {
      case "mysql":
      case "mariadb":
        // Dynamic import for MySQL driver
        try {
          const { MySQLDriver } = await import("./drivers/mysql-driver.js");
          const driver = new MySQLDriver({ url });
          await driver.connect();
          return driver;
        } catch (error) {
          this.logger.error("Failed to load MySQL driver", {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

      case "sqlite":
      case "libsql":
      default:
        // Default to LibSQL/SQLite
        const { DatabaseService } = await import("./index.js");
        const dbPath = url.startsWith("file:") ? url.slice(5) : url;
        const service = new DatabaseService(dbPath);
        await service.initialize();
        return service;
    }
  }

  /**
   * Get database URL from environment
   */
  static getDatabaseUrl(): string {
    const url =
      process.env.DATABASE_URL ||
      process.env.DB_URL ||
      "./storage/ducki.db";

    return url;
  }

  /**
   * Get database type from environment
   */
  static getDatabaseType(): "sqlite" | "mysql" | "mariadb" | "libsql" {
    const url = this.getDatabaseUrl();
    return this.detectDatabaseType(url);
  }
}

/**
 * Create singleton database instance
 */
let databaseInstance: any;

export async function initializeDatabase() {
  if (!databaseInstance) {
    const factory = new DatabaseFactory();
    const url = DatabaseFactory.getDatabaseUrl();
    databaseInstance = await factory.createConnection(url);
  }
  return databaseInstance;
}

export function getDatabase() {
  if (!databaseInstance) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return databaseInstance;
}
