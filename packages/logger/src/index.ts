import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | undefined;
  timestamp: string;
  module: string | undefined;
}

export interface LoggerOptions {
  level?: LogLevel;
  logFile?: string | undefined;
  module?: string | undefined;
  colorize?: boolean;
}

class Logger {
  private level: LogLevel;
  private logFile?: string;
  private module?: string;
  private colorize: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.logFile = options.logFile;
    this.module = options.module;
    this.colorize = options.colorize ?? true;

    if (this.logFile) {
      const dir = dirname(this.logFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private formatMessage(entry: LogEntry): string {
    const parts = [
      `[${entry.timestamp}]`,
      `[${entry.level.toUpperCase().padEnd(5)}]`,
    ];

    if (entry.module) {
      parts.push(`[${entry.module}]`);
    }

    parts.push(entry.message);

    if (entry.context && Object.keys(entry.context).length > 0) {
      parts.push(JSON.stringify(entry.context));
    }

    return parts.join(" ");
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
      module: this.module,
    };

    const formatted = this.formatMessage(entry);

    // Console output with colors
    if (this.colorize && process.stdout.isTTY) {
      console.log(`${COLORS[level]}${formatted}${RESET}`);
    } else {
      console.log(formatted);
    }

    // File output
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, formatted + "\n");
      } catch {
        // Ignore file write errors to avoid infinite loops
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  child(module: string): Logger {
    return new Logger({
      level: this.level,
      logFile: this.logFile,
      module: this.module ? `${this.module}:${module}` : module,
      colorize: this.colorize,
    });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

let rootLogger: Logger | undefined;

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}

export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = new Logger({
      level: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info",
      logFile: process.env["LOG_FILE"],
      colorize: true,
    });
  }
  return rootLogger;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export { Logger };
export type { LoggerOptions as LoggerConfig };
