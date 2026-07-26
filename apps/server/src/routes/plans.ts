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

interface ExecutePlanBody {
  goal?: string;
  steps?: Array<{ title?: string; description?: string; tools?: string[] }>;
  markdown?: string;
  conversationId?: number;
}

/**
 * Execute a plan: hands the agent the plan's actual goal and steps, then runs it on the
 * originating conversation so the execution continues the same thread the plan was
 * created in. The plan content travels in the request body because plans are not
 * persisted server-side yet - the id alone identifies nothing the agent could resolve.
 */
plansRouter.post("/:id/execute", async (req, res, next) => {
  try {
    const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
    const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);

    if (!agent) {
      res.status(500).json(createApiError("Agent not available"));
      return;
    }

    const body = (req.body ?? {}) as ExecutePlanBody;
    const rawId = Number(req.params.id);
    const planId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;

    const goal = String(body.goal ?? "").trim();
    const steps = (Array.isArray(body.steps) ? body.steps : [])
      .map((step) => ({
        title: String(step?.title ?? "").trim(),
        description: String(step?.description ?? "").trim(),
        tools: Array.isArray(step?.tools) ? step.tools.map(String) : [],
      }))
      .filter((step) => step.title.length > 0);

    if (!goal) {
      res.status(400).json(createApiError("goal is required to execute a plan"));
      return;
    }
    if (steps.length === 0) {
      res.status(400).json(createApiError("steps is required and must contain at least one step"));
      return;
    }

    const stepList = steps
      .map((step, index) => {
        const toolHint = step.tools.length > 0 ? `\n   Vorgeschlagene Tools: ${step.tools.join(", ")}` : "";
        const description = step.description ? `\n   ${step.description}` : "";
        return `${index + 1}. ${step.title}${description}${toolHint}`;
      })
      .join("\n");

    const executionPrompt = [
      "**PLAN-AUSFÜHRUNG**",
      "",
      "Setze den folgenden, bereits vom Nutzer bestätigten Plan jetzt tatsächlich um.",
      "",
      `ZIEL: ${goal}`,
      "",
      "SCHRITTE:",
      stepList,
      "",
      "ARBEITSWEISE:",
      "- Arbeite die Schritte in der angegebenen Reihenfolge ab und respektiere Abhängigkeiten.",
      "- Führe pro Schritt die tatsächlich nötigen Tools aus; erfinde keine Ergebnisse.",
      "- Prüfe nach jedem Schritt das Resultat. Bei Fehlern: Ursache aus der echten Fehlermeldung ableiten und maximal 3x gezielt neu versuchen.",
      "- Wenn ein Schritt endgültig scheitert, brich ab und melde, welche Schritte fertig sind und welcher blockiert.",
      "- Abschließend: kurze Zusammenfassung pro Schritt (erledigt / übersprungen / fehlgeschlagen) inklusive Verifikation.",
    ].join("\n");

    if (body.conversationId && Number.isFinite(body.conversationId)) {
      await agent.loadConversation(body.conversationId);
    }

    const result = await agent.run(executionPrompt);

    res.json(createApiResponse({
      message: "Plan execution finished",
      planId,
      executionResult: result,
    }));
  } catch (error) {
    next(error);
  }
});
