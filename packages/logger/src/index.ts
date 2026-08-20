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
  /**
   * When true, debug/info entries are held in an in-memory ring buffer instead of being
   * printed immediately - only warn/error print right away, and printing one first flushes
   * the buffered debug/info trail (dimmed) that led up to it. Lets a terminal UI (the CLI)
   * stay quiet during normal operation while still surfacing the recent diagnostic context
   * the moment something actually goes wrong, instead of either seeing everything or
   * nothing. Off by default - existing callers (the server) are unaffected.
   */
  quiet?: boolean;
  /** Internal: shared buffer reference passed from parent to child() loggers so they flush together. */
  buffer?: LogEntry[];
  /** Max buffered debug/info entries kept for a flush-on-warn/error. Default 50. */
  maxBufferSize?: number;
}

class Logger {
  private level: LogLevel;
  private logFile?: string;
  private module?: string;
  private colorize: boolean;
  private quiet: boolean;
  private buffer: LogEntry[];
  private maxBufferSize: number;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.logFile = options.logFile;
    this.module = options.module;
    this.colorize = options.colorize ?? true;
    this.quiet = options.quiet ?? false;
    this.buffer = options.buffer ?? [];
    this.maxBufferSize = options.maxBufferSize ?? 50;

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
    // In quiet mode, debug/info are always captured into the buffer (bypassing the normal
    // level filter, so a "warn"-level console can still surface debug context on failure);
    // warn/error still respect shouldLog as before.
    const isLowSeverity = level === "debug" || level === "info";
    if (!this.quiet && !this.shouldLog(level)) return;
    if (this.quiet && !isLowSeverity && !this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
      module: this.module,
    };

    const formatted = this.formatMessage(entry);

    // File output happens regardless of quiet mode - a log file should still get everything.
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, formatted + "\n");
      } catch (err) {
        // Surface the write failure once on the console instead of silently dropping
        // log lines - losing logs invisibly makes production issues unreviewable.
        console.error(`[Logger] Failed to write to log file ${this.logFile}:`, err);
      }
    }

    if (this.quiet && isLowSeverity) {
      this.buffer.push(entry);
      if (this.buffer.length > this.maxBufferSize) this.buffer.shift();
      return;
    }

    if (this.quiet && this.buffer.length > 0) {
      // Something actually went wrong - flush the debug/info trail that led up to it,
      // dimmed so it visually reads as background context rather than the main message.
      const dim = "\x1b[2m";
      for (const buffered of this.buffer) {
        const line = this.formatMessage(buffered);
        console.error(this.colorize && process.stdout.isTTY ? `${dim}${line}${RESET}` : line);
      }
      this.buffer.length = 0;
    }

    // Route warn/error to stderr so process managers and log shippers that split
    // stdout/stderr (or filter by level) actually see them.
    const write = level === "warn" || level === "error" ? console.error : console.log;

    // Console output with colors
    if (this.colorize && process.stdout.isTTY) {
      write(`${COLORS[level]}${formatted}${RESET}`);
    } else {
      write(formatted);
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
      quiet: this.quiet,
      buffer: this.buffer,
      maxBufferSize: this.maxBufferSize,
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
