import { Router, type IRouter } from "express";
import type { WorkflowEngine, WorkflowGraph, MultiAgentRole } from "@ducki/agent";
import { createApiError, createApiResponse } from "@ducki/shared";

export const workflowsRouter: IRouter = Router();

function workflowFromBody(body: unknown): Partial<WorkflowGraph> {
  if (!body || typeof body !== "object") return {};
  return body as Partial<WorkflowGraph>;
}

function newId(): string {
  return `wf_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

workflowsRouter.get("/", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const workflows = await workflowEngine.listWorkflows();
    res.json(createApiResponse(workflows));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.get("/:id", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const workflow = await workflowEngine.getWorkflow(req.params["id"] ?? "");
    if (!workflow) {
      res.status(404).json(createApiError("Workflow not found"));
      return;
    }
    res.json(createApiResponse(workflow));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.post("/", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const body = workflowFromBody(req.body);
    const id = body.id ?? newId();
    const name = body.name?.trim();

    if (!name) {
      res.status(400).json(createApiError("Workflow name is required"));
      return;
    }

    const workflow = await workflowEngine.saveWorkflow({
      id,
      name,
      goal: body.goal ?? "",
      status: body.status ?? "draft",
      nodes: body.nodes ?? [
        {
          id: "node_1",
          title: "Initial Planning",
          role: "manager" satisfies MultiAgentRole,
          prompt: "Define the initial plan and milestones for this workflow.",
          status: "pending",
          dependsOn: [],
          position: { x: 120, y: 120 },
        },
      ],
      edges: body.edges ?? [],
    });

    res.status(201).json(createApiResponse(workflow));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.put("/:id", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const body = workflowFromBody(req.body);
    const id = req.params["id"] ?? "";

    const existing = await workflowEngine.getWorkflow(id);
    if (!existing) {
      res.status(404).json(createApiError("Workflow not found"));
      return;
    }

    const workflow = await workflowEngine.saveWorkflow({
      ...existing,
      ...body,
      id,
      name: body.name?.trim() || existing.name,
    });

    res.json(createApiResponse(workflow));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.post("/:id/run", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const summary = await workflowEngine.runWorkflow(req.params["id"] ?? "");
    res.json(createApiResponse(summary));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    const summary = await workflowEngine.resumeWorkflow(req.params["id"] ?? "");
    res.json(createApiResponse(summary));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.delete("/:id", async (req, res, next) => {
  try {
    const workflowEngine = req.app.locals["workflowEngine"] as WorkflowEngine;
    await workflowEngine.deleteWorkflow(req.params["id"] ?? "");
    res.json(createApiResponse({ deleted: true }));
  } catch (error) {
    next(error);
  }
});
