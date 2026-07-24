import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export interface PromptContent {
  system: string;
  agentBehavior: string;
  humanInfo: string;
}

export class PromptManager {
  private prompts: PromptContent = {
    system: "",
    agentBehavior: "",
    humanInfo: "",
  };
  private promptsDir: string;
  private promptsLoaded = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {
    this.promptsDir = resolve(process.cwd(), "prompts");
  }

  async initialize(): Promise<void> {
    try {
      await this.loadFromFiles();
      if (!this.promptsLoaded) {
        await this.fallbackToDatabase();
      }
    } catch (error) {
      this.logger.warn("PromptManager initialization failed, falling back to database", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.fallbackToDatabase();
    }
  }

  async getPrompt(type: "system" | "agent" | "human"): Promise<string> {
    if (!this.promptsLoaded) {
      await this.initialize();
    }

    if (type === "system") return this.prompts.system;
    if (type === "agent") return this.prompts.agentBehavior;
    if (type === "human") return this.prompts.humanInfo;
    return "";
  }

  async savePrompt(type: "system" | "agent" | "human", content: string): Promise<void> {
    const normalized = content.trim();

    if (type === "system") {
      this.prompts.system = normalized;
      await this.saveToFile("system.md", normalized);
      await this.saveToDatabase("system", normalized);
    } else if (type === "agent") {
      this.prompts.agentBehavior = normalized;
      await this.saveToFile("agent.md", normalized);
      await this.saveToDatabase("agent", normalized);
    } else if (type === "human") {
      this.prompts.humanInfo = normalized;
      await this.saveToFile("human.md", normalized);
      await this.saveToDatabase("human", normalized);
    }
  }

  private async loadFromFiles(): Promise<void> {
    this.ensurePromptsDir();

    try {
      const systemPath = resolve(this.promptsDir, "system.md");
      if (existsSync(systemPath)) {
        this.prompts.system = readFileSync(systemPath, "utf8");
      }

      const agentPath = resolve(this.promptsDir, "agent.md");
      if (existsSync(agentPath)) {
        this.prompts.agentBehavior = readFileSync(agentPath, "utf8");
      }

      const humanPath = resolve(this.promptsDir, "human.md");
      if (existsSync(humanPath)) {
        this.prompts.humanInfo = readFileSync(humanPath, "utf8");
      }

      if (this.prompts.system || this.prompts.agentBehavior || this.prompts.humanInfo) {
        this.promptsLoaded = true;
        this.logger.info("Prompts loaded from files", {
          systemLoaded: !!this.prompts.system,
          agentLoaded: !!this.prompts.agentBehavior,
          humanLoaded: !!this.prompts.humanInfo,
        });
      }
    } catch (error) {
      this.logger.warn("Failed to load prompts from files", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fallbackToDatabase(): Promise<void> {
    try {
      const allMemories = await this.db.getMemories();

      const agentMemory = allMemories.find(
        (m) =>
          m.content.startsWith("[PROFILE:AGENT_BEHAVIOR]") ||
          m.type === "long-term" ||
          m.content.includes("Agent Behavior")
      );
      if (agentMemory) {
        this.prompts.agentBehavior = agentMemory.content
          .replace(/^\[PROFILE:AGENT_BEHAVIOR\]\s*/, "")
          .trim();
      }

      const humanMemory = allMemories.find(
        (m) =>
          m.content.startsWith("[PROFILE:HUMAN_INFO]") ||
          m.type === "semantic" ||
          m.content.includes("Human Info")
      );
      if (humanMemory) {
        this.prompts.humanInfo = humanMemory.content
          .replace(/^\[PROFILE:HUMAN_INFO\]\s*/, "")
          .trim();
      }

      if (this.prompts.agentBehavior || this.prompts.humanInfo) {
        this.promptsLoaded = true;
        this.logger.info("Prompts loaded from database (fallback)", {
          agentLoaded: !!this.prompts.agentBehavior,
          humanLoaded: !!this.prompts.humanInfo,
        });
      }
    } catch (error) {
      this.logger.warn("Failed to load prompts from database", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveToFile(filename: string, content: string): Promise<void> {
    try {
      this.ensurePromptsDir();
      const filePath = resolve(this.promptsDir, filename);
      writeFileSync(filePath, content, "utf8");
      this.logger.debug("Prompt saved to file", { filename });
    } catch (error) {
      this.logger.warn("Failed to save prompt to file", {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveToDatabase(type: string, content: string): Promise<void> {
    try {
      if (type === "system") {
        await this.db.setSetting("AGENT_SYSTEM_PROMPT", content);
        this.logger.debug("System prompt saved to database");
        return;
      }

      const prefix = type === "agent" ? "[PROFILE:AGENT_BEHAVIOR]" : "[PROFILE:HUMAN_INFO]";
      const memoryType = type === "agent" ? "long-term" : "semantic";
      const importance = 9;

      const allMemories = await this.db.getMemories();
      const existingId = allMemories.find((m) => m.content.startsWith(prefix))?.id;

      if (existingId) {
        await this.db.deleteMemory(existingId);
      }

      await this.db.addMemory({
        content: `${prefix} ${content}`,
        importance,
        type: memoryType,
        status: "approved",
      });

      this.logger.debug("Prompt saved to database", { type });
    } catch (error) {
      this.logger.warn("Failed to save prompt to database", {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensurePromptsDir(): void {
    if (!existsSync(this.promptsDir)) {
      mkdirSync(this.promptsDir, { recursive: true });
    }
  }
}
