import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/**
 * Character-count approximation of token usage, used only when a server reports none.
 *
 * ~3.6 characters per token is a reasonable middle ground for the mixed German/English
 * text and code this agent produces (pure English runs closer to 4, German compounds and
 * code closer to 3). It is deliberately rough: the point is to replace a hard 0 - which
 * makes the chat's token display worthless for local models - with a number of the right
 * magnitude, flagged as an estimate by the caller.
 */
const CHARS_PER_TOKEN = 3.6;

/** Per-message overhead for the role/format scaffolding around the content. */
const TOKENS_PER_MESSAGE = 4;

function countChars(content: ChatCompletionMessageParam["content"]): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part) => {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return sum + part.text.length;
    }
    // Image parts carry a data URI whose length says nothing about its token cost.
    return sum;
  }, 0);
}

export function estimateUsage(
  messages: ChatCompletionMessageParam[],
  completion: string
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const promptChars = messages.reduce((sum, message) => sum + countChars(message.content), 0);
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN) + messages.length * TOKENS_PER_MESSAGE;
  const completionTokens = Math.ceil(completion.length / CHARS_PER_TOKEN);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
