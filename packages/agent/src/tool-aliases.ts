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
  task: {
    list_all: "list",
    list_tasks: "list",
    get_all: "list",
    all: "list",
  },
  gateway: {
    gateway_send: "send",
    send_discord: "send",
  },
};

export function resolveToolAlias(toolName: string): string {
  return TOOL_ALIAS_MAP.get(toolName.trim().toLowerCase()) ?? toolName.trim().toLowerCase();
}

export function resolveToolAction(toolName: string, action: string): string | undefined {
  const normalizedTool = resolveToolAlias(toolName);
  return TOOL_ACTION_ALIAS_MAP[normalizedTool]?.[action.trim().toLowerCase()];
}
