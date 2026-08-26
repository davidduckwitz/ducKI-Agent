import { describe, expect, it } from "vitest";
import {
  createEmptyFixHistory,
  recordFixAttempt,
  compileFixContext,
  getEscalationLevel,
  type VerifyFixHistory,
} from "../src/verification/verify-types.js";

describe("VerifyFixHistory", () => {
  describe("createEmptyFixHistory", () => {
    it("creates an empty history with zero attempts", () => {
      const history = createEmptyFixHistory();
      expect(history.totalAttempts).toBe(0);
      expect(history.attempts).toHaveLength(0);
      expect(history.constraintFailures.size).toBe(0);
      expect(history.stalledConstraintIds).toHaveLength(0);
    });
  });

  describe("recordFixAttempt", () => {
    it("records a successful fix that cleared all failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "original", ["constraint X failed"], true, []);
      expect(history.totalAttempts).toBe(1);
      expect(history.attempts).toHaveLength(1);
      expect(history.attempts[0].changed).toBe(true);
      expect(history.attempts[0].remainingFailureIds).toHaveLength(0);
    });

    it("records a failed fix with remaining failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "original", ["X failed"], true, ["c_1"]);
      expect(history.constraintFailures.get("c_1")).toBe(1);
      expect(history.stalledConstraintIds).toHaveLength(0); // threshold is 2
    });

    it("tracks per-constraint failure counts across attempts", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "resp1", ["X failed"], true, ["c_1", "c_2"]);
      recordFixAttempt(history, 2, "resp2", ["X failed"], true, ["c_1"]);
      expect(history.constraintFailures.get("c_1")).toBe(2);
      expect(history.constraintFailures.get("c_2")).toBe(1);
    });

    it("marks constraints as stalled after >= 2 failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "resp1", ["X failed"], true, ["c_1"]);
      recordFixAttempt(history, 2, "resp2", ["X failed"], true, ["c_1"]);
      expect(history.stalledConstraintIds).toContain("c_1");
    });

    it("records a loop (no change)", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "resp1", ["X failed"], false, ["c_1"]);
      expect(history.attempts[0].changed).toBe(false);
    });

    it("incrementally builds attempt list", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      recordFixAttempt(history, 2, "r2", ["f2"], true, ["c_2"]);
      recordFixAttempt(history, 3, "r3", ["f3"], false, ["c_1"]);
      expect(history.attempts).toHaveLength(3);
      expect(history.totalAttempts).toBe(3);
    });
  });

  describe("getEscalationLevel", () => {
    it("returns normal for 0-1 failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      expect(getEscalationLevel(history, "c_1")).toBe("normal");
    });

    it("returns detailed for 2-3 failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      recordFixAttempt(history, 2, "r2", ["f2"], true, ["c_1"]);
      expect(getEscalationLevel(history, "c_1")).toBe("detailed");
      recordFixAttempt(history, 3, "r3", ["f3"], true, ["c_1"]);
      expect(getEscalationLevel(history, "c_1")).toBe("detailed");
    });

    it("returns drastic for >= 4 failures", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      recordFixAttempt(history, 2, "r2", ["f2"], true, ["c_1"]);
      recordFixAttempt(history, 3, "r3", ["f3"], true, ["c_1"]);
      recordFixAttempt(history, 4, "r4", ["f4"], true, ["c_1"]);
      expect(getEscalationLevel(history, "c_1")).toBe("drastic");
    });

    it("returns normal for unknown constraint", () => {
      const history = createEmptyFixHistory();
      expect(getEscalationLevel(history, "unknown")).toBe("normal");
    });
  });

  describe("compileFixContext", () => {
    it("returns empty string for empty history", () => {
      const history = createEmptyFixHistory();
      expect(compileFixContext(history)).toBe("");
    });

    it("summarises prior attempts", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("Prior fix attempts: 1");
      expect(ctx).toContain("Attempt 1");
      expect(ctx).toContain("changed response");
    });

    it("flags no-change attempts", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], false, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("no change");
      expect(ctx).toContain("model looped");
    });

    it("highlights stalled constraints with escalation level", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      recordFixAttempt(history, 2, "r2", ["f2"], true, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("CONSTRAINTS REQUIRING DIFFERENT APPROACH");
      expect(ctx).toContain("c_1");
      expect(ctx).toContain("detailed");
    });

    it("includes actionable guidelines", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("GUIDELINES FOR THIS FIX");
      expect(ctx).toContain("Return ONLY the corrected answer");
    });

    it("gives different guidelines when constraints are stalled", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], true, ["c_1"]);
      recordFixAttempt(history, 2, "r2", ["f2"], true, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("fundamentally different approach");
    });

    it("warns about looping in the guidelines", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["f1"], false, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("MUST modify the response text");
    });

    it("shows still-failing details per attempt", () => {
      const history = createEmptyFixHistory();
      recordFixAttempt(history, 1, "r1", ["X is missing"], true, ["c_1"]);
      const ctx = compileFixContext(history);
      expect(ctx).toContain("Still failing");
      expect(ctx).toContain("X is missing");
    });
  });

  describe("integration: multi-attempt fix flow", () => {
    it("tracks a realistic 3-attempt fix flow", () => {
      const history = createEmptyFixHistory();

      // Attempt 1: fix partially works
      recordFixAttempt(history, 1, "original response", ["Missing section X"], true, ["c_1", "c_2"]);
      expect(history.stalledConstraintIds).toHaveLength(0);

      // Attempt 2: fixes c_2 but not c_1 — c_1 is now stalled
      recordFixAttempt(history, 2, "fixed once", ["Section X still wrong"], true, ["c_1"]);
      expect(history.stalledConstraintIds).toContain("c_1");

      // Attempt 3: fixes c_1 (cleared from stalled since no longer failing)
      recordFixAttempt(history, 3, "fixed twice", [], true, []);
      expect(history.stalledConstraintIds).toHaveLength(0);

      const ctx = compileFixContext(history);
      expect(ctx).toContain("Prior fix attempts: 3");
    });
  });
});
