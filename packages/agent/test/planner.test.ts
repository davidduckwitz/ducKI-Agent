import { describe, it, expect, beforeEach, vi } from "vitest";
// Explicit .ts: a stale committed planner.js in src/ otherwise shadows the real source
// in vite/vitest resolution (it prefers .js over .ts), running July-old planner logic.
import { Planner } from "../src/planner/planner.ts";
import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";

describe("Planner - Enhanced Features", () => {
  let planner: Planner;
  let mockProvider: LLMProvider;
  let mockLogger: Logger;

  beforeEach(() => {
    mockProvider = {
      name: "test",
      generate: vi.fn(),
      supportsStreaming: () => false,
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    planner = new Planner(mockProvider, mockLogger);
  });

  describe("Hierarchical Plans with Subtasks", () => {
    it("removes hallucinated plan tools without rejecting the plan", async () => {
      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify({
          goal: "Add a world clock component",
          planType: "coding",
          steps: [{
            id: "step_1",
            title: "Implement the clock component",
            description: "Create the UI component and wire its state.",
            toolsNeeded: ["clock", "filesystem"],
            acceptanceCriteria: ["The component renders a current time."],
            subtasks: [{
              id: "step_1_a",
              title: "Add component state",
              description: "Keep the displayed time current.",
              toolsNeeded: ["clock", "shell"],
              status: "pending",
            }],
            status: "pending",
          }],
          estimatedComplexity: "low",
        }),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Add a world clock component", ["filesystem", "shell"]);

      expect(plan.steps[0].toolsNeeded).toEqual(["filesystem"]);
      expect(plan.steps[0].subtasks?.[0].toolsNeeded).toEqual(["shell"]);
      expect(plan.validationResult?.warnings).toContain("Removed unavailable advisory tools: clock");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Removed unavailable tools from plan metadata",
        expect.objectContaining({ removedTools: ["clock"] })
      );
    });

    it("should create plan with subtasks", async () => {
      const mockResponse = {
        goal: "Build a web application",
        steps: [
          {
            id: "step_1",
            title: "Setup Project",
            description: "Initialize project structure",
            priority: "high",
            estimatedDuration: 300,
            subtasks: [
              {
                id: "step_1_a",
                title: "Create directory structure",
                description: "Create necessary directories",
                toolsNeeded: ["shell"],
              },
              {
                id: "step_1_b",
                title: "Initialize git repository",
                description: "Setup git repo",
                toolsNeeded: ["git"],
              },
            ],
            toolsNeeded: ["shell", "git"],
            dependsOn: [],
          },
        ],
        estimatedComplexity: "medium",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Build a web application");

      expect(plan.steps[0].subtasks).toHaveLength(2);
      expect(plan.steps[0].subtasks?.[0].title).toBe("Create directory structure");
      expect(plan.steps[0].subtasks?.[1].title).toBe("Initialize git repository");
    });

    it("should calculate complexity score based on steps and subtasks", async () => {
      const mockResponse = {
        goal: "Complex project",
        steps: Array.from({ length: 8 }, (_, i) => ({
          id: `step_${i + 1}`,
          title: `Step ${i + 1}`,
          description: `Description for step ${i + 1}`,
          subtasks: [
            { id: `step_${i + 1}_a`, title: "Subtask", description: "Sub", dependsOn: [] },
          ],
          dependsOn: i > 0 ? [`step_${i}`] : [],
          toolsNeeded: ["shell"],
          estimatedDuration: 300,
        })),
        estimatedComplexity: "high",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Complex project");

      expect(plan.estimatedComplexityScore).toBeGreaterThan(1);
      expect(plan.totalSteps).toBe(8);
      expect(plan.estimatedComplexity).toBe("high");
    });
  });

  describe("Dependency Analysis", () => {
    it("should detect parallel executable steps", async () => {
      const mockResponse = {
        goal: "Build features",
        steps: [
          {
            id: "step_1",
            title: "Setup",
            description: "Setup project",
            dependsOn: [],
            toolsNeeded: ["shell"],
            estimatedDuration: 300,
          },
          {
            id: "step_2",
            title: "Feature A",
            description: "Build feature A",
            dependsOn: ["step_1"],
            toolsNeeded: ["coding"],
            estimatedDuration: 600,
          },
          {
            id: "step_3",
            title: "Feature B",
            description: "Build feature B",
            dependsOn: ["step_1"],
            toolsNeeded: ["coding"],
            estimatedDuration: 600,
          },
        ],
        estimatedComplexity: "medium",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Build features");

      expect(plan.steps[1].canParallelizeWith).toContain("step_3");
      expect(plan.steps[2].canParallelizeWith).toContain("step_2");
    });

    it("should detect cyclic dependencies and resolve them", async () => {
      const mockResponse = {
        goal: "Cyclic task",
        steps: [
          {
            id: "step_1",
            title: "Step 1",
            description: "First step",
            dependsOn: ["step_2"],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
          {
            id: "step_2",
            title: "Step 2",
            description: "Second step",
            dependsOn: ["step_1"],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Cyclic task");

      // Cyclic dependencies should be detected and logged
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(plan.steps.length).toBe(2);
    });

    it("should determine execution strategy", async () => {
      const mockResponse = {
        goal: "Hybrid execution",
        steps: [
          {
            id: "step_1",
            title: "Sequential",
            description: "First",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
          {
            id: "step_2",
            title: "Parallel 1",
            description: "Can run parallel",
            dependsOn: ["step_1"],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
          {
            id: "step_3",
            title: "Parallel 2",
            description: "Can run parallel",
            dependsOn: ["step_1"],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "medium",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Hybrid execution");

      expect(plan.executionStrategy).toBe("hybrid");
    });
  });

  describe("Plan Validation", () => {
    it("should validate plan structure", async () => {
      const mockResponse = {
        goal: "Valid plan",
        steps: [
          {
            id: "step_1",
            title: "Valid step",
            description: "Valid description",
            dependsOn: [],
            toolsNeeded: ["shell"],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Valid plan");

      expect(plan.validationResult?.isValid).toBe(true);
      expect(plan.validationResult?.issues).toHaveLength(0);
    });

    it("should reject unverifiable coding contracts against repository facts", async () => {
      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify({
          goal: "Add endpoint",
          planType: "coding",
          steps: [{
            id: "step_1",
            title: "Add endpoint",
            description: "Implement the endpoint",
            expectedFiles: ["../outside.ts"],
            acceptanceCriteria: ["The endpoint returns HTTP 200"],
            verificationCommands: ["npm run nonexistent"],
          }],
          estimatedComplexity: "low",
        }),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Add endpoint", [], {
        requiredPlanType: "coding",
        repositoryContext: {
          files: ["package.json"],
          package: { scripts: { test: "vitest" } },
          hasTsconfig: false,
        },
      });

      expect(plan.validationResult?.isValid).toBe(false);
      expect(plan.validationResult?.issues).toEqual(expect.arrayContaining([
        expect.stringContaining("invalid expected file path"),
        expect.stringContaining("unavailable verification command"),
      ]));
    });

    it("should detect missing step titles", async () => {
      const mockResponse = {
        goal: "Invalid plan",
        steps: [
          {
            id: "step_1",
            title: "",
            description: "Missing title",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Invalid plan");

      expect(plan.validationResult?.issues.length).toBeGreaterThan(0);
    });

    it("should detect invalid dependencies", async () => {
      const mockResponse = {
        goal: "Invalid dependencies",
        steps: [
          {
            id: "step_1",
            title: "Step 1",
            description: "First step",
            dependsOn: ["nonexistent_step"],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Invalid dependencies");

      expect(plan.validationResult?.issues.length).toBeGreaterThan(0);
      expect(plan.validationResult?.issues[0]).toContain("nonexistent_step");
    });

    it("should warn on large plans", async () => {
      const mockResponse = {
        goal: "Large plan",
        steps: Array.from({ length: 25 }, (_, i) => ({
          id: `step_${i + 1}`,
          title: `Step ${i + 1}`,
          description: `Description ${i + 1}`,
          dependsOn: [],
          toolsNeeded: ["shell"],
          estimatedDuration: 300,
        })),
        estimatedComplexity: "high",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Large plan");

      expect(plan.validationResult?.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling and Retry Logic", () => {
    it("should retry on JSON parse failure", async () => {
      const validResponse = {
        goal: "Retry test",
        steps: [
          {
            id: "step_1",
            title: "Step",
            description: "Description",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate)
        .mockResolvedValueOnce({
          content: "Invalid JSON {{{",
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        })
        .mockResolvedValueOnce({
          content: "Still invalid",
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        })
        .mockResolvedValueOnce({
          content: JSON.stringify(validResponse),
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        });

      const plan = await planner.createPlan("Retry test");

      expect(plan.steps[0].title).toBe("Step");
      expect(mockProvider.generate).toHaveBeenCalledTimes(3);
    });

    it("should fallback to simple plan on all retries fail", async () => {
      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: "Invalid JSON {{{",
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Fallback test");

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].title).toBe("Execute task");
      expect(plan.estimatedComplexity).toBe("low");
      expect(plan.validationResult?.issues[0]).toContain("Plan generation failed");
    });

    it("should handle JSON with markdown backticks", async () => {
      const mockResponse = {
        goal: "Markdown test",
        steps: [
          {
            id: "step_1",
            title: "Step",
            description: "Description",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: `\`\`\`json\n${JSON.stringify(mockResponse)}\n\`\`\``,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Markdown test");

      expect(plan.steps[0].title).toBe("Step");
    });
  });

  describe("Plan Refinement", () => {
    it("should refine existing plan", async () => {
      const originalPlan = {
        goal: "Original goal",
        steps: [
          {
            id: "step_1",
            title: "Original step",
            description: "Original description",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
            status: "pending" as const,
          },
        ],
        estimatedComplexity: "low" as const,
      };

      const refinedResponse = {
        goal: "Refined goal",
        steps: [
          {
            id: "step_1",
            title: "Refined step",
            description: "Refined description",
            dependsOn: [],
            toolsNeeded: ["shell"],
            estimatedDuration: 600,
          },
        ],
        estimatedComplexity: "medium",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(refinedResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const refined = await planner.refinePlan(originalPlan, "Make it more detailed");

      expect(refined.steps[0].title).toBe("Refined step");
      expect(refined.steps[0].toolsNeeded).toContain("shell");
    });

    it("should fallback to original plan on refinement failure", async () => {
      const originalPlan = {
        goal: "Original goal",
        steps: [
          {
            id: "step_1",
            title: "Original step",
            description: "Original description",
            dependsOn: [],
            toolsNeeded: [],
            estimatedDuration: 300,
            status: "pending" as const,
          },
        ],
        estimatedComplexity: "low" as const,
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: "Invalid JSON {{{",
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const refined = await planner.refinePlan(originalPlan, "Invalid feedback");

      expect(refined).toEqual(originalPlan);
    });
  });

  describe("Backward Compatibility", () => {
    it("should maintain compatibility with existing plan structure", async () => {
      const mockResponse = {
        goal: "Backward compat test",
        steps: [
          {
            id: "step_1",
            title: "Step",
            description: "Description",
            toolsNeeded: ["shell"],
            dependsOn: [],
            estimatedDuration: 300,
          },
        ],
        estimatedComplexity: "low",
      };

      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify(mockResponse),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      });

      const plan = await planner.createPlan("Backward compat test");

      // Old properties should still exist
      expect(plan.goal).toBeDefined();
      expect(plan.steps).toBeDefined();
      expect(plan.estimatedComplexity).toBeDefined();

      // New properties should be added
      expect(plan.totalSteps).toBeDefined();
      expect(plan.executionStrategy).toBeDefined();
      expect(plan.validationResult).toBeDefined();
    });
  });

  describe("Plan type decision (coding vs general)", () => {
    // Force the deterministic fallback path (generate rejects) so these assert the
    // classifyGoal heuristic + planType assignment without depending on the full
    // parse/validate flow.
    it("classifies a code task as 'coding' (fallback path)", async () => {
      vi.mocked(mockProvider.generate).mockRejectedValue(new Error("no llm"));
      const plan = await planner.createPlan("Implement a React component and fix the failing unit test");
      expect(plan.planType).toBe("coding");
    });

    it("classifies a non-code task as 'general' (fallback path)", async () => {
      vi.mocked(mockProvider.generate).mockRejectedValue(new Error("no llm"));
      const plan = await planner.createPlan("Plane ein Team-Offsite und erstelle die Agenda");
      expect(plan.planType).toBe("general");
    });

    it("rejects a general research plan when the execution context requires coding", async () => {
      vi.mocked(mockProvider.generate).mockResolvedValue({
        content: JSON.stringify({
          goal: "Create a website for a bakery",
          planType: "general",
          steps: [{
            id: "step_1",
            title: "Research bakery websites",
            description: "Write the findings to research.md",
            status: "pending",
          }],
          estimatedComplexity: "low",
        }),
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      });

      const plan = await planner.createPlan("Create a website for a bakery", [], {
        requiredPlanType: "coding",
      });

      expect(mockProvider.generate).toHaveBeenCalledTimes(3);
      expect(plan.planType).toBe("coding");
      expect(plan.steps[0]?.description).toBe("Create a website for a bakery");
    });
  });
});
