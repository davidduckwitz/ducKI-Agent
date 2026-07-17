import type { Request, Response, NextFunction } from "express";
import { getRootLogger } from "@ducki/logger";
import type { DatabaseService } from "@ducki/database";

const logger = getRootLogger().child("ErrorHandler");

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error("Unhandled error", { message: error.message, stack: error.stack });

  const db = req.app.locals["db"] as DatabaseService | undefined;
  if (db) {
    void db.addLog({
      level: "error",
      message: error.message,
      context: JSON.stringify({
        path: req.originalUrl,
        method: req.method,
        stack: error.stack,
      }),
    }).catch(() => {
      // Ignore DB logging failures inside error path.
    });
  }

  res.status(500).json({
    success: false,
    error: process.env["NODE_ENV"] === "production" ? "Internal server error" : error.message,
    timestamp: new Date().toISOString(),
  });
}
