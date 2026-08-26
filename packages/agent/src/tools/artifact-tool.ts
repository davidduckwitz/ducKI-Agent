/**
 * Core "artifact" tool: manages the cross-cutting artifact registry (packages/database's
 * `artifacts` table) - uploaded files, screenshots, and video previews the agent has produced
 * or fetched. Always registered (like `memory`/`task`), not a plugin, since artifacts need to
 * be writable/readable regardless of which subsystem produced them (chat uploads, the Cloud
 * Voice-App, Discord, ...) - a plugin's isolated storage can't see across those sources.
 *
 * action=ask is the important one for cost: it answers a NEW question about a previously
 * analyzed video/image using the artifact's ALREADY-STORED frames/transcript - no re-download,
 * works even after the source file was deleted (see cloud-control.ts's "video.preview", which
 * deletes the video immediately after extracting frames+transcript). action=refetch_video is
 * the explicit, user-requested exception: pulls the source file back down when the stored
 * frames genuinely aren't enough.
 */
import type { LLMProvider } from "@ducki/providers";
import type { LLMContent, LLMMessage, ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { fetchVideoFromUrl } from "../media/video-source-fetch.js";
import { analyzeVideo } from "../media/video-processing.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/** Best-effort delete of the underlying file, guarded to the shared workspace like the
 *  attachment pipeline in agent.ts. Never throws - a missing/already-gone file is a no-op. */
function removeArtifactFile(relativePath: string | null | undefined, logger: Logger): void {
  if (!relativePath) return;
  try {
    const workspaceRoot = resolve(SHARED_WORKSPACE_ROOT);
    const absolutePath = resolve(workspaceRoot, relativePath);
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspaceRoot + sep)) return;
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
  } catch (error) {
    logger.warn("Failed to remove artifact file", {
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface StoredFrame {
  timestampSec: number;
  base64: string;
}

export function createArtifactTool(db: DatabaseService, getProvider: () => LLMProvider, logger: Logger): ToolExecutor {
  return {
    name: "artifact",
    description:
      "Manage the artifact registry (uploaded files, screenshots, video previews the agent has produced/fetched). " +
      "action=list (conversationId?, source?)/get (id)/delete (id). " +
      "action=ask (id, question): answer a NEW question about a previously analyzed video/image using its already-stored frames/transcript - no re-download, works even after the source file was deleted. " +
      "action=refetch_video (id): re-downloads a video artifact's source file and refreshes its transcript/frames - only use when the user explicitly asks to fetch/download the video again.",
    definition: {
      name: "artifact",
      description: "List/inspect/delete artifacts, ask a question about a stored video/image artifact, or re-fetch a video artifact's source file on explicit request.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "delete", "ask", "refetch_video"] },
          id: { type: "number", description: "Artifact id (get/delete/ask/refetch_video)" },
          conversationId: { type: "number", description: "Filter by conversation (list)" },
          source: { type: "string", description: "Filter by producer, e.g. 'voice_app'/'chat_upload' (list)" },
          question: { type: "string", description: "Question to answer about the artifact (ask)" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "");
      try {
        if (action === "list") {
          const conversationId = input["conversationId"] != null ? Number(input["conversationId"]) : undefined;
          const source = typeof input["source"] === "string" ? input["source"] : undefined;
          const items = await db.listArtifacts({ conversationId, source });
          return ok({
            count: items.length,
            artifacts: items.map(({ framesJson: _framesJson, ...rest }) => rest),
          });
        }

        const id = Number(input["id"]);
        if (!Number.isFinite(id)) return fail(`action=${action} requires 'id'`);

        if (action === "get") {
          const artifact = await db.getArtifact(id);
          if (!artifact) return fail(`Artifact ${id} not found`);
          const { framesJson, ...rest } = artifact;
          return ok({ ...rest, hasFrames: !!framesJson });
        }

        if (action === "delete") {
          const artifact = await db.getArtifact(id);
          if (!artifact) return fail(`Artifact ${id} not found`);
          removeArtifactFile(artifact.path, logger);
          await db.deleteArtifact(id);
          return ok({ deleted: true, id });
        }

        if (action === "ask") {
          const question = String(input["question"] ?? "").trim();
          if (!question) return fail("action=ask requires 'question'");
          const artifact = await db.getArtifact(id);
          if (!artifact) return fail(`Artifact ${id} not found`);
          const frames: StoredFrame[] = artifact.framesJson ? JSON.parse(artifact.framesJson) : [];
          if (frames.length === 0) return fail(`Artifact ${id} has no stored frames to analyze`);

          const imageBlocks: LLMContent[] = frames.map((frame) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${frame.base64}`, detail: "high" },
          }));
          const transcriptLine = artifact.transcript ? `Transcript: ${artifact.transcript}\n\n` : "";
          const messages: LLMMessage[] = [
            { role: "user", content: [...imageBlocks, { type: "text", text: `${transcriptLine}${question}` }] },
          ];
          // Generous headroom for reasoning models: hidden "thinking" tokens eat into the same
          // budget before the real answer is written.
          const response = await getProvider().generate(messages, { temperature: 0.2, maxTokens: 4000 });
          return ok({ answer: response.content });
        }

        if (action === "refetch_video") {
          const artifact = await db.getArtifact(id);
          if (!artifact) return fail(`Artifact ${id} not found`);
          if (!artifact.sourceUrl) return fail(`Artifact ${id} has no sourceUrl to refetch from`);

          const fetched = await fetchVideoFromUrl(artifact.sourceUrl, logger);
          if (!fetched) return fail(`Could not refetch video from ${artifact.sourceUrl}`);

          const analysis = await analyzeVideo(db, logger, fetched.buffer);
          if (!analysis) return fail("Video re-analysis failed (ffmpeg unavailable or the file is too large)");

          const frames = analysis.frames.map((frame) => ({ timestampSec: frame.timestampSec, base64: frame.buffer.toString("base64") }));
          await db.updateArtifact(id, {
            transcript: analysis.transcript,
            framesJson: JSON.stringify(frames),
            thumbnailDataUrl: frames[0] ? `data:image/jpeg;base64,${frames[0].base64}` : artifact.thumbnailDataUrl,
            durationSec: analysis.durationSec,
            sizeBytes: fetched.buffer.length,
            status: "ready",
            error: null,
          });

          return ok({ refetched: true, id, durationSec: analysis.durationSec, frameCount: frames.length, transcript: analysis.transcript });
        }

        return fail(`Unknown action: ${action}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
