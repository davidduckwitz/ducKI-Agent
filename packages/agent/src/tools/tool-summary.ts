/**
 * One-line, human-readable descriptions of tool calls for the chat UI.
 *
 * Tool events used to carry only the tool name and `Object.keys(input)`, so a coding run
 * rendered as "Detected 2 tool call(s)" followed by "call_1a2b3c: Success" - technically
 * accurate and completely uninformative. What a reader needs is which file was touched
 * and which command ran, which is exactly what the input's primary argument holds.
 */

const MAX_SUMMARY_LENGTH = 120;

function clamp(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Shortens a path to its last two segments: "src/components/App.tsx" stays readable in a
 *  narrow chat column, an absolute Windows path does not. */
function shortPath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Returns e.g. "read …/chat/App.tsx", "shell: npm test", "search 'useEffect'".
 * Falls back to just the action (or the tool name) when no argument stands out.
 */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  const action = str(input, "action");
  const name = toolName.toLowerCase();

  if (name === "shell") {
    const command = str(input, "command");
    return clamp(command ? `$ ${command}` : "shell");
  }

  if (name === "filesystem") {
    const path = str(input, "path") ?? str(input, "filePath") ?? str(input, "file");
    const pattern = str(input, "pattern") ?? str(input, "query");
    if (path) return clamp(`${action ?? "filesystem"} ${shortPath(path)}`);
    if (pattern) return clamp(`${action ?? "search"} "${pattern}"`);
    return clamp(action ?? "filesystem");
  }

  if (name === "git") {
    return clamp(`git ${action ?? ""} ${str(input, "path") ?? ""}`);
  }

  if (name === "http") {
    const url = str(input, "url");
    return clamp(url ? `${str(input, "method") ?? "GET"} ${url}` : "http");
  }

  if (name === "wiki" || name === "memory" || name === "history") {
    const query = str(input, "query") ?? str(input, "content");
    return clamp(query ? `${action ?? name} "${query}"` : `${name} ${action ?? ""}`);
  }

  if (name === "task" || name === "project" || name === "workflow") {
    const label = str(input, "title") ?? str(input, "name") ?? str(input, "id");
    return clamp(label ? `${name} ${action ?? ""} ${label}` : `${name} ${action ?? ""}`);
  }

  const fallback = str(input, "query") ?? str(input, "path") ?? str(input, "name");
  if (action && fallback) return clamp(`${action} ${fallback}`);
  if (action) return clamp(`${name} ${action}`);
  return clamp(fallback ? `${name} ${fallback}` : name);
}
