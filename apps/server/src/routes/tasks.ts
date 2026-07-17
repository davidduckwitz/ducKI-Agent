import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";

export const tasksRouter: IRouter = Router();

tasksRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const projectId = req.query["projectId"] ? parseInt(req.query["projectId"] as string) : undefined;
    res.json(createApiResponse(await db.listTasks(projectId)));
  } catch (e) { next(e); }
});

tasksRouter.post("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const { title, description, priority, projectId } = req.body as { title: string; description?: string; priority?: string; projectId?: number };
    if (!title) { res.status(400).json(createApiError("Title is required")); return; }
    const task = await db.createTask({ title, description, priority: (priority ?? "medium") as "low" | "medium" | "high" | "critical", status: "pending", projectId });
    res.status(201).json(createApiResponse(task));
  } catch (e) { next(e); }
});

tasksRouter.get("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const task = await db.getTask(parseInt(req.params["id"] ?? "0"));
    if (!task) { res.status(404).json(createApiError("Task not found")); return; }
    res.json(createApiResponse(task));
  } catch (e) { next(e); }
});

tasksRouter.patch("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const task = await db.updateTask(parseInt(req.params["id"] ?? "0"), req.body as Record<string, unknown>);
    if (!task) { res.status(404).json(createApiError("Task not found")); return; }
    res.json(createApiResponse(task));
  } catch (e) { next(e); }
});

tasksRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    await db.deleteTask(parseInt(req.params["id"] ?? "0"));
    res.json(createApiResponse({ deleted: true }));
  } catch (e) { next(e); }
});

tasksRouter.post("/:id/run", async (req, res, next) => {
  const taskId = parseInt(req.params["id"] ?? "0");
  if (!Number.isFinite(taskId) || taskId <= 0) {
    res.status(400).json(createApiError("Invalid task id"));
    return;
  }

  const db = req.app.locals["db"] as DatabaseService;
  const agentRegistry = req.app.locals["agentRegistry"] as {
    register: (entry: { source: "chat_http" | "chat_ws" | "task_run"; conversationId?: number; taskId?: number; socketId?: string; label?: string }) => string;
    unregister: (id: string) => void;
  };
  const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
  const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
  let runId: string | undefined;

  try {
    const task = await db.getTask(taskId);
    if (!task) {
      res.status(404).json(createApiError("Task not found"));
      return;
    }

    await db.updateTask(taskId, { status: "running" });

    const prompt = [
      "Execute this tracked task and return what you did and the concrete result:",
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : "Description: (none)",
      `Priority: ${task.priority}`,
      "Use tools where necessary. Keep the final result concise and actionable.",
    ].join("\n");

    let conversationId: number;
    if (task.projectId) {
      conversationId = await agent.startConversation({
        name: `Task Run #${taskId}`,
        projectId: task.projectId,
      });
    } else {
      conversationId = await agent.startConversation({ name: `Task Run #${taskId}` });
    }

    runId = agentRegistry.register({
      source: "task_run",
      taskId,
      conversationId,
      label: `Task #${taskId}`,
    });

    const runResult = await agent.run(prompt);
    const updated = await db.updateTask(taskId, {
      status: "completed",
      result: runResult.response,
    });

    res.json(createApiResponse({ task: updated, run: runResult }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateTask(taskId, { status: "failed", result: message });
    next(error);
  } finally {
    if (runId) agentRegistry.unregister(runId);
  }
});



