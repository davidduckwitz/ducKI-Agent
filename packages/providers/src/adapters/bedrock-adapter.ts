import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { ProviderOptions } from "../base.js";
import { BaseAdapter } from "./base-adapter.js";

interface BedrockOptions extends ProviderOptions {
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * AWS Bedrock adapter with support for:
 * - Anthropic models via Bedrock
 * - Regional endpoints
 * - Streaming simulation
 */
export class BedrockAdapter extends BaseAdapter {
  readonly name = "bedrock";
  private region: string;

  constructor(options: BedrockOptions) {
    super(options);
    this.region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
  }

  protected override getMaxOutputTokens(): number {
    // Bedrock-hosted Claude models
    if (this.model.includes("claude")) return 4096;
    return 4096;
  }

  protected override getModelFamily(): string {
    return "claude-bedrock";
  }

  /**
   * Convert LLMMessages to Bedrock/Claude format
   */
  protected override normalizeMessages(messages: LLMMessage[]): unknown[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: this.normalizeContent(m.content),
      }));
  }

  /**
   * Main generate method (stub - requires AWS SDK)
   */
  override async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    throw new Error(
      `[${this.name}] Bedrock adapter requires @aws-sdk/client-bedrock-runtime. Install with: npm install @aws-sdk/client-bedrock-runtime`
    );
  }

  /**
   * Streaming generate method (stub)
   */
  override async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    throw new Error(
      `[${this.name}] Bedrock adapter requires @aws-sdk/client-bedrock-runtime. Install with: npm install @aws-sdk/client-bedrock-runtime`
    );
  }

  /**
   * Bedrock supports streaming
   */
  override supportsStreaming(): boolean {
    return true;
  }
}
