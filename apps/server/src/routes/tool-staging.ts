import { Router, type Request, type Response } from "express";
import { getToolStagingManager } from "../lib/tool-staging/index.js";

export function createToolStagingRouter(): Router {
  const router = Router();
  const stagingManager = getToolStagingManager();

  if (!stagingManager) {
    return router;
  }

  /**
   * GET /api/tool-staging/:id
   * Retrieve staged tool response by ID
   */
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      if (!id) {
        return res.status(400).json({ error: "ID is required" });
      }
      const staged = await stagingManager.getStagedResponse(id);

      if (!staged) {
        return res.status(404).json({
          error: "Staged response not found",
          id,
        });
      }

      res.json({
        id: staged.id,
        toolName: staged.toolName,
        summary: staged.summary,
        content: staged.content,
        createdAt: staged.createdAt,
        expiresAt: staged.expiresAt,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * DELETE /api/tool-staging/:id
   * Delete staged response (after analysis)
   */
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      if (!id) {
        return res.status(400).json({ error: "ID is required" });
      }
      const deleted = await stagingManager.deleteStaged(id);

      if (!deleted) {
        return res.status(404).json({
          error: "Staged response not found",
          id,
        });
      }

      res.json({
        success: true,
        id,
        message: "Staged response deleted",
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/tool-staging
   * List all staged responses (debugging)
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const files = await stagingManager.listStaged();
      res.json({
        count: files.length,
        files,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
