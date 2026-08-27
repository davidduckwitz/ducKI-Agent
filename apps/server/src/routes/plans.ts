import { Router, type IRouter } from "express";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Agent, AgentRunResult, Plan, PlanStep } from "@ducki/agent";
import { formatPlanAsMarkdown, Planner } from "@ducki/agent";
import { createApiResponse, createApiError } from "@ducki/shared";
import { parseMarkdownToPlan } from "@ducki/planer";
import { CODING_WORKSPACE_ROOT } from "@ducki/tools";
import { getRootLogger } from "@ducki/logger";
import { notifyCodingRunFinished } from "../lib/coding-notify.js";

export const plansRouter: IRouter = Router();

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function presentPlan(row: import("@ducki/database").PlanSelect) {
  return {
    ...row,
    steps: parseJson<PlanStep[]>(row.steps, []),
    tools: parseJson<string[]>(row.tools, []),
    repositorySnapshot: parseJson<Record<string, unknown> | null>(row.repositorySnapshot, null),
  };
}

/** Validates and normalizes the loosely-typed `plan` field a client sends back (its own copy of
 *  a Plan object round-tripped through JSON) into what the Planner expects. */
function coercePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["goal"] !== "string" || !Array.isArray(obj["steps"])) return null;
  return obj as unknown as Plan;
}

/**
 * Proposes up to 3 clarifying questions for a plan (the "Plan verbessern" dialog's structured
 * question flow) - a Single-Shot Planner call, not a chat round-trip. MUST be BEFORE /:id
 * routes, same reason as /import/markdown above.
 */
plansRouter.post("/questions", async (req, res, next) => {
  try {
    const provider = req.app.locals["provider"] as import("@ducki/providers").LLMProvider | undefined;
    if (!provider) {
      res.status(500).json(createApiError("LLM provider is not configured"));
      return;
    }
    const plan = coercePlan((req.body as Record<string, unknown>)?.["plan"]);
    if (!plan) {
      res.status(400).json(createApiError("plan is required (an object with goal + steps)"));
      return;
    }
    const planner = new Planner(provider, getRootLogger().child("PlanQuestions"));
    const questions = await planner.suggestClarifyingQuestions(plan);
    res.json(createApiResponse({ questions }));
  } catch (error) {
    next(error);
  }
});

/**
 * Refines a plan deterministically via the Planner - no chat round-trip, no dependence on the
 * model choosing to call a tool. Returns the new plan synchronously, same shape as
 * /import/markdown. MUST be BEFORE /:id routes, same reason as above.
 */
plansRouter.post("/refine", async (req, res, next) => {
  try {
    const provider = req.app.locals["provider"] as import("@ducki/providers").LLMProvider | undefined;
    if (!provider) {
      res.status(500).json(createApiError("LLM provider is not configured"));
      return;
    }
    const body = req.body as Record<string, unknown>;
    const plan = coercePlan(body["plan"]);
    const feedback = String(body["feedback"] ?? "").trim();
    if (!plan) {
      res.status(400).json(createApiError("plan is required (an object with goal + steps)"));
      return;
    }
    if (!feedback) {
      res.status(400).json(createApiError("feedback is required"));
      return;
    }
    const planner = new Planner(provider, getRootLogger().child("PlanRefine"));
    const refined = await planner.refinePlan(plan, feedback);
    const markdown = formatPlanAsMarkdown(refined);
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService | undefined;
    const sourceId = Number((body["plan"] as Record<string, unknown>)?.["id"]);
    const sourceVersion = Number((body["plan"] as Record<string, unknown>)?.["version"] ?? 1);
    const saved = db ? await db.createPlan({
      conversationId: Number.isFinite(Number((body["plan"] as Record<string, unknown>)?.["conversationId"])) ? Number((body["plan"] as Record<string, unknown>)["conversationId"]) : null,
      projectId: Number.isFinite(Number((body["plan"] as Record<string, unknown>)?.["projectId"])) ? Number((body["plan"] as Record<string, unknown>)["projectId"]) : null,
      goal: refined.goal,
      title: String((body["plan"] as Record<string, unknown>)?.["title"] ?? refined.goal).slice(0, 200),
      complexity: refined.estimatedComplexity === "high" ? 5 : refined.estimatedComplexity === "medium" ? 3 : 1,
      steps: JSON.stringify(refined.steps),
      tools: JSON.stringify([...new Set(refined.steps.flatMap((step) => step.toolsNeeded ?? []))]),
      markdown,
      status: "draft",
      version: Number.isFinite(sourceVersion) ? sourceVersion + 1 : 2,
      parentPlanId: Number.isFinite(sourceId) ? sourceId : null,
      repositorySnapshot: typeof (body["plan"] as Record<string, unknown>)?.["repositorySnapshot"] === "object" ? JSON.stringify((body["plan"] as Record<string, unknown>)["repositorySnapshot"]) : null,
    }) : null;
    res.json(createApiResponse({ plan: saved ? { ...refined, ...presentPlan(saved) } : refined, markdown }));
  } catch (error) {
    next(error);
  }
});

plansRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService;
    const conversationId = Number(req.query.conversationId);
    const projectId = Number(req.query.projectId);
    const rows = await db.listPlans({
      ...(Number.isFinite(conversationId) ? { conversationId } : {}),
      ...(Number.isFinite(projectId) ? { projectId } : {}),
    });
    res.json(createApiResponse(rows.map(presentPlan)));
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
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService;
    const row = await db.getPlan(Number(req.params.id));
    if (!row) return void res.status(404).json(createApiError("Plan not found"));
    const runs = await db.listPlanRuns(row.id);
    res.json(createApiResponse({ ...presentPlan(row), runs: runs.map((run) => ({ ...run, result: parseJson(run.result, null) })) }));
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
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService;
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const row = await db.createPlan({
      conversationId: Number.isFinite(Number(body.conversationId)) ? Number(body.conversationId) : null,
      projectId: Number.isFinite(Number(body.projectId)) ? Number(body.projectId) : null,
      goal: String(body.goal), title: typeof body.title === "string" ? body.title : String(body.goal).slice(0, 200),
      complexity: Number.isFinite(Number(body.complexity)) ? Number(body.complexity) : null,
      steps: JSON.stringify(steps), tools: JSON.stringify(Array.isArray(body.tools) ? body.tools : []),
      markdown: typeof body.markdown === "string" ? body.markdown : null, status: "draft", version: 1,
      parentPlanId: null, repositorySnapshot: body.repositorySnapshot ? JSON.stringify(body.repositorySnapshot) : null,
    });
    res.status(201).json(createApiResponse(presentPlan(row)));
  } catch (error) {
    next(error);
  }
});

plansRouter.patch("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService;
    const body = req.body as Record<string, unknown>;
    const row = await db.updatePlan(Number(req.params.id), {
      ...(typeof body.status === "string" ? { status: body.status } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(Array.isArray(body.steps) ? { steps: JSON.stringify(body.steps) } : {}),
      ...(typeof body.markdown === "string" ? { markdown: body.markdown } : {}),
    });
    if (!row) return void res.status(404).json(createApiError("Plan not found"));
    res.json(createApiResponse(presentPlan(row)));
  } catch (error) {
    next(error);
  }
});

plansRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService;
    const id = Number(req.params.id);
    const deleted = await db.deletePlan(id);
    if (!deleted) return void res.status(404).json(createApiError("Plan not found"));
    res.json(createApiResponse({ deleted, id }));
  } catch (error) {
    next(error);
  }
});

interface ExecutePlanBody {
  goal?: string;
  steps?: Array<Partial<PlanStep> & { tools?: string[] }>;
  markdown?: string;
  conversationId?: number;
  projectId?: number;
  /** Coding project slug (folder name) — resolves the sandbox without a numeric DB id. */
  projectSlug?: string;
}

