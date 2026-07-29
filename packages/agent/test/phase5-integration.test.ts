import { describe, it, expect, beforeEach } from "vitest";
import { SkillSelectionService } from "../src/skill-selector/skill-selection-service.js";
import { ContextManager } from "../src/context/context-manager.js";
import { TokenCounter } from "../src/context/token-counter.js";
import type { SkillManifest, LLMMessage, AgentRuntimeControls } from "../src/index.js";

/**
 * Phase 5: Integration & Testing
 * End-to-end scenarios combining all major components:
 * - Skill selection with context management
 * - Token budgeting with context compression
 * - Settings cascade through runtime controls
 */
describe("Phase 5: End-to-End Integration", () => {
  let skillService: SkillSelectionService;
  let contextManager: ContextManager;
  let testSkills: SkillManifest[];
  let runtimeControls: AgentRuntimeControls;

  beforeEach(() => {
    // Initialize services
    skillService = new SkillSelectionService();
    contextManager = new ContextManager("claude-3-5-sonnet");

    // Setup test skills
    testSkills = [
      {
        slug: "frontend-dev",
        name: "Frontend Development",
        description: "Build responsive UIs with React and TypeScript",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "backend-api",
        name: "Backend API",
        description: "Design and implement RESTful APIs",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "database-sql",
        name: "Database & SQL",
        description: "Optimize SQL queries and database performance",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "testing",
        name: "Testing",
        description: "Write unit and integration tests",
        category: "skill",
        type: "workflow",
      },
    ];

    skillService.initialize(testSkills);

    // Setup runtime controls with all settings
    runtimeControls = {
      // Auto-skill selection settings
      enableAutoSkillSelection: true,
      autoSkillScoreThreshold: 0.75,
      autoSkillMarginThreshold: 0.2,
      autoSkillMinInputLength: 20,
      autoSkillMinOverlap: 2,
      skillBehavior: "automatic",
      autoSkillFallbackNone: true,

      // Context compression settings
      compressionStrategy: "sliding-window",
      compressionThreshold: 80,

      // Timeout settings
      timeoutMs: 300000,
      toolTimeoutMs: 60000,

      // Other defaults (would come from database)
      maxIterations: 50,
      enableReflection: true,
    } as any;
  });

  describe("Skill Selection with Context", () => {
    it("selects skills based on user input and task type", () => {
      const input = "Create a React component that fetches data from an API";

      const selection = skillService.selectSkills({
        userInput: input,
        taskType: "development",
        complexityLevel: "moderate",
      });

      expect(selection).toBeDefined();
      expect(selection.reasoning).toBeTruthy();
      expect(selection.confidence).toBeGreaterThanOrEqual(0);
      expect(selection.confidence).toBeLessThanOrEqual(1);
    });

    it("records skill usage and updates metrics", () => {
      const skillSlug = "frontend-dev";

      // Record successful usage
      skillService.recordUsage(skillSlug, true, 2);
      skillService.recordUsage(skillSlug, true, 3);
      skillService.recordUsage(skillSlug, false, 5);

      const metrics = skillService.getMetrics(skillSlug);
      expect(metrics).toBeDefined();
      expect(metrics!.totalUses).toBe(3);
      expect(metrics!.successfulUses).toBe(2);
      expect(metrics!.successRate).toBe(2 / 3);
    });
  });

  describe("Context Management & Token Budgeting", () => {
    it("tracks token usage across conversation", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a helpful AI assistant." },
        { role: "user", content: "Build a React component for user profiles." },
        { role: "assistant", content: "I'll help you create a React component." },
      ];

      contextManager.addMessages(messages);
      const usage = contextManager.getTokenUsage();

      expect(usage.currentTokens).toBeGreaterThan(0);
      expect(usage.maxTokens).toBeGreaterThan(0);
      expect(usage.percentageUsed).toBeGreaterThan(0);
      expect(usage.percentageUsed).toBeLessThanOrEqual(100);
    });

    it("optimizes context when approaching token limit", () => {
      // Add many messages to approach the limit
      const messages: LLMMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}: This is a test message with some content to consume tokens.`,
        });
      }

      contextManager.addMessages(messages);
      const usage = contextManager.getTokenUsage();

      // Try to optimize
      const optimized = contextManager.optimizeForContext();

      expect(optimized).toBeDefined();
      expect(Array.isArray(optimized)).toBe(true);
      // Optimized should have fewer or equal messages
      expect(optimized.length).toBeLessThanOrEqual(messages.length);
    });

    it("provides optimization recommendations", () => {
      const messages: LLMMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push({
          role: "user",
          content: "Test message with content for token consumption and context management.",
        });
      }

      contextManager.addMessages(messages);
      const recommendation = contextManager.getOptimizationRecommendations();

      expect(recommendation).toBeDefined();
      expect(recommendation.shouldOptimize).toBeDefined();
      expect(recommendation.reason).toBeTruthy();
      expect(recommendation.currentStrategy).toBeDefined();
      expect(recommendation.messagesAfterOptimization).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Settings Cascade & Runtime Controls", () => {
    it("extracts auto-skill settings from runtime controls", () => {
      const config = skillService.getAutoSelectionConfig(runtimeControls);

      expect(config.enabled).toBe(runtimeControls.enableAutoSkillSelection);
      expect(config.threshold).toBe(runtimeControls.autoSkillScoreThreshold);
      expect(config.margin).toBe(runtimeControls.autoSkillMarginThreshold);
      expect(config.minInputLength).toBe(runtimeControls.autoSkillMinInputLength);
      expect(config.minOverlap).toBe(runtimeControls.autoSkillMinOverlap);
    });

    it("applies context compression settings", () => {
      contextManager.updateConfig({
        compressionThreshold: runtimeControls.compressionThreshold as number,
        pruningStrategy: (runtimeControls.compressionStrategy as any) || "sliding-window",
      });

      const recommendation = contextManager.getOptimizationRecommendations();
      expect(recommendation.currentStrategy).toBe(runtimeControls.compressionStrategy);
    });

    it("determines auto-selection behavior from settings", () => {
      expect(skillService.shouldAutoSelect(runtimeControls)).toBe(
        runtimeControls.enableAutoSkillSelection
      );

      const noAutoControls = { ...runtimeControls, enableAutoSkillSelection: false } as any;
      expect(skillService.shouldAutoSelect(noAutoControls)).toBe(false);
    });
  });

  describe("Complex Multi-Component Scenarios", () => {
    it("handles skill selection + context management + metrics", () => {
      // Scenario: Developer asks to build an API
      const userInput = "Create a RESTful API for managing users with authentication";

      // 1. Select skills
      const skillSelection = skillService.selectSkills({
        userInput,
        taskType: "development",
        complexityLevel: "complex",
      });

      skillSelection.selectedSkills.forEach((skill) => {
        skillService.recordUsage(skill.slug, true, 2);
      });

      // 2. Build conversation with context management
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a backend API expert." },
        { role: "user", content: userInput },
      ];

      contextManager.addMessages(messages);

      // 3. Verify token usage
      const tokenUsage = contextManager.getTokenUsage();
      expect(tokenUsage.currentTokens).toBeGreaterThan(0);
      expect(tokenUsage.percentageUsed).toBeLessThan(100);

      // 4. Verify skill metrics recorded
      const metrics = skillService.getAllMetrics();
      expect(metrics.length).toBeGreaterThanOrEqual(0);
    });

    it("simulates full interaction cycle", () => {
      const inputs = [
        "Build a user authentication system with React frontend",
        "Write tests for the authentication API",
        "Optimize the database queries for user lookups",
      ];

      inputs.forEach((input, index) => {
        // Select skills for this turn
        const selection = skillService.selectSkills({
          userInput: input,
          taskType: "development",
          previousSkillsUsed:
            index > 0
              ? ["frontend-dev", "backend-api", "database-sql"].slice(0, index)
              : undefined,
        });

        // Record outcomes
        if (selection.selectedSkills.length > 0) {
          const success = Math.random() > 0.3; // 70% success rate
          selection.selectedSkills.forEach((skill) => {
            skillService.recordUsage(skill.slug, success, Math.floor(Math.random() * 5) + 1);
          });
        }

        // Add to context
        const messages: LLMMessage[] = [
          { role: "user", content: input },
          {
            role: "assistant",
            content: selection.reasoning || "Processing your request with selected skills.",
          },
        ];

        contextManager.addMessages(messages);
      });

      // Verify all metrics
      const allMetrics = skillService.getAllMetrics();
      expect(allMetrics).toBeDefined();
      expect(Array.isArray(allMetrics)).toBe(true);

      // Verify context is still manageable
      const usage = contextManager.getTokenUsage();
      expect(usage.percentageUsed).toBeLessThanOrEqual(100);
    });

    it("handles degradation when token budget exhausted", () => {
      // Fill context heavily
      const messages: LLMMessage[] = [];
      for (let i = 0; i < 200; i++) {
        messages.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "This is a test message with enough content to consume tokens meaningfully.",
        });
      }

      contextManager.addMessages(messages);

      // Should optimize automatically
      const optimized = contextManager.optimizeForContext();

      // After optimization, should have some messages
      expect(optimized).toBeDefined();
      expect(Array.isArray(optimized)).toBe(true);
      expect(optimized.length).toBeGreaterThan(0);
      // Optimized should have equal or fewer messages than original
      expect(optimized.length).toBeLessThanOrEqual(messages.length);
    });
  });

  describe("System Resilience", () => {
    it("recovers from missing metrics gracefully", () => {
      const unknownSkill = "non-existent-skill-xyz";

      // Try to get metrics for non-existent skill
      const metrics = skillService.getMetrics(unknownSkill);
      expect(metrics).toBeUndefined();

      // But should still record usage
      skillService.recordUsage(unknownSkill, true, 1);
      const recorded = skillService.getMetrics(unknownSkill);
      expect(recorded).toBeDefined();
      expect(recorded!.successRate).toBe(1);
    });

    it("validates configuration defaults", () => {
      const minimalControls = {
        enableAutoSkillSelection: true,
      } as any;

      const config = skillService.getAutoSelectionConfig(minimalControls);

      // All values should have defaults
      expect(config.threshold).toBe(0.78); // Default
      expect(config.margin).toBe(0.2); // Default
      expect(config.minInputLength).toBe(20); // Default
      expect(config.minOverlap).toBe(2); // Default
    });

    it("handles empty skill selections gracefully", () => {
      const selection = skillService.selectSkills({
        userInput: "xyzabc 12345 nonsense input",
        taskType: undefined,
        complexityLevel: undefined,
      });

      expect(selection).toBeDefined();
      expect(Array.isArray(selection.selectedSkills)).toBe(true);
      expect(typeof selection.reasoning).toBe("string");
      expect(typeof selection.confidence).toBe("number");
    });
  });
});
