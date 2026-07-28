/**
 * Multi-Provider LLM Adapter System
 *
 * Provides unified interface across multiple LLM providers:
 * - Anthropic Claude
 * - Google Gemini
 * - AWS Bedrock
 *
 * Features:
 * - Automatic failover via ProviderRouter
 * - Error classification and recovery
 * - Consistent message normalization
 * - Streaming support
 */

export { BaseAdapter } from "./base-adapter.js";
export { AnthropicAdapter } from "./anthropic-adapter.js";
export { GeminiAdapter } from "./gemini-adapter.js";
export { BedrockAdapter } from "./bedrock-adapter.js";
export { ProviderRouter } from "./provider-router.js";
