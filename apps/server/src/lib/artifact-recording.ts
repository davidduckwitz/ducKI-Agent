/**
 * Wraps the (shared-workspace-scoped, non-coding) `browser` and `filesystem` core tools so
 * screenshots/PDFs the agent captures and documents it writes are recorded in the artifact
 * registry alongside chat uploads and video previews - "auch wenn der Agent selbst Screenshots
 * und Dokumente speichert, sollen diese in die Artefakte" (coding excluded by construction: the
 * CodingAgent uses a SEPARATE, project-scoped filesystem tool instance - see
 * createScopedFilesystemTool in packages/agent/src/coding/scoped-filesystem-tool.ts - that is
 * never part of `runtimeTools`/`allTools`, so it's never wrapped here).
 *
 * Best-effort throughout: a failed artifact write is logged and swallowed, never surfaced to the
 * agent or the user - the underlying tool call already succeeded and that's what matters to them.
 */
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { relative, resolve, sep } from "node:path";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";

function toRelativeWorkspacePath(absoluteOrRelative: string): string | null {
  const workspaceRoot = resolve(SHARED_WORKSPACE_ROOT);
  const absolute = resolve(workspaceRoot, absoluteOrRelative);
  if (absolute !== workspaceRoot && !absolute.startsWith(workspaceRoot + sep)) return null;
  return relative(workspaceRoot, absolute).replaceAll("\\", "/");
}

export function withBrowserArtifactRecording(tool: ToolExecutor, db: DatabaseService, logger: Logger): ToolExecutor {
  return {
    ...tool,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const result = await tool.execute(input);
      if (result.success) {
        void recordBrowserArtifact(db, input, result).catch((error) => {
          logger.debug("Failed to record browser artifact", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      return result;
    },
  };
}

async function recordBrowserArtifact(db: DatabaseService, input: Record<string, unknown>, result: ToolResult): Promise<void> {
  const action = String(input["action"] ?? "");
  if (action !== "screenshot" && action !== "screenshot_url" && action !== "pdf") return;

  const data = (result.data ?? {}) as Record<string, unknown>;
  const savedTo = typeof data["savedTo"] === "string" && data["savedTo"] ? data["savedTo"] : null;
  const relativePath = savedTo ? toRelativeWorkspacePath(savedTo) : null;

  if (action === "pdf") {
    if (!relativePath) return; // pdf always writes to filePath - no path means nothing to record
    await db.createArtifact({
      filename: relativePath.split("/").pop() ?? "document.pdf",
      mimeType: "application/pdf",
      sizeBytes: typeof data["bytes"] === "number" ? data["bytes"] : null,
      path: relativePath,
      sourceUrl: typeof data["url"] === "string" ? data["url"] : null,
      platform: null,
      transcript: null,
      framesJson: null,
      thumbnailDataUrl: null,
      durationSec: null,
      conversationId: null,
      source: "agent_screenshot",
      status: "ready",
      error: null,
    });
    return;
  }

  // screenshot / screenshot_url: base64 always present, savedTo only when the caller passed an
  // explicit filePath (screenshot) - most calls don't, so the base64 IS the artifact's content.
  const base64 = typeof data["screenshot"] === "string" ? data["screenshot"] : null;
  if (!base64 && !relativePath) return;
  const metadata = (data["metadata"] ?? {}) as Record<string, unknown>;
  const format = typeof metadata["format"] === "string" ? metadata["format"] : "jpeg";

  await db.createArtifact({
    filename: relativePath ? relativePath.split("/").pop()! : `screenshot-${Date.now()}.${format}`,
    mimeType: `image/${format}`,
    sizeBytes: typeof data["bytes"] === "number" ? data["bytes"] : null,
    path: relativePath,
    sourceUrl: typeof data["url"] === "string" ? data["url"] : null,
    platform: null,
    transcript: null,
    framesJson: null,
    thumbnailDataUrl: base64 ? `data:image/${format};base64,${base64}` : null,
    durationSec: null,
    conversationId: null,
    source: "agent_screenshot",
    status: "ready",
    error: null,
  });
}

export function withFilesystemArtifactRecording(tool: ToolExecutor, db: DatabaseService, logger: Logger): ToolExecutor {
  return {
    ...tool,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const result = await tool.execute(input);
      if (result.success && String(input["action"] ?? "") === "write") {
        void recordDocumentArtifact(db, result).catch((error) => {
          logger.debug("Failed to record document artifact", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      return result;
    },
  };
}

async function recordDocumentArtifact(db: DatabaseService, result: ToolResult): Promise<void> {
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (data["dryRun"] === true) return;
  const rawPath = typeof data["path"] === "string" ? data["path"] : null;
  if (!rawPath) return;
  const relativePath = toRelativeWorkspacePath(rawPath);
  if (!relativePath) return;

  const filename = relativePath.split("/").pop() ?? relativePath;
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const mimeByExt: Record<string, string> = {
    pdf: "application/pdf", md: "text/markdown", txt: "text/plain", csv: "text/csv",
    json: "application/json", html: "text/html", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };

  await db.createArtifact({
    filename,
    mimeType: mimeByExt[ext] ?? "text/plain",
    sizeBytes: typeof data["bytes"] === "number" ? data["bytes"] : null,
    path: relativePath,
    sourceUrl: null,
    platform: null,
    transcript: null,
    framesJson: null,
    thumbnailDataUrl: null,
    durationSec: null,
    conversationId: null,
    source: "agent_document",
    status: "ready",
    error: null,
  });
}
