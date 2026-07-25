export type ToolAliasEntry = {
  canonicalTool: string;
  aliases: string[];
  notes?: string;
};

export const TOOL_ALIAS_TABLE: ToolAliasEntry[] = [
  {
    canonicalTool: "filesystem",
    aliases: [
      "read",
      "readfile",
      "read_file",
      "write",
      "writefile",
      "write_file",
      "append",
      "appendfile",
      "append_file",
      "edit",
      "editfile",
      "edit_file",
      "str_replace",
      "replace_in_file",
      "delete",
      "deletefile",
      "delete_file",
      "removefile",
      "remove_file",
      "list",
      "listdir",
      "list_dir",
      "mkdir",
      "makedir",
      "make_dir",
      "create_dir",
      "create_directory",
      "exists",
      "existsfile",
      "exists_file",
      "stat",
      "statfile",
      "stat_file",
      "move",
      "movefile",
      "move_file",
      "copy",
      "copyfile",
      "copy_file",
    ],
    notes: "Normalizes common file-system command variants and file_path/file_path inputs.",
  },
  {
    canonicalTool: "http",
    aliases: ["http_get", "http_post", "http_put", "http_patch", "http_delete"],
    notes: "Maps HTTP verb-style tool names onto the HTTP executor.",
  },
  {
    canonicalTool: "shell",
    aliases: ["bash", "sh", "zsh", "pwsh", "powershell", "ps"],
    notes: "Accepts POSIX and PowerShell-style shell tool names.",
  },
  {
    canonicalTool: "skill_manage",
    aliases: ["skill", "skills"],
    notes: "Legacy skill shorthand.",
  },
  {
    canonicalTool: "history",
    aliases: ["chat_history", "conversation_history", "history_search", "chat-history", "conversation-history"],
    notes: "Search and history lookup shortcuts.",
  },
  {
    canonicalTool: "gateway",
    aliases: ["gateway", "discord", "discord_gateway", "gateway_send", "send_discord"],
    notes: "Messaging gateway outbound/list operations.",
  },
  {
    canonicalTool: "task",
    aliases: ["task", "list_all", "list_tasks", "get_all", "all"],
    notes: "Task listing aliases are action-normalized separately.",
  },
  {
    canonicalTool: "browser",
    aliases: ["browser_tool", "web", "navigate", "puppeteer", "web_driver"],
    notes: "Browser automation and web interaction tool.",
  },
  {
    canonicalTool: "memory",
    aliases: ["remember", "memorize", "recall", "memory_search"],
    notes: "Agent memory and knowledge recall.",
  },
  {
    canonicalTool: "project",
    aliases: ["project_management", "project_info", "project_status"],
    notes: "Project management and information retrieval.",
  },
  {
    canonicalTool: "cronjob",
    aliases: ["cron", "schedule", "scheduled_task", "schedule_task"],
    notes: "Scheduled task and cron job management.",
  },
  {
    canonicalTool: "mcp",
    aliases: ["model_context_protocol", "mcp_tool", "mcp_call"],
    notes: "Model Context Protocol integration.",
  },
];

export const TOOL_ALIAS_MAP = new Map<string, string>(
  TOOL_ALIAS_TABLE.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.canonicalTool] as const))
);

