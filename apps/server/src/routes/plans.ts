import { Router, type IRouter } from "express";
import { resolve } from "node:path";
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
  projectId?: number;
}

interface ProjectData {
  id: number;
  name: string;
  folder?: string;
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
    const createCodingAgent = req.app.locals["createCodingAgent"] as
      | ((options?: { sandboxRoot?: string }) => import("@ducki/agent").CodingAgent)
      | undefined;
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService | undefined;
    const io = req.app.locals["io"] as import("socket.io").Server | undefined;

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

    // Check if this is a coding project
    let projectSandboxInfo = "";
    if (body.projectId && db) {
      try {
        const project = await db.getProject(body.projectId) as ProjectData | null;
        if (project) {
          const projectSlug = project.name.toLowerCase().replace(/\s+/g, "-");
          const sandboxRoot = resolve("./shared-workspace/coding", projectSlug);
          projectSandboxInfo = `\n\nPROJEKT-VERZEICHNIS: ${sandboxRoot}\nAlle Dateipfade sind relativ zu diesem Verzeichnis.`;
        }
      } catch {
        // Silently ignore project lookup errors
      }
    }

    const executionPrompt = [
      "**PLAN-AUSFÜHRUNG**",
      "",
      "Setze den folgenden, bereits vom Nutzer bestätigten Plan jetzt tatsächlich um.",
      "",
      `ZIEL: ${goal}`,
      projectSandboxInfo,
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
      "",
      "WICHTIG für Dateien:",
      "- Nutze ECHTE Newlines in Dateiinhalten, NICHT escaped Strings wie \\n",
      "- Schreibe mehrzeilige Inhalte mit echter Zeilenumbruch, z.B. im filesystem-Tool action:write",
    ].join("\n");

    // Return immediately - execution happens asynchronously with WebSocket updates
    if (!body.conversationId || !Number.isFinite(body.conversationId)) {
      res.status(400).json(createApiError("conversationId is required for plan execution"));
      return;
    }

    const conversationId = body.conversationId;

    // Start async execution - don't wait for it
    (async () => {
      try {
        if (body.projectId && createCodingAgent && db) {
          // Use CodingAgent for projects but with the same conversation + execution prompt
          try {
            const project = await db.getProject(body.projectId) as ProjectData | null;
            if (project) {
              const projectSlug = project.name.toLowerCase().replace(/\s+/g, "-");
              const sandboxRoot = resolve("./shared-workspace/coding", projectSlug);
              const codingAgent = createCodingAgent({ sandboxRoot });
              await codingAgent.loadConversation(conversationId);

              // Emit start event
              if (io) {
                io.emit("chat:start", { timestamp: new Date().toISOString(), conversationId });
              }

              const result = await codingAgent.runOnExistingConversation(executionPrompt, {
                stream: true,
                onChunk: (chunk) => {
                  io?.emit("chat:chunk", { content: chunk, conversationId });
                },
                onEvent: (event) => {
                  io?.emit("chat:event", { ...event, conversationId });
                },
              });

              // Emit completion event
              if (io) {
                io.emit("chat:complete", {
                  response: `Plan execution finished.\n\n${result.response}`,
                  conversationId
                });
              }
              return;
            }
          } catch (projectError) {
            console.warn("Could not load project for plan execution, falling back to regular agent:", projectError);
          }
        }

        // Fallback to regular agent
        const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
        if (!agent) {
          throw new Error("Agent not available");
        }

        await agent.loadConversation(conversationId);

        // Emit start event
        if (io) {
          io.emit("chat:start", { timestamp: new Date().toISOString(), conversationId });
        }

        const result = await agent.run(executionPrompt, {
          stream: true,
          onChunk: (chunk) => {
            io?.emit("chat:chunk", { content: chunk, conversationId });
          },
          onEvent: (event) => {
            io?.emit("chat:event", { ...event, conversationId });
          },
        });

        // Emit completion event
        if (io) {
          io.emit("chat:complete", {
            response: result.response,
            conversationId
          });
        }
      } catch (error) {
        console.error("Plan execution error:", error);
        if (io) {
          io.emit("chat:error", {
            error: error instanceof Error ? error.message : String(error),
            conversationId,
          });
        }
      }
    })().catch(console.error);

    // Return immediately
    res.json(createApiResponse({
      message: "Plan execution started",
      planId,
    }));
  } catch (error) {
    next(error);
  }
});
