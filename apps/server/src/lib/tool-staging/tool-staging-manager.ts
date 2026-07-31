import { promises as fs } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Logger } from "@ducki/logger";

export interface StagedToolResult {
  id: string;
  toolName: string;
  summary: string;
  filePath: string;
  content: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Hybrid Tool Response Staging
 * - Large responses stored in Markdown files
 * - Brief summaries sent via Messages (live feedback)
 * - Agents read full Markdown when needed
 * - Auto-cleanup via TTL
 */
export class ToolStagingManager {
  private readonly stagingDir: string;
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    stagingDir: string = "./storage/tool-staging",
    ttlMs: number = 30 * 60 * 1000, // 30 minutes default
  ) {
    this.stagingDir = stagingDir;
    this.ttlMs = ttlMs;
  }

  async start(): Promise<void> {
    // Create staging directory if it doesn't exist
    await fs.mkdir(this.stagingDir, { recursive: true });

    // Start cleanup interval (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      void this.cleanup();
    }, 5 * 60 * 1000);

    this.logger.info("Tool staging manager started", {
      stagingDir: this.stagingDir,
      ttlMs: this.ttlMs,
    });
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.logger.info("Tool staging manager stopped");
  }

  /**
   * Stage a large tool response
   * - Saves full content to Markdown file
   * - Returns summary + file reference
   */
  async stageToolResponse(
    toolName: string,
    content: string,
    summary: string
  ): Promise<StagedToolResult> {
    const id = randomUUID();
    const fileName = `${toolName}_${id}.md`;
    const filePath = join(this.stagingDir, fileName);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    // Wrap content with metadata header
    const fullContent = [
      `# Tool Response: ${toolName}`,
      `**ID:** ${id}`,
      `**Generated:** ${now.toISOString()}`,
      `**Expires:** ${expiresAt.toISOString()}`,
      `**Summary:** ${summary}`,
      "",
      "---",
      "",
      content,
    ].join("\n");

    // Write to file
    await fs.writeFile(filePath, fullContent, "utf-8");

    this.logger.debug("Tool response staged", {
      id,
      toolName,
      filePath,
      contentSize: content.length,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      id,
      toolName,
      summary,
      filePath,
      content: fullContent,
      createdAt: now,
      expiresAt,
    };
  }

  /**
   * Get staged response by ID
   */
  async getStagedResponse(id: string): Promise<StagedToolResult | undefined> {
    const files = await fs.readdir(this.stagingDir);
    const file = files.find((f) => f.includes(`_${id}.md`));

    if (!file) {
      this.logger.debug("Staged response not found", { id });
      return undefined;
    }

    const filePath = join(this.stagingDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const toolName = file.split("_")[0] ?? "unknown";

    return {
      id,
      toolName,
      summary: "Retrieved from staging",
      filePath,
      content,
      createdAt: new Date(),
      expiresAt: new Date(),
    };
  }

  /**
   * Delete staged response
   */
  async deleteStaged(id: string): Promise<boolean> {
    const files = await fs.readdir(this.stagingDir);
    const file = files.find((f) => f.includes(`_${id}.md`));

    if (!file) {
      this.logger.debug("Staged response not found for deletion", { id });
      return false;
    }

    const filePath = join(this.stagingDir, file);
    await fs.unlink(filePath);

    this.logger.debug("Staged response deleted", { id, filePath });
    return true;
  }

  /**
   * Cleanup expired staged responses
   */
  private async cleanup(): Promise<void> {
    const files = await fs.readdir(this.stagingDir);
    const now = new Date();
    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = join(this.stagingDir, file);
      const stat = await fs.stat(filePath);
      const age = now.getTime() - stat.mtime.getTime();

      if (age > this.ttlMs) {
        await fs.unlink(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug("Tool staging cleanup completed", { cleaned });
    }
  }

  /**
   * Get all staged responses (for debugging)
   */
  async listStaged(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.stagingDir);
      return files.filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }
}

// Global singleton
let globalStagingManager: ToolStagingManager | undefined;

export function getToolStagingManager(
  logger?: Logger,
  stagingDir?: string
): ToolStagingManager {
  if (!globalStagingManager && logger) {
    globalStagingManager = new ToolStagingManager(logger, stagingDir);
  }
  return globalStagingManager!;
}

export async function initToolStagingManager(
  logger: Logger,
  stagingDir?: string
): Promise<ToolStagingManager> {
  const manager = new ToolStagingManager(logger, stagingDir);
  await manager.start();
  globalStagingManager = manager;
  return manager;
}
