import { describe, expect, it, vi } from "vitest";
import {
  ChecklistManager,
  deriveAcceptanceCriteria,
  deriveItemStatus,
  hasToolEvidence,
  pickConstraintKind,
  requiresToolEvidence,
  type ChecklistItem,
  type ChecklistStore,
} from "./checklist-manager.js";
import type { Plan, PlanStep } from "../planner/planner.js";
import type { Verifier } from "../verification/verifier.js";
import type { VerifyResult } from "../verification/verify-types.js";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Parameters<typeof ChecklistManager.prototype.constructor>[1];

function step(partial: Partial<PlanStep> & { title: string }): PlanStep {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    description: partial.description ?? "",
    status: "pending",
    ...partial,
  };
}

function plan(partial: Partial<Plan> & { steps: PlanStep[] }): Plan {
  return {
    goal: partial.goal ?? "goal",
    estimatedComplexity: partial.estimatedComplexity ?? "medium",
    ...partial,
  };
}

/** In-memory store implementing the narrow ChecklistStore surface. */
function makeFakeStore(): ChecklistStore & { rows: ChecklistItem[] } {
  let nextId = 1;
  const rows: ChecklistItem[] = [];
  const OPEN = new Set(["pending", "in_progress"]);
  return {
    rows,
    async createChecklist(conversationId, runId, items) {
      const created = items.map((it, idx) => ({
        id: nextId++,
        conversationId,
        runId: runId ?? null,
        stepIndex: it.stepIndex ?? idx,
        title: it.title,
        description: it.description ?? null,
        acceptanceCriteria: it.acceptanceCriteria ?? null,
        constraintKind: it.constraintKind ?? null,
        status: it.status ?? "pending",
        confidence: null,
        verifyState: null,
        attempts: 0,
      }));
      rows.push(...created);
      return created;
    },
    async getChecklist(conversationId, runId) {
      return rows
        .filter((r) => r.conversationId === conversationId && (runId === undefined || r.runId === runId))
        .sort((a, b) => a.stepIndex - b.stepIndex);
    },
    async getOpenChecklistItems(conversationId, runId) {
      return rows
        .filter(
          (r) =>
            r.conversationId === conversationId &&
            (runId === undefined || r.runId === runId) &&
            OPEN.has(r.status)
        )
        .sort((a, b) => a.stepIndex - b.stepIndex);
    },
    async updateChecklistItem(id, data) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, data);
      return row;
    },
    async deleteChecklist(conversationId, runId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.conversationId === conversationId && (runId === undefined || r.runId === runId)) rows.splice(i, 1);
      }
    },
  };
}

function makeVerifier(result: VerifyResult): Verifier {
  return { verify: vi.fn().mockResolvedValue(result) } as unknown as Verifier;
}

const PASS: VerifyResult = {
  passed: true,
  checks: [{ constraintId: "step-0", kind: "requirement", description: "d", status: "passed" }],
  failures: [],
  shouldFix: false,
};
const FAIL: VerifyResult = {
  passed: false,
  checks: [{ constraintId: "step-0", kind: "requirement", description: "d", status: "failed", detail: "missing X" }],
  failures: ["[requirement] d — missing X"],
  shouldFix: true,
};
const SKIP: VerifyResult = {
  passed: true,
  checks: [{ constraintId: "step-0", kind: "shell-check", description: "d", status: "skipped", detail: "no executor" }],
  failures: [],
  shouldFix: false,
};

describe("pure helpers", () => {
  it("pickConstraintKind never returns shell-check for a general step", () => {
    expect(pickConstraintKind(step({ title: "Research" }), "general")).toBe("requirement");
    expect(pickConstraintKind(step({ title: "Build", toolsNeeded: ["coding"] }), "coding")).toBe("requirement");
  });

  it("deriveAcceptanceCriteria prefers description, falls back to title", () => {
    expect(deriveAcceptanceCriteria(step({ title: "T", description: "do the thing" }))).toContain("do the thing");
    expect(deriveAcceptanceCriteria(step({ title: "OnlyTitle" }))).toContain("OnlyTitle");
  });

  it("deriveItemStatus maps verify results to status + confidence", () => {
    expect(deriveItemStatus(PASS)).toEqual({ status: "done", confidence: "verified" });
    expect(deriveItemStatus(FAIL)).toEqual({ status: "failed" });
    expect(deriveItemStatus(SKIP)).toEqual({ status: "unverified", confidence: "soft" });
    expect(deriveItemStatus({ passed: true, checks: [], failures: [], shouldFix: false })).toEqual({
      status: "unverified",
      confidence: "soft",
    });
  });

  it("requiresToolEvidence flags action-verb steps (DE/EN) and ignores analysis steps", () => {
    expect(requiresToolEvidence({ title: "Write index.html", description: null, acceptanceCriteria: null })).toBe(true);
    expect(requiresToolEvidence({ title: "schreibe die Datei app.js", description: null, acceptanceCriteria: null })).toBe(
      true
    );
    expect(
      requiresToolEvidence({ title: "A", description: null, acceptanceCriteria: 'Der Schritt "A" ist erfüllt: sende die Nachricht' })
    ).toBe(true);
    expect(requiresToolEvidence({ title: "Explain the tradeoffs", description: null, acceptanceCriteria: null })).toBe(
      false
    );
  });

  it("hasToolEvidence detects a [tools] section vs prose-only evidence", () => {
    expect(hasToolEvidence('[assistant] I wrote the file.\n[tools] {"success":true}')).toBe(true);
    expect(hasToolEvidence("[assistant] I wrote the file.")).toBe(false);
  });
});

