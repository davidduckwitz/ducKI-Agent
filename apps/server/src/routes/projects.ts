import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CODING_ROOT } from "./coding.js";

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

projectsRouter.get("/:id/dependencies", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const projectId = parseInt(req.params["id"] ?? "0");
    const project = await db.getProject(projectId);
    if (!project) { res.status(404).json(createApiError("Project not found")); return; }
    const dependencies = await db.getProjectDependencies(projectId);
    res.json(createApiResponse(dependencies));
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
    const db = req.app.locals["db"] as DatabaseService;
    const projectId = parseInt(req.params["id"] ?? "0");
    const project = await db.getProject(projectId);
    if (!project) { res.status(404).json(createApiError("Project not found")); return; }

    const options = req.body as {
      deleteCodingFolder?: boolean;
      deleteConversations?: boolean;
      deleteTasks?: boolean;
      deleteWorkflows?: boolean;
    } | undefined;

    await db.deleteProject(projectId, options);

    if (options?.deleteCodingFolder) {
      const projectSlug = project.name.toLowerCase().replace(/\s+/g, "-");
      const projectPath = resolve(CODING_ROOT, projectSlug);
      try {
        await rm(projectPath, { recursive: true, force: true });
      } catch (err) {
        console.error("Failed to delete project folder:", err);
      }
    }

    res.json(createApiResponse({ deleted: true }));
  } catch (e) { next(e); }
});



