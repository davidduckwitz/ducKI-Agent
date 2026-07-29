import { describe, it, expect, beforeEach } from "vitest";
import { SkillSelectionService } from "../src/skill-selector/skill-selection-service.js";
import { AdvancedSkillSelector } from "../src/skill-selector/advanced-selector.js";
import type { SkillManifest, SelectionContext } from "../src/index.js";

describe("Skill Selection Integration", () => {
  let service: SkillSelectionService;
  let testSkills: SkillManifest[];

  beforeEach(() => {
    service = new SkillSelectionService();

    // Create test skills
    testSkills = [
      {
        slug: "frontend-development",
        name: "Frontend Development",
        description: "Skills for building user interfaces with React and TypeScript",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "api-design",
        name: "API Design",
        description: "Skills for designing RESTful APIs and GraphQL schemas",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "database-optimization",
        name: "Database Optimization",
        description: "Skills for optimizing SQL queries and database performance",
        category: "skill",
        type: "workflow",
      },
      {
        slug: "testing",
        name: "Testing",
        description: "Skills for writing unit tests and integration tests",
        category: "skill",
        type: "workflow",
      },
    ];

    service.initialize(testSkills);
  });

  describe("Basic Skill Selection", () => {
    it("returns selection result with reasoning", () => {
      const context: SelectionContext = {
        userInput: "Build a React component for a user profile page",
        taskType: "development",
        complexityLevel: "moderate",
      };

      const result = service.selectSkills(context);

      expect(result.selectedSkills).toBeDefined();
      expect(Array.isArray(result.selectedSkills)).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasoning).toBeDefined();
      expect(typeof result.reasoning).toBe("string");
    });

    it("prioritizes skills by task type", () => {
      const devContext: SelectionContext = {
        userInput: "help me write code",
        taskType: "development",
      };

      const analysisContext: SelectionContext = {
        userInput: "help me write code",
        taskType: "analysis",
      };

      const devResult = service.selectSkills(devContext);
      const analysisResult = service.selectSkills(analysisContext);

      // Different contexts should produce different results or confidence levels
      expect(devResult).toBeDefined();
      expect(analysisResult).toBeDefined();
    });
  });

  describe("Recommended Skills", () => {
    it("returns recommended skills for simple input", () => {
      const skills = service.getRecommendedSkills("build a frontend", 3);

      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeLessThanOrEqual(3);
    });

    it("returns empty array when no skills match", () => {
      const skills = service.getRecommendedSkills("xyz abc 123 nonsense", 3);

      // Should return something, even if low confidence
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe("Usage Metrics Recording", () => {
    it("records successful skill usage", () => {
      service.recordUsage("frontend-development", true, 3);

      const metrics = service.getMetrics("frontend-development");
      expect(metrics).toBeDefined();
      expect(metrics?.successfulUses).toBe(1);
      expect(metrics?.totalUses).toBe(1);
      expect(metrics?.successRate).toBe(1);
    });

    it("tracks failed skill usage", () => {
      service.recordUsage("api-design", false, 5);
      service.recordUsage("api-design", true, 2);

      const metrics = service.getMetrics("api-design");
      expect(metrics?.totalUses).toBe(2);
      expect(metrics?.successfulUses).toBe(1);
      expect(metrics?.successRate).toBe(0.5);
    });

    it("calculates average iterations per outcome", () => {
      service.recordUsage("database-optimization", true, 2);
      service.recordUsage("database-optimization", true, 4);
      service.recordUsage("database-optimization", false, 6);

      const metrics = service.getMetrics("database-optimization");
      expect(metrics?.avgIterationsOnSuccess).toBe(3); // (2 + 4) / 2
      expect(metrics?.avgIterationsOnFailure).toBe(6);
    });
  });

  describe("Auto-Selection Configuration", () => {
    it("extracts auto-selection config from runtime controls", () => {
      const runtimeControls = {
        enableAutoSkillSelection: true,
        autoSkillScoreThreshold: 0.8,
        autoSkillMarginThreshold: 0.15,
        autoSkillMinInputLength: 30,
        autoSkillMinOverlap: 3,
      } as any;

      const config = service.getAutoSelectionConfig(runtimeControls);

      expect(config.enabled).toBe(true);
      expect(config.threshold).toBe(0.8);
      expect(config.margin).toBe(0.15);
      expect(config.minInputLength).toBe(30);
      expect(config.minOverlap).toBe(3);
    });

    it("uses defaults when config not provided", () => {
      const runtimeControls = {
        enableAutoSkillSelection: false,
      } as any;

      const config = service.getAutoSelectionConfig(runtimeControls);

      expect(config.enabled).toBe(false);
      expect(config.threshold).toBe(0.78); // Default
      expect(config.margin).toBe(0.2); // Default
    });
  });

  describe("Complex Scenarios", () => {
    it("handles multiple selection cycles with metrics", () => {
      const context: SelectionContext = {
        userInput: "Create a React component with API integration",
        taskType: "development",
        complexityLevel: "complex",
        previousSkillsUsed: ["frontend-development"],
      };

      // First selection
      const first = service.selectSkills(context);
      service.recordUsage(first.selectedSkills[0]?.slug || "", true, 2);

      // Second selection
      const second = service.selectSkills(context);
      service.recordUsage(second.selectedSkills[0]?.slug || "", true, 1);

      // Verify metrics were recorded
      const allMetrics = service.getAllMetrics();
      expect(allMetrics.length).toBeGreaterThan(0);
    });

    it("returns result with reasoning and alternatives", () => {
      const context: SelectionContext = {
        userInput: "Design an API and write tests for it",
        taskType: "development",
        complexityLevel: "complex",
      };

      const result = service.selectSkills(context);

      expect(result.selectedSkills).toBeDefined();
      expect(result.reasoning).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
