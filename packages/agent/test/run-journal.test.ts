import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";
import type { RunJournalEntry } from "../src/config/interfaces_types";

describe("Run Journal", () => {
  describe("renderRunJournalHint", () => {
    it("returns an empty string for an empty journal", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).renderRunJournalHint([]);
      expect(hint).toBe("");
    });

    it("renders entries with ok/fail markers and a do-not-repeat instruction", () => {
      const agent = createAgentForParserTests();
      const ts = new Date().toISOString();
      const journal: RunJournalEntry[] = [
        { iteration: 1, toolName: "filesystem", summary: "wrote apps/web/src/Foo.tsx", success: true, timestamp: ts },
        { iteration: 2, toolName: "http", summary: "GET https://api.example.com/weather", success: true, timestamp: ts },
        { iteration: 3, toolName: "shell", summary: "run tests", success: false, timestamp: ts, errorDetail: "2 tests failed" },
      ];
      const hint = (agent as any).renderRunJournalHint(journal);
      expect(hint).toContain("## Actions taken so far this run");
      expect(hint).toContain("1. [ok] wrote apps/web/src/Foo.tsx");
      expect(hint).toContain("2. [ok] GET https://api.example.com/weather");
      // The failure's actual error rides along now - a retry no longer has to guess why.
      expect(hint).toContain("3. [fail] run tests: 2 tests failed");
      expect(hint).toContain("Do not repeat an action already listed above");
    });

    it("tags an entry with its stepId when the caller supplied one", () => {
      const agent = createAgentForParserTests();
      const journal: RunJournalEntry[] = [
        { iteration: 1, toolName: "filesystem", summary: "wrote a.ts", success: true, timestamp: new Date().toISOString(), stepId: "3" },
      ];
      const hint = (agent as any).renderRunJournalHint(journal);
      expect(hint).toContain("(step 3)");
    });

    it("only renders the most recent 15 entries to bound token cost", () => {
      const agent = createAgentForParserTests();
      const journal: RunJournalEntry[] = Array.from({ length: 20 }, (_, i) => ({
        iteration: i + 1,
        toolName: "filesystem",
        summary: `action ${i + 1}`,
        success: true,
        timestamp: new Date().toISOString(),
      }));
      const hint = (agent as any).renderRunJournalHint(journal);
      expect(hint).not.toContain("action 1\n");
      expect(hint).not.toContain("action 5\n");
      expect(hint).toContain("action 20");
      expect(hint).toContain("action 6");
    });
  });
});
