import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import { createApiResponse, createApiError } from "@ducki/shared";
import { parseMarkdownToPlan } from "@ducki/planer";

export const plansRouter: IRouter = Router();

plansRouter.get("/", async (req, res, next) => {
  try {
    res.json(createApiResponse([]));
  } catch (error) {
    next(error);
  }
});

/**
 * Import plan from markdown: parses markdown text into a plan object
 * MUST be BEFORE /:id routes to avoid being matched as :id parameter
 */
plansRouter.post("/import/markdown", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const markdown = body.markdown as string;

    if (!markdown || typeof markdown !== "string") {
      res.status(400).json(createApiError("markdown is required and must be a string"));
      return;
    }

    const plan = parseMarkdownToPlan(markdown);
    if (!plan) {
      res.status(400).json(createApiError("Invalid markdown format. Must have heading, complexity, and at least one step."));
      return;
    }

    res.json(createApiResponse(plan));
  } catch (error) {
    next(error);
  }
});

plansRouter.get("/:id", async (req, res, next) => {
  try {
    res.status(404).json(createApiError("Plan not found"));
  } catch (error) {
    next(error);
  }
});

plansRouter.post("/", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body.goal) {
      res.status(400).json(createApiError("goal is required"));
      return;
    }
    const mockPlan = {
      id: 1,
      ...body,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    res.json(createApiResponse(mockPlan));
  } catch (error) {
    next(error);
  }
});

plansRouter.patch("/:id", async (req, res, next) => {
  try {
    res.status(404).json(createApiError("Plan not found"));
  } catch (error) {
    next(error);
  }
});

plansRouter.delete("/:id", async (req, res, next) => {
  try {
    res.status(404).json(createApiError("Plan not found"));
  } catch (error) {
    next(error);
  }
});

/**
 * Execute a plan: creates project, workflow, and tasks from plan structure,
 * then runs them iteratively with LLM validation and progress tracking
 */
plansRouter.post("/:id/execute", async (req, res, next) => {
  try {
    const agent = req.app.locals["agent"] as Agent;
    const conversationId = (req.body as { conversationId?: number }).conversationId;

    if (!agent) {
      res.status(500).json(createApiError("Agent not available"));
      return;
    }

    const planId = Number(req.params.id);
    if (!Number.isFinite(planId) || planId <= 0) {
      res.status(400).json(createApiError("Invalid plan ID"));
      return;
    }

    const executionPrompt = `
**PLAN-AUSFÜHRUNG - STRUKTURIERT**

Deine Aufgabe ist es, einen geplanten Workflow komplett abzuarbeiten.

SCHRITTE (MANDATORY):
1. **PROJEKT ERSTELLEN**: Erstelle ein Projekt mit Status "executing"
2. **WORKFLOW ERSTELLEN**: Für jeden Plan-Schritt einen Workflow-Node
3. **TASKS ERSTELLEN**: Für jeden Schritt eine Task mit konkretem Ziel
4. **AUSFÜHRUNG STARTEN**:
   - Führe Tasks der Reihe nach aus
   - Nach jedem Task: Prüfe Erfolg/Fehler
   - Bei Fehler: Retry bis zu 3x
5. **PROGRESS TRACKING**: Nach jedem Task den Progress anzeigen
6. **VALIDIERUNG**: Am Ende alle Results kontrollieren
7. **FINALISIERUNG**: Projekt auf "completed" setzen

KONTEXT:
- Plan ID: ${planId}
- Conversation: ${conversationId || "keine"}
- Timeout: 30 Minuten max
- Retry: 3 Versuche pro Task

WICHTIG:
- Nutze /create-project, /create-workflow, /create-task Tools
- Nach jedem Schritt Status melden
- Bei Fehler: Fehlerdetails anzeigen und neu versuchen
- Abbruch nur bei kritischen Fehlern

Starte jetzt mit: PROJEKT ERSTELLEN`;

    const result = await agent.run(executionPrompt);

    res.json(createApiResponse({
      message: "Plan execution started",
      planId,
      executionResult: result,
    }));
  } catch (error) {
    next(error);
  }
});
