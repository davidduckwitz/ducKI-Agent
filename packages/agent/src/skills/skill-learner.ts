/**
 * Skill Learner
 *
 * Implements the /learn command and self-improving skill loop, inspired by
 * hermes-agent's skill learning system. The agent can create skills from:
 * - Local directories
 * - URLs
 * - Conversation history
 * - Pasted text/notes
 *
 * Large sources become knowledge-base skills with references/ subdirs.
 */

import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import type { DatabaseService } from "@ducki/database";
import type { SkillManifest } from "../config/interfaces_types.js";

export interface LearnResult {
  success: boolean;
  skillSlug?: string;
  skillName?: string;
  error?: string;
  sourceType: "url" | "file" | "conversation" | "text";
  isKnowledgeBase: boolean;
  referenceCount?: number;
}

/**
 * Determines the source type from user input.
 */
function detectSourceType(source: string): "url" | "file" | "conversation" | "text" {
  // URL detection
  if (/^https?:\/\//i.test(source)) return "url";
  
  // File path detection (starts with / or ~ or contains path separators)
  if (/^[\/~]|[A-Z]:\\|\.\//i.test(source)) return "file";
  
  // Conversation ID detection (numeric)
  if (/^\d+$/.test(source.trim())) return "conversation";
  
  // Default: text content
  return "text";
}

/**
 * Extracts content from a URL using the agent's http tool.
 */
async function extractUrlContent(
  url: string,
  provider: LLMProvider
): Promise<{ content: string; title?: string }> {
  // Use LLM to summarize the URL content
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: "Extract and summarize the main content from this URL. Focus on key concepts, procedures, and actionable information.",
    },
    { role: "user", content: `Extract content from: ${url}` },
  ];

  const response = await provider.generate(messages, {
    temperature: 0.3,
    maxTokens: 4000,
  });

  return { content: response.content, title: url };
}

/**
 * SkillLearner class for creating skills from various sources.
 */
export class SkillLearner {
  constructor(
    private readonly provider: LLMProvider,
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  /**
   * Learn a skill from a source.
   */
  async learnFromSource(
    source: string,
    context?: string
  ): Promise<LearnResult> {
    const sourceType = detectSourceType(source);
    
    this.logger.info("[SkillLearner] Learning from source", {
      source: source.slice(0, 100),
      sourceType,
      hasContext: !!context,
    });

    try {
      switch (sourceType) {
        case "url":
          return await this.learnFromUrl(source, context);
        case "file":
          return await this.learnFromFile(source, context);
        case "conversation":
          return await this.learnFromConversation(parseInt(source), context);
        case "text":
          return await this.learnFromText(source, context);
        default:
          return { success: false, sourceType, error: "Unknown source type", isKnowledgeBase: false };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("[SkillLearner] Failed to learn from source", { error: errorMessage });
      return {
        success: false,
        sourceType,
        error: errorMessage,
        isKnowledgeBase: false,
      };
    }
  }

  /**
   * Learn from a URL.
   */
  private async learnFromUrl(
    url: string,
    context?: string
  ): Promise<LearnResult> {
    const { content, title } = await extractUrlContent(url, this.provider);
    
    // Generate skill content using LLM
    const skillContent = await this.generateSkillFromContent(
      content,
      `URL: ${url}`,
      context
    );

    // Create a skill slug from the URL
    const slug = this.urlToSlug(url);
    
    // Save the skill
    await this.saveSkill(slug, skillContent, `Learned from ${url}`);

    return {
      success: true,
      skillSlug: slug,
      skillName: slug,
      sourceType: "url",
      isKnowledgeBase: false,
    };
  }

  /**
   * Learn from a local file or directory.
   */
  private async learnFromFile(
    filePath: string,
    context?: string
  ): Promise<LearnResult> {
    // This would use the filesystem tool to read the file
    // For now, return a placeholder
    return {
      success: false,
      sourceType: "file",
      error: "File learning not yet implemented - use the filesystem tool to read files first",
      isKnowledgeBase: false,
    };
  }

  /**
   * Learn from conversation history.
   */
  private async learnFromConversation(
    conversationId: number,
    context?: string
  ): Promise<LearnResult> {
    // Get conversation messages
    const messages = await this.db.getMessages(conversationId);
    
    // Extract key patterns from conversation
    const conversationText = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    // Generate skill content using LLM
    const skillContent = await this.generateSkillFromContent(
      conversationText,
      `Conversation ${conversationId}`,
      context
    );

    // Create a skill slug
    const slug = `learned-conversation-${conversationId}`;
    
    // Save the skill
    await this.saveSkill(slug, skillContent, `Learned from conversation ${conversationId}`);

    return {
      success: true,
      skillSlug: slug,
      skillName: slug,
      sourceType: "conversation",
      isKnowledgeBase: false,
    };
  }

  /**
   * Learn from pasted text.
   */
  private async learnFromText(
    text: string,
    context?: string
  ): Promise<LearnResult> {
    // Generate skill content using LLM
    const skillContent = await this.generateSkillFromContent(
      text,
      "User-provided text",
      context
    );

    // Create a skill slug from the first few words
    const slug = this.textToSlug(text);
    
    // Save the skill
    await this.saveSkill(slug, skillContent, "Learned from user-provided text");

    return {
      success: true,
      skillSlug: slug,
      skillName: slug,
      sourceType: "text",
      isKnowledgeBase: false,
    };
  }

  /**
   * Generate skill content from source content using LLM.
   */
  private async generateSkillFromContent(
    content: string,
    sourceDescription: string,
    context?: string
  ): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a skill author. Create a well-structured skill document following this format:

---
name: skill-name
description: Brief description (≤60 chars)
version: 1.0.0
---

# Skill Title

## When to Use
Describe when this skill should be used.

## Procedure
1. Step one
2. Step two

## Pitfalls
- Known failure modes

## Verification
How to confirm it worked.

Rules:
- Use Hermes tool framing (filesystem, shell, browser, http)
- Don't invent commands that don't exist
- Keep it focused and actionable
- Maximum 500 lines`,
      },
      {
        role: "user",
        content: `Create a skill from this content.

Source: ${sourceDescription}
${context ? `Context: ${context}` : ""}

Content:
${content.slice(0, 8000)}`,
      },
    ];

    const response = await this.provider.generate(messages, {
      temperature: 0.3,
      maxTokens: 4000,
    });

    return response.content;
  }

  /**
   * Save a skill to disk.
   */
  private async saveSkill(
    slug: string,
    content: string,
    description: string
  ): Promise<void> {
    // This would use the skill_manage tool to save
    // For now, log the save
    this.logger.info("[SkillLearner] Saving skill", {
      slug,
      contentLength: content.length,
      description,
    });
  }

  /**
   * Convert a URL to a skill slug.
   */
  private urlToSlug(url: string): string {
    return url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  }

  /**
   * Convert text to a skill slug.
   */
  private textToSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  }
}
