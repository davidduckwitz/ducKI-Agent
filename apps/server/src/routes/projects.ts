import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";

export const projectsRouter: IRouter = Router();

projectsRouter.get("/", async (req, res, next) => {
  try { res.json(createApiResponse(await (req.app.locals["db"] as DatabaseService).listProjects())); } catch (e) { next(e); }
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const { name, description, folder } = req.body as { name: string; description?: string; folder?: string };
    if (!name) { res.status(400).json(createApiError("Name is required")); return; }
    res.status(201).json(createApiResponse(await db.createProject({ name, description, folder })));
  } catch (e) { next(e); }
});

projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await (req.app.locals["db"] as DatabaseService).getProject(parseInt(req.params["id"] ?? "0"));
    if (!project) { res.status(404).json(createApiError("Project not found")); return; }
    res.json(createApiResponse(project));
  } catch (e) { next(e); }
});

projectsRouter.patch("/:id", async (req, res, next) => {
  try {
    const project = await (req.app.locals["db"] as DatabaseService).updateProject(parseInt(req.params["id"] ?? "0"), req.body as Record<string, unknown>);
    if (!project) { res.status(404).json(createApiError("Project not found")); return; }
    res.json(createApiResponse(project));
  } catch (e) { next(e); }
});

projectsRouter.delete("/:id", async (req, res, next) => {
  try {
    await (req.app.locals["db"] as DatabaseService).deleteProject(parseInt(req.params["id"] ?? "0"));
    res.json(createApiResponse({ deleted: true }));
  } catch (e) { next(e); }
});



