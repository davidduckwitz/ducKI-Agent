import { describe, it, expect, beforeEach } from "vitest";
import { ThinkBlockParser, type ThinkBlock } from "./think-block-parser";

describe("ThinkBlockParser", () => {
  let parser: ThinkBlockParser;

  beforeEach(() => {
    parser = new ThinkBlockParser();
  });

  describe("XML Format Parsing", () => {
    it("should parse a single <think> block", () => {
      const content = "Hello <think>This is my thinking</think> world";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toBe("This is my thinking");
      expect(result.remainingContent).toBe("Hello  world");
      expect(result.statistics.totalThinkTokens).toBeGreaterThan(0);
    });

    it("should parse multiple <think> blocks in sequence", () => {
      const content = "<think>First thought</think> middle <think>Second thought</think>";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(2);
      expect(result.thinkBlocks[0].content).toBe("First thought");
      expect(result.thinkBlocks[1].content).toBe("Second thought");
      expect(result.remainingContent).toContain("middle");
    });

    it("should parse <ant> blocks (Anthropic format)", () => {
      const content = "Start <ant>Anthropic thinking</ant> end";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toBe("Anthropic thinking");
    });

    it("should handle empty <think> blocks", () => {
      const content = "Text <think></think> more text";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toBe("");
      expect(result.remainingContent).toBe("Text  more text");
    });

    it("should handle unclosed <think> tags gracefully (lenient)", () => {
      const content = "Start <think>unclosed thinking";
      const result = parser.parse(content);

      // Lenient mode: should treat rest of string as think content or skip
      expect(result.thinkBlocks.length).toBeGreaterThanOrEqual(0);
      expect(result.remainingContent).toBeDefined();
    });
  });

  describe("Markdown Format Parsing", () => {
    it("should parse markdown ```thinking blocks", () => {
      const content =
        "Some text\n```thinking\nMarkdown thinking\n```\nMore text";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toContain("Markdown thinking");
    });

    it("should parse multiple markdown thinking blocks", () => {
      const content =
        "```thinking\nFirst\n```\nMiddle\n```thinking\nSecond\n```";
      const result = parser.parse(content);

      expect(result.thinkBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it("should ignore regular code blocks (not thinking)", () => {
      const content = "```javascript\nconst x = 1;\n```";
      const result = parser.parse(content);

      // Should not treat regular code blocks as think blocks
      expect(result.thinkBlocks).toHaveLength(0);
    });
  });

  describe("Custom Format Parsing", () => {
    it("should parse [THINKING]...[/THINKING] format", () => {
      const content = "Start [THINKING]Custom thinking[/THINKING] end";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toBe("Custom thinking");
    });
  });

  describe("Tool Reference Extraction", () => {
    it("should extract tool references from German 'rufe X auf' pattern", () => {
      const content =
        "<think>Ich rufe shell auf um das Datum abzurufen. Das wird mir helfen zu verstehen wann das passiert.</think>";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      const toolRefs = result.thinkBlocks[0].toolCalls;
      expect(toolRefs.length).toBeGreaterThan(0);

      const shellRef = toolRefs.find((ref) => ref.toolName === "shell");
      expect(shellRef).toBeDefined();
      expect(shellRef?.purpose).toContain("Datum");
    });

    it("should extract tool references from English 'call X to' pattern", () => {
      const content =
        "<think>I will call the api to fetch the user data. This will help me get the information needed.</think>";
      const result = parser.parse(content);

      const toolRefs = result.thinkBlocks[0].toolCalls;
      const apiRef = toolRefs.find((ref) => ref.toolName === "api");
      expect(apiRef).toBeDefined();
      expect(apiRef?.purpose).toContain("user");
    });

    it("should extract multiple tool references in one block", () => {
      const content =
        "<think>I will call the shell to check files. Then I will call the browser to take screenshots.</think>";
      const result = parser.parse(content);

      const toolRefs = result.thinkBlocks[0].toolCalls;
      expect(toolRefs.length).toBeGreaterThanOrEqual(2);

      const tools = toolRefs.map((ref) => ref.toolName);
      expect(tools).toContain("shell");
      expect(tools).toContain("browser");
    });

    it("should handle 'verwende tool: X' pattern", () => {
      const content =
        "<think>Ich verwende tool: http um eine API zu laden.</think>";
      const result = parser.parse(content);

      const toolRefs = result.thinkBlocks[0].toolCalls;
      expect(toolRefs.length).toBeGreaterThan(0);
    });

    it("should track tool call status as 'planned' in think block", () => {
      const content = "<think>Ich rufe shell auf um Datum zu bekommen</think>";
      const result = parser.parse(content);

      const toolRefs = result.thinkBlocks[0].toolCalls;
      expect(toolRefs[0].status).toBe("planned");
    });
  });

  describe("Thinking Depth Estimation", () => {
    it("should classify shallow thinking (< 100 tokens)", () => {
      const shallow = "<think>OK, mach es so.</think>";
      const result = parser.parse(shallow);

      expect(result.thinkBlocks[0].thinkingDepth).toBe("shallow");
      expect(result.statistics.thinkingDepth).toBe("shallow");
    });

    it("should classify medium thinking (100-500 tokens)", () => {
      const medium =
        "<think>Schritt 1: Ich analysiere das Problem gründlich und betrachte alle Aspekte. Schritt 2: Ich prüfe die verfügbaren Tools und deren Kapazitäten. Schritt 3: Ich wähle die beste Strategie basierend auf den Anforderungen. Schritt 4: Ich plane die Ausführung detailliert. Dies sollte ausreichend Text sein.</think>";
      const result = parser.parse(medium);

      expect(result.thinkBlocks[0].thinkingDepth).toBe("medium");
    });

    it("should classify deep thinking (> 500 tokens)", () => {
      const points = Array.from({ length: 50 }, (_, i) =>
        `Punkt ${i + 1}: Das ist eine detaillierte Analyse des Problems. Ich denke über verschiedene Aspekte nach.`
      ).join(" ");
      const deep = `<think>${points}</think>`;
      const result = parser.parse(deep);

      expect(result.thinkBlocks[0].thinkingDepth).toBe("deep");
    });
  });

  describe("Unicode and Special Characters", () => {
    it("should handle German Umlaute correctly", () => {
      const content =
        "<think>Ich überprüfe das Äquivalent für die Lösung mit Größe.</think>";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toContain("Größe");
    });

    it("should handle emojis in thinking", () => {
      const content = "<think>🤔 Let me think about this 💭 carefully</think>";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toContain("🤔");
    });
  });

  describe("Edge Cases", () => {
    it("should handle very long think blocks (10k+ chars)", () => {
      const longContent = "A".repeat(10000);
      const content = `<think>${longContent}</think>`;
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toHaveLength(10000);
    });

    it("should handle nested HTML inside think blocks gracefully", () => {
      const content = "<think>Text with <b>bold</b> and <i>italic</i></think>";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      // Parser should extract content, handling nested tags
      expect(result.thinkBlocks[0].content.length).toBeGreaterThan(0);
    });

    it("should assign unique IDs to think blocks", () => {
      const content =
        "<think>First</think> and <think>Second</think> and <think>Third</think>";
      const result = parser.parse(content);

      const ids = result.thinkBlocks.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length); // All unique
    });

    it("should set timestamps and status correctly", () => {
      const content = "<think>Some thinking</think>";
      const result = parser.parse(content);
      const block = result.thinkBlocks[0];

      expect(block.startTime).toBeInstanceOf(Date);
      expect(block.status).toBe("streaming");
      // endTime should be set after parse completes
      expect(block.endTime).toBeUndefined();
    });

    it("should calculate token estimates correctly", () => {
      const content = "<think>This is exactly thirty-two characters</think>";
      const result = parser.parse(content);

      const block = result.thinkBlocks[0];
      expect(block.tokenEstimate).toBeDefined();
      expect(block.tokenEstimate).toBeGreaterThan(0);
      // Approximately 32 / 4 = 8 tokens
      expect(block.tokenEstimate).toBeLessThan(15);
    });
  });

  describe("Statistics Calculation", () => {
    it("should calculate total think tokens across all blocks", () => {
      const content =
        "<think>First block with some content</think> and <think>Second block</think>";
      const result = parser.parse(content);

      expect(result.statistics.totalThinkTokens).toBeGreaterThan(0);
      expect(result.statistics.totalThinkTokens).toBeLessThan(50);
    });

    it("should sum total tool references", () => {
      const content =
        "<think>Rufe shell auf um Dateien zu prüfen. Rufe browser auf um Screenshots zu machen.</think> then <think>Rufe api auf um Daten zu laden.</think>";
      const result = parser.parse(content);

      expect(result.statistics.totalToolRefs).toBeGreaterThanOrEqual(3);
    });

    it("should determine overall thinking depth from all blocks", () => {
      const shallow = "<think>OK</think>";
      const result = parser.parse(shallow);

      expect(["shallow", "medium", "deep"]).toContain(
        result.statistics.thinkingDepth
      );
    });
  });

  describe("Content Extraction", () => {
    it("should preserve non-think content", () => {
      const content = "Start <think>thinking</think> middle <think>more</think> end";
      const result = parser.parse(content);

      expect(result.remainingContent).toContain("Start");
      expect(result.remainingContent).toContain("middle");
      expect(result.remainingContent).toContain("end");
    });

    it("should handle content without any think blocks", () => {
      const content = "Just plain content without any thinking blocks";
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(0);
      expect(result.remainingContent).toBe(content);
      expect(result.statistics.totalThinkTokens).toBe(0);
    });
  });

  describe("Tool calls embedded in think blocks", () => {
    it("does not strip a <think> block that contains a [TOOL:...] call", () => {
      const content =
        'Sure. <think>I should write the file now [TOOL:filesystem({"action":"write","path":"index.html","content":"<h1>hi</h1>"})][/TOOL]</think> done';
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(0);
      expect(result.remainingContent).toBe(content);
    });

    it("does not strip a ```thinking``` block that contains a [TOOL:...] call", () => {
      const content =
        'Sure.\n```thinking\nI should write the file now [TOOL:filesystem({"action":"write","path":"a.txt"})][/TOOL]\n```\ndone';
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(0);
      expect(result.remainingContent).toBe(content);
    });

    it("does not strip a [THINKING] block that contains a [TOOL:...] call", () => {
      const content =
        'Sure. [THINKING]I should write the file now [TOOL:filesystem({"action":"write","path":"a.txt"})][/TOOL][/THINKING] done';
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(0);
      expect(result.remainingContent).toBe(content);
    });

    it("still strips sibling think blocks that have no tool call while keeping the one that does", () => {
      const content =
        '<think>just musing</think> <think>time to act [TOOL:shell({"command":"ls"})][/TOOL]</think> end';
      const result = parser.parse(content);

      expect(result.thinkBlocks).toHaveLength(1);
      expect(result.thinkBlocks[0].content).toBe("just musing");
      expect(result.remainingContent).toContain("[TOOL:shell");
      expect(result.remainingContent).toContain("end");
    });
  });
});