describe("ChecklistManager.deriveFromPlan", () => {
  it("persists one pending item per plan step, in order", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const items = await mgr.deriveFromPlan(
      plan({ planType: "general", steps: [step({ title: "A" }), step({ title: "B", description: "second" })] }),
      42,
      "run-1"
    );

    expect(items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items.every((i) => i.constraintKind === "requirement")).toBe(true);
    expect(items[1]?.acceptanceCriteria).toContain("second");
  });

  it("returns [] for a plan with no steps and does not touch the store", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    expect(await mgr.deriveFromPlan(plan({ steps: [] }), 1)).toEqual([]);
    expect(store.rows).toHaveLength(0);
  });

  it("swallows store errors and returns []", async () => {
    const store = makeFakeStore();
    store.createChecklist = vi.fn().mockRejectedValue(new Error("db down"));
    const mgr = new ChecklistManager(store, noopLogger);
    expect(await mgr.deriveFromPlan(plan({ steps: [step({ title: "A" })] }), 1)).toEqual([]);
  });
});

describe("ChecklistManager.nextOpen / allSatisfied", () => {
  it("advances through open items and reports completion", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    await mgr.deriveFromPlan(plan({ steps: [step({ title: "A" }), step({ title: "B" })] }), 7, "r");

    expect((await mgr.nextOpen(7, "r"))?.title).toBe("A");
    expect(await mgr.allSatisfied(7, "r")).toBe(false);

    const first = await mgr.nextOpen(7, "r");
    await store.updateChecklistItem(first!.id, { status: "done" });
    expect((await mgr.nextOpen(7, "r"))?.title).toBe("B");

    const second = await mgr.nextOpen(7, "r");
    await store.updateChecklistItem(second!.id, { status: "done" });
    expect(await mgr.allSatisfied(7, "r")).toBe(true);
    expect(await mgr.nextOpen(7, "r")).toBeUndefined();
  });
});

describe("ChecklistManager.verifyAndMark", () => {
  async function seed(): Promise<{ store: ReturnType<typeof makeFakeStore>; mgr: ChecklistManager; item: ChecklistItem }> {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "A" })] }), 1, "r");
    return { store, mgr, item: item! };
  }

  it("marks done + verified on a passing verify and increments attempts", async () => {
    const { mgr, item, store } = await seed();
    const res = await mgr.verifyAndMark(item, "req", "evidence", makeVerifier(PASS));
    expect(res.status).toBe("done");
    expect(res.confidence).toBe("verified");
    expect(store.rows[0]?.status).toBe("done");
    expect(store.rows[0]?.attempts).toBe(1);
    expect(store.rows[0]?.verifyState).toContain("passed");
  });

  it("marks failed on a failing verify and records failures", async () => {
    const { mgr, item, store } = await seed();
    const res = await mgr.verifyAndMark(item, "req", "evidence", makeVerifier(FAIL));
    expect(res.status).toBe("failed");
    expect(res.failures[0]).toContain("missing X");
    expect(store.rows[0]?.status).toBe("failed");
  });

  it("marks unverified/soft when all checks are skipped", async () => {
    const { mgr, item, store } = await seed();
    const res = await mgr.verifyAndMark(item, "req", "evidence", makeVerifier(SKIP));
    expect(res.status).toBe("unverified");
    expect(res.confidence).toBe("soft");
    expect(store.rows[0]?.confidence).toBe("soft");
  });

  it("treats a thrown verifier as unverified instead of crashing", async () => {
    const { mgr, item } = await seed();
    const throwing = { verify: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as Verifier;
    const res = await mgr.verifyAndMark(item, "req", "evidence", throwing);
    expect(res.status).toBe("unverified");
  });

  it("passes the item's constraintKind through to the verifier", async () => {
    const { mgr, item } = await seed();
    const verifier = makeVerifier(PASS);
    await mgr.verifyAndMark(item, "req", "evidence", verifier);
    const call = (verifier.verify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2][0].kind).toBe("requirement");
    expect(call[2][0].id).toBe("step-0");
  });

  it("does NOT trust a passing verify for an action step when the evidence has no [tools] result", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "Write index.html" })] }), 1, "r");

    // The verifier is graded PASS purely from the model's self-report prose - no [tools] evidence.
    const res = await mgr.verifyAndMark(item!, "req", "[assistant] I wrote index.html successfully.", makeVerifier(PASS));

    expect(res.status).toBe("unverified");
    expect(res.confidence).toBe("soft");
    expect(res.failures.some((f) => f.includes("no tool-call evidence"))).toBe(true);
    expect(store.rows[0]?.status).toBe("unverified");
  });

  it("marks an action step done when the evidence carries a real [tools] result", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "Write index.html" })] }), 1, "r");

    const res = await mgr.verifyAndMark(
      item!,
      "req",
      '[assistant] Done.\n[tools] {"success":true,"data":{"path":"index.html"}}',
      makeVerifier(PASS)
    );

    expect(res.status).toBe("done");
    expect(res.confidence).toBe("verified");
    expect(store.rows[0]?.status).toBe("done");
  });

  it("does not gate non-action steps on tool evidence", async () => {
    const { mgr, item, store } = await seed(); // title "A" - no action verb
    const res = await mgr.verifyAndMark(item, "req", "[assistant] Explained the tradeoffs.", makeVerifier(PASS));
    expect(res.status).toBe("done");
    expect(store.rows[0]?.status).toBe("done");
  });
});

