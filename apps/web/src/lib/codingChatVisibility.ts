import type { RenderedChatMessage } from "../components/chat/chatTypes";

/**
 * Model-steering prompts are persisted as user-role messages because the LLM must see them,
 * but they are not user-authored turns and must never be rendered as "DU" in the coding chat.
 * `runtimeContext` is retained as a read-side fallback for rows written by versions that
 * accidentally replaced the `internal` flag while persisting the prompt.
 */
export function isInternalCodingUserMessage(message: RenderedChatMessage): boolean {
  return (
    message.role === "user" &&
    (message.metadata?.["internal"] === true || message.metadata?.["runtimeContext"] === true)
  );
}

/** The coding transcript contains user-authored prompts and user-facing agent output only. */
export function isVisibleCodingChatMessage(message: RenderedChatMessage): boolean {
  if (message.role === "assistant") return true;
  return message.role === "user" && !isInternalCodingUserMessage(message);
}
