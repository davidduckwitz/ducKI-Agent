/**
 * Names of every hand-coded built-in tool. Anything registering a tool at
 * runtime from user/agent-authored sources (tool_factory dynamic tools,
 * script-backed tools/<name>/TOOL.md) must refuse to shadow one of these -
 * shared here so both registration paths enforce the same boundary instead of
 * maintaining separate copies that can drift.
 */
export const RESERVED_TOOL_NAMES = new Set([
  "browser",
  "memory",
  "project",
  "task",
  "history",
  "gateway",
  "filesystem",
  "http",
  "git",
  "shell",
  "skill_manage",
  "mcp",
  "workflow",
  "cronjob",
  "tool_factory",
]);
