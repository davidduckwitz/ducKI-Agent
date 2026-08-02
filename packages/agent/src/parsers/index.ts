/**
 * Parsers package
 *
 * Provides specialized parsers for LLM outputs, including:
 * - ThinkBlockParser: Extracts and structures think/reasoning blocks
 */

export {
  ThinkBlockParser,
  type ThinkBlock,
  type ToolCallReference,
  type ParseResult,
} from "./think-block-parser.js";