describe("ChecklistManager.tryAdvanceDuringRun", () => {
  async function seed(): Promise<{ store: ReturnType<typeof makeFakeStore>; mgr: ChecklistManager; item: ChecklistItem }> {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "A" })] }), 1, "r");
    return { store, mgr, item: item! };
  }

  it("marks the item done and returns true on a clear pass", async () => {
    const { mgr, item, store } = await seed();
    const advanced = await mgr.tryAdvanceDuringRun(item, "req", "evidence", makeVerifier(PASS));
    expect(advanced).toBe(true);
    expect(store.rows[0]?.status).toBe("done");
    expect(store.rows[0]?.confidence).toBe("verified");
  });

  it("is non-destructive on a failing verify — no status change, no attempt consumed", async () => {
    const { mgr, item, store } = await seed();
    const advanced = await mgr.tryAdvanceDuringRun(item, "req", "evidence", makeVerifier(FAIL));
    expect(advanced).toBe(false);
    expect(store.rows[0]?.status).toBe("pending");
    expect(store.rows[0]?.attempts).toBe(0);
  });

  it("does not advance on unverified/skipped (leaves it for the end-phase)", async () => {
    const { mgr, item, store } = await seed();
    const advanced = await mgr.tryAdvanceDuringRun(item, "req", "evidence", makeVerifier(SKIP));
    expect(advanced).toBe(false);
    expect(store.rows[0]?.status).toBe("pending");
  });

  it("swallows a thrown verifier and returns false without touching the item", async () => {
    const { mgr, item, store } = await seed();
    const throwing = { verify: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as Verifier;
    const advanced = await mgr.tryAdvanceDuringRun(item, "req", "evidence", throwing);
    expect(advanced).toBe(false);
    expect(store.rows[0]?.status).toBe("pending");
  });

  it("does not advance an action step on a clear pass when evidence lacks a [tools] result", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "Write index.html" })] }), 1, "r");

    const advanced = await mgr.tryAdvanceDuringRun(
      item!,
      "req",
      "[assistant] I wrote index.html successfully.",
      makeVerifier(PASS)
    );

    expect(advanced).toBe(false);
    expect(store.rows[0]?.status).toBe("pending");
  });

  it("advances an action step once the evidence carries a real [tools] result", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    const [item] = await mgr.deriveFromPlan(plan({ steps: [step({ title: "Write index.html" })] }), 1, "r");

    const advanced = await mgr.tryAdvanceDuringRun(
      item!,
      "req",
      '[assistant] Done.\n[tools] {"success":true}',
      makeVerifier(PASS)
    );

    expect(advanced).toBe(true);
    expect(store.rows[0]?.status).toBe("done");
  });
});

describe("ChecklistManager.renderMarkdown", () => {
  it("counts done + unverified as progress and flags unbestätigt", async () => {
    const store = makeFakeStore();
    const mgr = new ChecklistManager(store, noopLogger);
    await mgr.deriveFromPlan(plan({ steps: [step({ title: "A" }), step({ title: "B" }), step({ title: "C" })] }), 1, "r");
    store.rows[0]!.status = "done";
    store.rows[1]!.status = "unverified";
    const md = ChecklistManager.renderMarkdown(store.rows);
    expect(md).toContain("(2/3)");
    expect(md).toContain("_(unbestätigt)_");
  });
});
