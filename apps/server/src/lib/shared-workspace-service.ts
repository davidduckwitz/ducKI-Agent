/**
 * Shared Workspace Service
 *
 * Manages per-group shared workspace directories where bots in the same
 * group chat can read, write, and collaborate on files. Modeled after
 * Grok Bot's "Shared Cloud Computer" concept, but using local filesystem.
 *
 * Workspace structure:
 *   shared-workspace/
 *     bot-groups/
 *       <chat-id>/
 *         files/      # Shared working directory
 *         output/     # Final deliverables
 *         staging/    # Works-in-progress
 */
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("SharedWorkspace");

const WORKSPACE_ROOT = join(process.cwd(), "shared-workspace", "bot-groups");

export class SharedWorkspaceService {
  /** Ensure the workspace directory for a group exists and return its path. */
  resolveGroupWorkspace(chatId: number): string {
    const dir = join(WORKSPACE_ROOT, String(chatId));
    for (const sub of ["", "files", "output", "staging"]) {
      const subDir = sub ? join(dir, sub) : dir;
      if (!existsSync(subDir)) {
        mkdirSync(subDir, { recursive: true });
        logger.debug("Created shared workspace directory", { path: subDir, chatId });
      }
    }
    return dir;
  }

  /** Get the workspace root path for resolving relative paths. */
  getWorkspaceRoot(): string {
    return WORKSPACE_ROOT;
  }

  /** Build a scoped sandbox root for a bot in a group chat.
   *  The bot can only access its group's shared workspace directory. */
  getBotSandboxRoot(chatId: number): string {
    return this.resolveGroupWorkspace(chatId);
  }

  /** Returns a concise description of the group workspace for inclusion in system prompts. */
  getWorkspaceContext(chatId: number): string {
    const dir = this.resolveGroupWorkspace(chatId);
    return [
      "=== Shared Group Workspace ===",
      `Root: ${dir}`,
      `  files/   - Shared working directory (all bots can read/write)`,
      `  output/  - Final deliverables`,
      `  staging/ - Works-in-progress`,
      "",
      "Files saved here are visible to ALL bots in this group chat.",
      "Use this workspace to pass results between bots instead of pasting inline.",
      "For large outputs, save to output/ and tell the next bot the filename.",
    ].join("\n");
  }

  /** Inject workspace context into the group chat transcript visible to all bots. */
  async injectWorkspaceContext(
    db: { addMessage: (data: any) => Promise<any> },
    conversationId: number,
    chatId: number
  ): Promise<void> {
    const context = this.getWorkspaceContext(chatId);
    await db.addMessage({
      conversationId,
      role: "system",
      content: context,
      metadata: JSON.stringify({ internal: true, sharedWorkspace: true }),
    });
  }
}

/** Singleton */
export const sharedWorkspace = new SharedWorkspaceService();