export const TOOL_ACTION_ALIAS_MAP: Record<string, Record<string, string>> = {
  filesystem: {
    readfile: "read",
    read_file: "read",
    writefile: "write",
    write_file: "write",
    appendfile: "append",
    append_file: "append",
    editfile: "edit",
    edit_file: "edit",
    str_replace: "edit",
    replace_in_file: "edit",
    deletefile: "delete",
    delete_file: "delete",
    removefile: "delete",
    remove_file: "delete",
    listdir: "list",
    list_dir: "list",
    makedir: "mkdir",
    make_dir: "mkdir",
    create_dir: "mkdir",
    create_directory: "mkdir",
    statfile: "stat",
    stat_file: "stat",
    movefile: "move",
    move_file: "move",
    copyfile: "copy",
    copy_file: "copy",
    existsfile: "exists",
    exists_file: "exists",
  },
  http: {
    http_get: "get",
    http_post: "post",
    http_put: "put",
    http_patch: "patch",
    http_delete: "delete",
  },
  project: {
    list_all: "list",
    list_projects: "list",
    get_all: "list",
    all: "list",
    new_project: "create",
    add_project: "create",
    new: "create",
    add: "create",
    get_project: "get",
    fetch_project: "get",
    fetch: "get",
    find: "get",
    show: "get",
    edit_project: "update",
    modify: "update",
    modify_project: "update",
    remove_project: "delete",
    remove: "delete",
    destroy: "delete",
  },
  task: {
    list_all: "list",
    list_tasks: "list",
    get_all: "list",
    all: "list",
    new_task: "create",
    add_task: "create",
    new: "create",
    add: "create",
    get_task: "get",
    fetch_task: "get",
    fetch: "get",
    find: "get",
    show: "get",
    edit_task: "update",
    modify: "update",
    modify_task: "update",
    finish: "complete",
    finish_task: "complete",
    done: "complete",
    complete_task: "complete",
    begin: "start",
    begin_task: "start",
    start_task: "start",
    run: "start",
    error: "fail",
    fail_task: "fail",
    remove_task: "delete",
    remove: "delete",
    destroy: "delete",
    cancel: "delete",
  },
  gateway: {
    gateway_send: "send",
    send_discord: "send",
    list_configs: "list_configs",
  },
};

export function resolveToolAlias(toolName: string): string {
  return TOOL_ALIAS_MAP.get(toolName.trim().toLowerCase()) ?? toolName.trim().toLowerCase();
}

/**
 * Normalizes an LLM-emitted action token to snake_case so alias lookups don't miss
 * on casing alone (e.g. "createProject", "CREATE_PROJECT" and "create_project" all
 * become "create_project"). LLMs mix naming conventions constantly across turns, and
 * without this normalization the exact-string alias maps below only ever match the
 * one casing they were written for.
 */
export function normalizeActionToken(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Resolves an action string to its canonical form for a given tool, handling both
 * casing drift (via normalizeActionToken) and the tool-name being folded into the
 * action itself (e.g. "create_project" / "project_create" -> "create" for the
 * "project" tool). Falls back to the normalized token unchanged when nothing in
 * TOOL_ACTION_ALIAS_MAP matches, so a genuinely-canonical action like "list" still
 * passes through untouched.
 */
export function resolveCanonicalAction(toolName: string, rawAction: unknown): string {
  const tool = resolveToolAlias(toolName);
  const normalized = normalizeActionToken(rawAction);
  if (!normalized) return normalized;

  const aliasTable = TOOL_ACTION_ALIAS_MAP[tool];
  if (aliasTable?.[normalized]) return aliasTable[normalized];

  // Strip a leading/trailing "<tool>_" segment (e.g. "project_create" / "create_project")
  // before re-checking the alias table and giving up.
  const withoutToolPrefix = normalized.startsWith(`${tool}_`) ? normalized.slice(tool.length + 1) : normalized;
  const withoutToolSuffix = normalized.endsWith(`_${tool}`) ? normalized.slice(0, -(tool.length + 1)) : normalized;

  if (aliasTable?.[withoutToolPrefix]) return aliasTable[withoutToolPrefix];
  if (aliasTable?.[withoutToolSuffix]) return aliasTable[withoutToolSuffix];
  if (withoutToolPrefix !== normalized) return withoutToolPrefix;
  if (withoutToolSuffix !== normalized) return withoutToolSuffix;

  return normalized;
}

export function resolveToolAction(toolName: string, action: string): string | undefined {
  const normalizedTool = resolveToolAlias(toolName);
  return TOOL_ACTION_ALIAS_MAP[normalizedTool]?.[action.trim().toLowerCase()];
}
