import { mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("ScreenshotStorage");

const STORAGE_DIR = "./storage/screenshots";
const MAX_INLINE_SIZE = 150000; // 150KB - stay well under 200KB limit
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes

interface StoredScreenshot {
  id: string;
  url: string;
  size: number;
  mimeType: string;
  storedAt: Date;
  expiresAt: Date;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

class ScreenshotStorageManager {
  private screenshots = new Map<string, StoredScreenshot>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  async initialize(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
      await mkdir(STORAGE_DIR, { recursive: true });
    }
    this.startCleanup();
    logger.info("Screenshot storage initialized", { storageDir: STORAGE_DIR });
  }

  /**
   * Save a screenshot and return either inline data or storage reference
   * Returns { isStored: false, data } if size is under limit
   * Returns { isStored: true, id, url } if size is over limit and stored
   */
  async handleScreenshot(
    base64Data: string,
    mimeType: string = "image/jpeg"
  ): Promise<
    | { isStored: false; data: string; mimeType: string; size: number }
    | { isStored: true; id: string; url: string; size: number }
  > {
    const buffer = Buffer.from(base64Data, "base64");
    const size = buffer.length;

    if (size <= MAX_INLINE_SIZE) {
      return {
        isStored: false,
        data: base64Data,
        mimeType,
        size,
      };
    }

    // Size exceeds limit - store to disk
    const id = randomUUID();
    const filepath = join(STORAGE_DIR, `${id}.${extensionForMimeType(mimeType)}`);

    await writeFile(filepath, buffer);

    const screenshot: StoredScreenshot = {
      id,
      url: `/api/screenshots/${id}`,
      size,
      mimeType,
      storedAt: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_TTL),
    };

    this.screenshots.set(id, screenshot);

    logger.info("Screenshot stored", {
      id,
      size: `${Math.round(size / 1024)}KB`,
      url: screenshot.url,
      mimeType,
    });

    return {
      isStored: true,
      id,
      url: screenshot.url,
      size,
    };
  }

  /**
   * Retrieve stored screenshot by ID
   */
  async getScreenshot(id: string): Promise<Buffer | null> {
    const screenshot = this.screenshots.get(id);
    if (!screenshot) {
      return null;
    }

    if (new Date() > screenshot.expiresAt) {
      await this.deleteScreenshot(id);
      return null;
    }

    const filepath = join(STORAGE_DIR, `${id}.${extensionForMimeType(screenshot.mimeType)}`);
    try {
      return await readFile(filepath);
    } catch (error) {
      logger.error("Error reading screenshot", { id, error });
      return null;
    }
  }

  /**
   * Get the stored mimeType for a screenshot (used to set the correct Content-Type header).
   */
  getScreenshotMimeType(id: string): string {
    return this.screenshots.get(id)?.mimeType ?? "image/jpeg";
  }

  /**
   * Delete a screenshot
   */
  private async deleteScreenshot(id: string): Promise<void> {
    const screenshot = this.screenshots.get(id);
    if (!screenshot) return;

    try {
      // File deletion would go here if using fs.unlink
      this.screenshots.delete(id);
      logger.debug("Screenshot deleted", { id });
    } catch (error) {
      logger.error("Error deleting screenshot", { id, error });
    }
  }

  /**
   * Start periodic cleanup of expired screenshots
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(async () => {
      const now = new Date();
      let deletedCount = 0;

      for (const [id, screenshot] of this.screenshots.entries()) {
        if (now > screenshot.expiresAt) {
          await this.deleteScreenshot(id);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        logger.debug("Screenshot cleanup completed", { deletedCount });
      }
    }, CLEANUP_INTERVAL);
  }

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /**
   * Get statistics
   */
  getStats(): { count: number; totalSize: number } {
    let totalSize = 0;
    for (const screenshot of this.screenshots.values()) {
      totalSize += screenshot.size;
    }
    return {
      count: this.screenshots.size,
      totalSize,
    };
  }
}

let instance: ScreenshotStorageManager | null = null;

export function getScreenshotStorageManager(): ScreenshotStorageManager {
  if (!instance) {
    instance = new ScreenshotStorageManager();
  }
  return instance;
}

export async function initScreenshotStorage(): Promise<ScreenshotStorageManager> {
  const manager = getScreenshotStorageManager();
  await manager.initialize();
  return manager;
}
