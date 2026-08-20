/**
 * Named, independently composable system-prompt fragments - the same block used in
 * every prompt variant (full/compact/minimal) is defined exactly once here instead of
 * being duplicated as an inline string literal in each variant (as it was before).
 * Modeled after Hermes-agent's per-topic GUIDANCE constants: each function returns a
 * self-contained block (or "" when not applicable), always appended in the same order.
 */

/** The task/tool-usage rules block appended to every system-prompt variant (full/compact/minimal). */
export function taskRulesGuidance(): string {
  return (
    "\n\n## Task Rules\n" +
    "- Create a project before creating project-specific tasks when the work should be tracked long-term.\n" +
    "- Mark a task running before execution and completed or failed when finished.\n" +
    "- Persist results in the database so the UI can show progress.\n" +
    "- Use tools whenever state must change.\n" +
    "- Never repeat the exact same tool call more than once without changing input or strategy.\n" +
    "- If a tool fails, correct parameters based on the error before retrying.\n" +
    "- If /workflow-orchestrator is loaded, first drive the workflow lifecycle (list/get/create/update/run/resume) before unrelated tools.\n" +
    "- For stable user or workflow facts, use memory tool actions to recall or curate durable memory.\n" +
    "- Treat only explicit requests to send, post, answer, or reply on Discord as outbound gateway operations, not normal chat replies.\n" +
    "- For Discord/gateway outbound send requests, always run gateway action=list_configs before gateway action=send in the same run.\n" +
    "- If the Discord target is unclear, ask for the target channel instead of guessing.\n" +
    "- Never guess localhost/default Discord endpoints if gateway configs exist; rely on gateway tool diagnostics and configured transports."
  );
}

export type PlatformChannel = "discord" | "telegram" | "slack" | "signal" | "web" | "cli";

const PLATFORM_HINTS: Partial<Record<PlatformChannel, string>> = {
  discord: "You are replying on Discord. Standard markdown renders natively; keep messages concise (Discord truncates very long messages) and avoid huge tables.",
  telegram: "You are replying on Telegram. Use simple markdown (bold/italic/links); avoid deeply nested lists or wide tables, they render poorly on mobile.",
  slack: "You are replying on Slack. Use Slack-flavored formatting sparingly (*bold*, _italic_); keep messages short and scannable.",
  signal: "You are replying on Signal. Plain text reads best; avoid markdown syntax since it is not rendered.",
  cli: "You are replying in a terminal/CLI session. Avoid wide tables and heavy markdown; plain, scannable text works best.",
};

/**
 * Short, channel-specific formatting guidance - only included when the current
 * conversation's delivery channel is known. Mirrors Hermes-agent's PLATFORM_HINTS
 * dict; "web" (the default chat UI) has no hint since it renders full markdown fine.
 */
export function platformHintGuidance(channel: PlatformChannel | undefined): string {
  if (!channel) return "";
  const hint = PLATFORM_HINTS[channel];
  return hint ? `\n\n## Platform Hint\n${hint}` : "";
}
