import { Router, type IRouter } from "express";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";

/**
 * REST surface for the artifact registry (see packages/database's `artifacts` table and
 * packages/agent's `artifact` core tool, which the agent itself uses). This is the read/delete
 * surface for the web UI's Artefakte page under /shared - creation happens where artifacts are
 * actually produced (cloud-control.ts's "video.preview", the shared-upload path, ...), not here.
 */
export const artifactsRouter: IRouter = Router();

function removeArtifactFile(relativePath: string | null | undefined): void {
  if (!relativePath) return;
  const workspaceRoot = resolve(SHARED_WORKSPACE_ROOT);
  const absolutePath = resolve(workspaceRoot, relativePath);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspaceRoot + sep)) return;
  if (existsSync(absolutePath)) unlinkSync(absolutePath);
}

artifactsRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = req.query["conversationId"] ? parseInt(req.query["conversationId"] as string, 10) : undefined;
    const source = typeof req.query["source"] === "string" ? (req.query["source"] as string) : undefined;
    const limit = req.query["limit"] ? parseInt(req.query["limit"] as string, 10) : undefined;

    const items = await db.listArtifacts({ conversationId, source, limit });
    // framesJson can be a few hundred KB per video artifact - the list view only needs enough
    // to render a card (thumbnail/title/meta), not the raw frame data.
    const stripped = items.map(({ framesJson, ...rest }) => ({ ...rest, hasFrames: !!framesJson }));
    res.json(createApiResponse(stripped));
  } catch (error) {
    next(error);
  }
});

artifactsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = parseInt(req.params["id"] ?? "0", 10);
    const artifact = await db.getArtifact(id);
    if (!artifact) {
      res.status(404).json(createApiError("Artifact not found"));
      return;
    }
    const { framesJson, ...rest } = artifact;
    res.json(createApiResponse({ ...rest, hasFrames: !!framesJson }));
  } catch (error) {
    next(error);
  }
});

artifactsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = parseInt(req.params["id"] ?? "0", 10);
    const artifact = await db.getArtifact(id);
    if (!artifact) {
      res.status(404).json(createApiError("Artifact not found"));
      return;
    }
    removeArtifactFile(artifact.path);
    await db.deleteArtifact(id);
    res.json(createApiResponse({ deleted: true, id }));
  } catch (error) {
    next(error);
  }
});
