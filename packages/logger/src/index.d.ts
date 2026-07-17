export type LogLevel = "debug" | "info" | "warn" | "error";
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
declare class Logger {
    private level;
    private logFile?;
    private module?;
    private colorize;
    constructor(options?: LoggerOptions);
    private shouldLog;
    private formatMessage;
    private log;
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
    child(module: string): Logger;
    setLevel(level: LogLevel): void;
}
export declare function createLogger(options?: LoggerOptions): Logger;
export declare function getRootLogger(): Logger;
export declare function setRootLogger(logger: Logger): void;
export { Logger };
export type { LoggerOptions as LoggerConfig };
//# sourceMappingURL=index.d.ts.map