/** Sanitize a slug to a safe single-segment folder name (no traversal). */
function safeProjectSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
    const createAgent = req.app.locals["createAgent"] as (() => Promise<Agent>) | undefined;
    const createCodingAgent = req.app.locals["createCodingAgent"] as
      | ((options?: { sandboxRoot?: string; eventEmitter?: import("@ducki/agent").AgentEventEmitter }) => import("@ducki/agent").CodingAgent)
      | undefined;
    const db = req.app.locals["db"] as import("@ducki/database").DatabaseService | undefined;
    const io = req.app.locals["io"] as import("socket.io").Server | undefined;

    // Execution-mode settings: how this specific plan run behaves, distinct from the
    // agent-wide defaults (a plan the user just confirmed executing deserves its own,
    // possibly stricter/longer, budget).
    const getBoolSetting = async (key: string, fallback: boolean): Promise<boolean> => {
      const raw = await db?.getSetting(key);
      if (raw === undefined || raw === null || raw.trim().length === 0) return fallback;
      return raw.toLowerCase() !== "false";
    };
    const getNumberSetting = async (key: string, fallback: number): Promise<number> => {
      const raw = await db?.getSetting(key);
      const parsed = raw !== undefined ? Number(raw) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const autoCreateProject = await getBoolSetting("EXECUTION_MODE_AUTO_CREATE_PROJECT", true);
    const maxRetries = Math.max(1, await getNumberSetting("EXECUTION_MODE_MAX_RETRIES", 3));
    const timeoutMinutes = await getNumberSetting("EXECUTION_MODE_TIMEOUT_MINUTES", 30);
    const updatePlanFile = await getBoolSetting("EXECUTION_MODE_UPDATE_PLAN_FILE", true);
    const markdownDir = ((await db?.getSetting("PLAN_MODE_MARKDOWN_PATH"))?.trim()) || "plans";

    const body = (req.body ?? {}) as ExecutePlanBody;
    const rawId = Number(req.params.id);
    let planId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;

    const goal = String(body.goal ?? "").trim();
    const steps = (Array.isArray(body.steps) ? body.steps : [])
      .map((step, index) => ({
        id: typeof step?.id === "string" && step.id ? step.id : `step_${index + 1}`,
        title: String(step?.title ?? "").trim(),
        description: String(step?.description ?? "").trim(),
        toolsNeeded: Array.isArray(step?.toolsNeeded) ? step.toolsNeeded.map(String) : Array.isArray(step?.tools) ? step.tools.map(String) : [],
        dependsOn: Array.isArray(step?.dependsOn) ? step.dependsOn.map(String) : [],
        canParallelizeWith: Array.isArray(step?.canParallelizeWith) ? step.canParallelizeWith.map(String) : [],
        expectedFiles: Array.isArray(step?.expectedFiles) ? step.expectedFiles.map(String) : [],
        acceptanceCriteria: Array.isArray(step?.acceptanceCriteria) ? step.acceptanceCriteria.map(String) : [],
        verificationCommands: Array.isArray(step?.verificationCommands) ? step.verificationCommands.map(String) : [],
        priority: step?.priority ?? "medium",
        riskLevel: step?.riskLevel,
        estimatedDuration: step?.estimatedDuration,
        status: step?.status === "completed" || step?.status === "failed" || step?.status === "running" ? step.status : "pending",
        result: typeof step?.result === "string" ? step.result : undefined,
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
        const toolHint = step.toolsNeeded.length > 0 ? `\n   Suggested tools: ${step.toolsNeeded.join(", ")}` : "";
        const description = step.description ? `\n   ${step.description}` : "";
        return `${index + 1}. ${step.title}${description}${toolHint}`;
      })
      .join("\n");

    // Resolve the coding sandbox from either a numeric project id (DB) or a slug
    // (coding projects are folder/slug based and have no numeric id). Either way we
    // end up with a sandbox root the CodingAgent can be scoped to.
    let codingSandboxRoot: string | undefined;
    let codingProjectDbId: number | undefined;
    if (body.projectId && db) {
      try {
        const project = await db.getProject(body.projectId) as ProjectData | null;
        if (project) {
          const projectSlug = safeProjectSlug(project.name);
          codingSandboxRoot = resolve(CODING_WORKSPACE_ROOT, projectSlug);
          codingProjectDbId = project.id;
        }
      } catch {
        // Silently ignore project lookup errors
      }
    }
    if (!codingSandboxRoot && body.projectSlug) {
      const slug = safeProjectSlug(String(body.projectSlug));
      if (slug) codingSandboxRoot = resolve(CODING_WORKSPACE_ROOT, slug);
    }
    // EXECUTION_MODE_AUTO_CREATE_PROJECT: no project was given at all - create a fresh
    // coding sandbox from the goal so a plan executed without a pre-selected project still
    // has somewhere to write files, instead of falling back to the general (unscoped) agent.
    if (!codingSandboxRoot && autoCreateProject) {
      const slug = safeProjectSlug(goal) || `plan-${Date.now()}`;
      const candidateRoot = resolve(CODING_WORKSPACE_ROOT, slug);
      try {
        if (!existsSync(candidateRoot)) mkdirSync(candidateRoot, { recursive: true });
        codingSandboxRoot = candidateRoot;
      } catch {
        // Non-critical - falls through to the general agent below.
      }
    }
    const projectSandboxInfo = codingSandboxRoot
      ? `\n\nPROJECT DIRECTORY: ${codingSandboxRoot}\nAll file paths are relative to this directory.`
      : "";

    // Build a structured Plan directly from the UI's already-approved steps, so the agent
    // uses THIS plan instead of silently re-deriving its own via the internal Planner (which
    // otherwise always ran a fresh LLM call against the flattened prompt text below, ignoring
    // the exact steps the user already reviewed). Passing it also switches the run loop into
    // per-step checklist tracking (see AgentRunOptions.existingPlan), so a step that keeps
    // failing gets a bounded number of repair attempts instead of retrying indefinitely.
    const existingPlan: Plan = {
      goal,
      planType: codingSandboxRoot ? "coding" : "general",
      steps: steps.map((step, index): PlanStep => ({
        ...step,
        id: step.id || `step_${index + 1}`,
        status: step.status === "completed" ? "completed" : "pending",
      })),
      // Not used for gating here (a caller-supplied plan always gets checklist tracking
      // regardless of complexity, see AgentRunOptions.existingPlan) - just a reasonable
      // default since the field is required and nothing else estimates it for this plan.
      estimatedComplexity: "high",
      totalSteps: steps.length,
    };

    const executionPrompt = [
      "**PLAN EXECUTION**",
      "",
      "Now actually carry out the following plan, which the user has already confirmed.",
      "",
      `GOAL: ${goal}`,
      projectSandboxInfo,
      "",
      "STEPS:",
      stepList,
      "",
      "HOW TO WORK:",
      "- Work through the steps in the given order and respect dependencies.",
      "- For each step, run the tools actually needed; do not fabricate results.",
      "- Check the result after each step. On errors: derive the cause from the real error message and retry in a targeted way at most 3 times.",
      "- If a step ultimately fails, stop and report which steps are done and which one is blocked.",
      "- Finally: a short summary per step (done / skipped / failed) including verification.",
      "",
      "IMPORTANT for files:",
      "- Use REAL newlines in file contents, NOT escaped strings like \\n",
      "- Write multi-line content with real line breaks, e.g. in the filesystem tool action:write",
    ].join("\n");

    // Return immediately - execution happens asynchronously with WebSocket updates
    if (!body.conversationId || !Number.isFinite(body.conversationId)) {
      res.status(400).json(createApiError("conversationId is required for plan execution"));
      return;
    }

    const conversationId = body.conversationId;
    let planVersion = 1;
    if (db) {
      const current = planId ? await db.getPlan(planId) : undefined;
      if (current) {
        planVersion = current.version;
        await db.updatePlan(current.id, { status: "active", conversationId, projectId: codingProjectDbId ?? current.projectId });
      } else {
        const saved = await db.createPlan({
          conversationId,
          projectId: codingProjectDbId ?? null,
          goal,
          title: goal.slice(0, 200),
          complexity: existingPlan.estimatedComplexity === "high" ? 5 : existingPlan.estimatedComplexity === "medium" ? 3 : 1,
          steps: JSON.stringify(existingPlan.steps),
          tools: JSON.stringify([...new Set(existingPlan.steps.flatMap((step) => step.toolsNeeded ?? []))]),
          markdown: body.markdown ?? formatPlanAsMarkdown(existingPlan),
          status: "active",
          version: 1,
          parentPlanId: null,
          repositorySnapshot: null,
        });
        planId = saved.id;
      }
    }
    const runId = randomUUID();
    await db?.createPlanRun({
      id: runId, planId, planVersion, conversationId, projectId: codingProjectDbId ?? null,
      projectSlug: body.projectSlug ?? null, status: "queued", attempt: 1, result: null,
      startedAt: null, finishedAt: null,
    });

    const withRunContext = (event: import("@ducki/agent").AgentRunEvent) => ({
      ...event,
      data: { ...(event.data ?? {}), planId, planVersion, runId },
      conversationId,
    });
    const emitRunState = (status: string, extra: Record<string, unknown> = {}) => {
      const timestamp = new Date().toISOString();
      const data = { plan_event: "run_status", status, planId, planVersion, runId, ...extra };
      io?.emit("chat:event", {
        type: "internal_instruction", message: `Plan run ${status}`,
        data, timestamp, conversationId,
      });
      void db?.addMessage({
        conversationId, role: "event", content: `Plan run ${status}`,
        toolResult: JSON.stringify({ eventType: "internal_instruction", data, timestamp }), createdAt: timestamp,
      }).catch(() => undefined);
    };

    // Writes the plan back to its markdown file with each step's current status checked
    // off (EXECUTION_MODE_UPDATE_PLAN_FILE). Keyed by conversationId so re-executing the
    // same plan on the same conversation updates the same file instead of piling up copies.
    //
    // A CodingAgent run (see below) doesn't produce a checklistRunId - that gating belongs to
    // the Agent.run()-level session checklist, which CodingAgent.run()'s own macro loop
    // (phases/checkpoints/verify-retry, tracked via its todo tool instead) doesn't go through.
    // For that case this falls back to marking every step done/failed from the run's overall
    // success - coarser than per-step, but no regression: the session-checklist path was never
    // reached for a coding sandbox execution anyway once run() replaced runOnExistingConversation.
    const savePlanProgress = async (
      planResult: AgentRunResult | import("@ducki/agent").CodingRunResult,
      executor: Agent | import("@ducki/agent").CodingAgent
    ) => {
      if (!updatePlanFile || !db) return;
      try {
        let updatedPlan: Plan;
        if ("checklistRunId" in planResult && planResult.checklistRunId !== undefined) {
          const items = await db.getChecklist(conversationId, planResult.checklistRunId);
          const statusByTitle = new Map(items.map((item) => [item.title, item.status]));
          updatedPlan = {
            ...existingPlan,
            steps: existingPlan.steps.map((step) => {
              const dbStatus = statusByTitle.get(step.title);
              const status: PlanStep["status"] =
                dbStatus === "done" ? "completed" : dbStatus === "failed" ? "failed" : dbStatus === "in_progress" ? "running" : step.status;
              return { ...step, status };
            }),
          };
        } else if ("verified" in planResult) {
          const status: PlanStep["status"] = planResult.success ? "completed" : "failed";
          updatedPlan = { ...existingPlan, steps: existingPlan.steps.map((step) => ({ ...step, status })) };
        } else {
          return;
        }
        const markdown = formatPlanAsMarkdown(updatedPlan);
        const savePath = `${markdownDir}/plan-${conversationId}.md`;
        await executor.executor.execute("filesystem", { action: "write", path: savePath, content: markdown });
      } catch (error) {
        console.warn("Failed to update plan markdown file with execution progress:", error);
      }
    };

    const timeoutMsOverride = timeoutMinutes * 60 * 1000;
    // EXECUTION_MODE_MAX_RETRIES overrides the checklist's per-step attempt budget for THIS
    // plan run specifically, distinct from the agent-wide AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS
    // default - a plan the user just confirmed executing may warrant a different budget.
    const checklistMaxItemAttemptsOverride = maxRetries;

    // Start async execution - don't wait for it
    (async () => {
      try {
        await db?.updatePlanRun(runId, { status: "running", startedAt: new Date().toISOString() });
        emitRunState("running");
        if (codingSandboxRoot && createCodingAgent) {
          // Use CodingAgent scoped to the resolved sandbox (from projectId OR slug),
          // on the same conversation + execution prompt.
          try {
            const sandboxRoot = codingSandboxRoot;

            // Persist bookkeeping only when we have a real DB project row.
            if (db && codingProjectDbId) {
              await db.updateProject(codingProjectDbId, { folder: sandboxRoot }).catch(() => {
                // Non-critical - execution can proceed even if this bookkeeping write fails.
              });
              const conversation = await db.getConversation(conversationId).catch(() => undefined);
              if (conversation && conversation.projectId !== codingProjectDbId) {
                await db.updateConversation(conversationId, { projectId: codingProjectDbId }).catch(() => {
                  // Non-critical - execution can proceed even if this bookkeeping write fails.
                });
              }
            }

            // Forwards CodingAgent's own events (phases, checkpoints, decisions) onto the same
            // "chat:*" stream the chat UI already listens to - previously this branch called
            // runOnExistingConversation(), which only runs Agent.run() ONCE and skips
            // CodingAgent.run()'s whole macro loop (phases, per-attempt checkpoints, verify-
            // command retry). Routing through run() here makes a plan executed from the UI go
            // through the same discipline as a plan started directly via /api/coding-agent/run.
            const codingEventEmitter: import("@ducki/agent").AgentEventEmitter = {
              emitChunk: (chunk: string) => {
                io?.emit("chat:chunk", { content: chunk, conversationId });
              },
              emitEvent: (event) => {
                io?.emit("chat:event", withRunContext(event));
              },
            };
            const codingAgent = createCodingAgent({ sandboxRoot, eventEmitter: codingEventEmitter });

            // Emit start event
            if (io) {
              io.emit("chat:start", { timestamp: new Date().toISOString(), conversationId });
            }

            const result = await codingAgent.run(executionPrompt, {
              conversationId,
              existingPlan,
              planRunContext: { planId, planVersion, runId },
              maxAttempts: maxRetries,
              timeoutMs: timeoutMsOverride,
            });
            await savePlanProgress(result, codingAgent);
            const terminalStatus = result.success ? "completed" : result.completionStatus === "incomplete" ? "completed_with_warnings" : "failed";
            await db?.updatePlanRun(runId, { status: terminalStatus, result: JSON.stringify(result), finishedAt: new Date().toISOString() });
            const openTitles = new Set(result.completionEvidence?.openChecklistItems ?? []);
            const persistedSteps = existingPlan.steps.map((step) => ({
              ...step,
              status: (openTitles.has(step.title) ? (terminalStatus === "failed" ? "failed" : "pending") : "completed") as PlanStep["status"],
            }));
            if (planId) await db?.updatePlan(planId, { status: result.success ? "completed" : "active", steps: JSON.stringify(persistedSteps) });
            emitRunState(terminalStatus, { completionEvidence: result.completionEvidence, summary: result.summary });
            if (db) notifyCodingRunFinished(db, req.app.locals["logger"] || console, existingPlan.goal.slice(0, 60), result);

            // Emit completion event
            if (io) {
              io.emit("chat:complete", {
                response: `Plan execution finished.\n\n${result.summary}`,
                conversationId
              });
            }
            return;
          } catch (projectError) {
            console.warn("Could not run coding agent for plan execution, falling back to regular agent:", projectError);
          }
        }

        // Fallback to regular agent
        const agent = createAgent ? await createAgent() : (req.app.locals["agent"] as Agent);
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
          existingPlan,
          timeoutMsOverride,
          checklistMaxItemAttemptsOverride,
          onChunk: (chunk) => {
            io?.emit("chat:chunk", { content: chunk, conversationId });
          },
            onEvent: (event) => {
              io?.emit("chat:event", withRunContext(event));
          },
        });
        await savePlanProgress(result, agent);
        const terminalStatus = result.abortedReason ? "failed" : "completed";
        await db?.updatePlanRun(runId, { status: terminalStatus, result: JSON.stringify(result), finishedAt: new Date().toISOString() });
        if (planId) await db?.updatePlan(planId, { status: terminalStatus === "completed" ? "completed" : "active" });
        emitRunState(terminalStatus, { response: result.response });

        // Emit completion event
        if (io) {
          io.emit("chat:complete", {
            response: result.response,
            conversationId
          });
        }
      } catch (error) {
        console.error("Plan execution error:", error);
        await db?.updatePlanRun(runId, { status: "failed", result: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), finishedAt: new Date().toISOString() });
        emitRunState("failed", { error: error instanceof Error ? error.message : String(error) });
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
      runId,
      planVersion,
    }));
  } catch (error) {
    next(error);
  }
});
