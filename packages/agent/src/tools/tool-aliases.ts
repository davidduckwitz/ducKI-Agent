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
    aliases: ["task", "tasks", "task_split", "list_all", "list_tasks", "get_all", "all"],
    notes: "Task management - actions are normalized separately (list, create, split, etc).",
  },
  {
    canonicalTool: "browser",
    aliases: ["browser_tool", "browser_control", "web", "navigate", "puppeteer", "web_driver"],
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
  {
    canonicalTool: "push_notification",
    aliases: ["push-notification", "notify", "notification", "send_notification", "push_notify"],
    notes: "Browser push notification to the Cloud Voice-App.",
  },
];

export const TOOL_ALIAS_MAP = new Map<string, string>(
  TOOL_ALIAS_TABLE.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.canonicalTool] as const))
);

export const TOOL_ACTION_ALIAS_MAP: Record<string, Record<string, string>> = {
  http: {
    http_get: "get",
    http_post: "post",
    http_put: "put",
    http_patch: "patch",
    http_delete: "delete",
    request: "get",
    fetch: "get",
    download: "get",
    upload: "post",
    update: "put",
  },
  filesystem: {
    // Read aliases
    readfile: "read",
    read_file: "read",
    openfile: "read",
    open_file: "read",
    cat: "read",
    show: "read",
    view: "read",
    // Write aliases
    writefile: "write",
    write_file: "write",
    create: "write",
    create_file: "write",
    overwrite: "write",
    // Append aliases
    appendfile: "append",
    append_file: "append",
    add_to_file: "append",
    concat: "append",
    // Edit aliases
    editfile: "edit",
    edit_file: "edit",
    str_replace: "edit",
    replace_in_file: "edit",
    substitute: "edit",
    patch: "edit",
    // Delete aliases
    deletefile: "delete",
    delete_file: "delete",
    removefile: "delete",
    remove_file: "delete",
    rm: "delete",
    unlink: "delete",
    // List aliases
    listdir: "list",
    list_dir: "list",
    ls: "list",
    dir: "list",
    list_files: "list",
    files: "list",
    // Make directory aliases
    makedir: "mkdir",
    make_dir: "mkdir",
    create_dir: "mkdir",
    create_directory: "mkdir",
    md: "mkdir",
    // Exists aliases
    existsfile: "exists",
    exists_file: "exists",
    file_exists: "exists",
    // Stat aliases
    statfile: "stat",
    stat_file: "stat",
    file_stat: "stat",
    info: "stat",
    // Move aliases
    movefile: "move",
    move_file: "move",
    rename: "move",
    mv: "move",
    // Copy aliases
    copyfile: "copy",
    copy_file: "copy",
    cp: "copy",
    duplicate: "copy",
    // Glob aliases
    find: "glob",
    search_files: "glob",
    pattern: "glob",
    // Grep aliases
    search: "grep",
    search_text: "grep",
    search_content: "grep",
    find_text: "grep",
  },
  git: {
    // Status aliases
    st: "status",
    state: "status",
    // Add aliases
    stage: "add",
    track: "add",
    // Commit aliases
    save: "commit",
    checkin: "commit",
    // Push aliases
    upload: "push",
    sync_up: "push",
    // Pull aliases
    download: "pull",
    sync_down: "pull",
    sync: "pull",
    fetch: "pull",
    // Diff aliases
    show_diff: "diff",
    compare: "diff",
    changes: "diff",
    // Log aliases
    history: "log",
    show_history: "log",
    commits: "log",
    // Branch aliases
    list_branches: "branch",
    branches: "branch",
    // Checkout aliases
    switch: "checkout",
    switch_branch: "checkout",
    co: "checkout",
    // Init aliases
    initialize: "init",
    setup: "init",
  },
  memory: {
    // Query aliases
    search: "query",
    search_memory: "query",
    find: "query",
    recall: "query",
    remember: "query",
    ask: "query",
    query_memories: "query",
    // Add aliases
    store: "add",
    save: "add",
    memorize: "add",
    create: "add",
    // Replace aliases
    update: "replace",
    modify: "replace",
    change: "replace",
    edit: "replace",
    // Remove aliases
    delete: "remove",
    forget: "remove",
    erase: "remove",
    clear: "remove",
    // List aliases
    show: "list",
    all: "list",
    list_memories: "list",
    show_all: "list",
  },
  project: {
    // List aliases
    list_all: "list",
    list_projects: "list",
    get_all: "list",
    all: "list",
    show_all: "list",
    projects: "list",
    // Create aliases
    new_project: "create",
    add_project: "create",
    new: "create",
    add: "create",
    make: "create",
    start: "create",
    // Get aliases
    get_project: "get",
    fetch_project: "get",
    fetch: "get",
    find: "get",
    show: "get",
    view: "get",
    // Update aliases
    edit_project: "update",
    modify: "update",
    modify_project: "update",
    change: "update",
    edit: "update",
    // Delete aliases
    remove_project: "delete",
    remove: "delete",
    destroy: "delete",
    rm: "delete",
    // List tasks within project
    list_tasks: "list_tasks",
    list_project_tasks: "list_tasks",
    tasks: "list_tasks",
  },
  task: {
    // List aliases
    list_all: "list",
    list_tasks: "list",
    get_all: "list",
    all: "list",
    show_all: "list",
    tasks: "list",
    // Create aliases
    new_task: "create",
    add_task: "create",
    new: "create",
    add: "create",
    make: "create",
    create_task: "create",
    // Get aliases
    get_task: "get",
    fetch_task: "get",
    fetch: "get",
    find: "get",
    show: "get",
    view: "get",
    // Update aliases
    edit_task: "update",
    modify: "update",
    modify_task: "update",
    change: "change",
    edit: "update",
    set: "update",
    // Start aliases
    begin: "start",
    begin_task: "start",
    start_task: "start",
    run: "start",
    launch: "start",
    initiate: "start",
    // Complete aliases
    finish: "complete",
    finish_task: "complete",
    done: "complete",
    complete_task: "complete",
    mark_done: "complete",
    mark_completed: "complete",
    close: "complete",
    // Fail aliases
    error: "fail",
    fail_task: "fail",
    mark_failed: "fail",
    break: "fail",
    // Delete aliases
    remove_task: "delete",
    remove: "delete",
    destroy: "delete",
    cancel: "delete",
    rm: "delete",
    // Split aliases
    breakdown: "split",
    decompose: "split",
    subdivide: "split",
  },
  gateway: {
    // Send aliases
    gateway_send: "send",
    send_discord: "send",
    send_message: "send",
    post: "send",
    message: "send",
    notify: "send",
    // List config aliases
    list_configs: "list_configs",
    list_config: "list_configs",
    list_gateways: "list_configs",
    show_configs: "list_configs",
  },
  history: {
    // List conversations aliases
    list: "list_conversations",
    list_all: "list_conversations",
    all: "list_conversations",
    show_all: "list_conversations",
    conversations: "list_conversations",
    // Get conversation aliases
    get: "get_conversation",
    get_conversation: "get_conversation",
    fetch: "get_conversation",
    show: "get_conversation",
    view: "get_conversation",
    // Get messages aliases
    get_messages: "get_messages",
    messages: "get_messages",
    show_messages: "get_messages",
    fetch_messages: "get_messages",
    // Search aliases
    find: "search",
    search_history: "search",
    search_messages: "search",
    query: "search",
    lookup: "search",
  },
  browser: {
    // Navigation aliases
    navigate: "goto",
    nav: "goto",
    go: "goto",
    open: "goto",
    visit: "goto",
    load: "goto",
    search: "goto",
    query: "goto",
    browse: "goto",
    // Screenshot/capture aliases
    snap: "screenshot",
    img: "screenshot",
    capture: "screenshot",
    get_screenshot: "screenshot",
    take_screenshot: "screenshot",
    photo: "screenshot",
    // Content extraction aliases
    get_page_content: "evaluate",
    get_content: "evaluate",
    get_html: "evaluate",
    get_text: "evaluate",
    extract: "evaluate",
    scrape: "evaluate",
    read_page: "evaluate",
    analyze: "evaluate",
    inspect: "evaluate",
    // Evaluation/script aliases
    eval: "evaluate",
    execute: "evaluate",
    run_script: "evaluate",
    execute_script: "evaluate",
    run: "evaluate",
    // Form filling aliases
    fill_form: "form_fill",
    submit_form: "form_fill",
    fill: "form_fill",
    form_submit: "form_fill",
    // Click aliases
    select: "click",
    tap: "click",
    press_button: "click",
    click_button: "click",
    // Keyboard aliases
    keystroke: "press",
    press_key: "press",
    key: "press",
    // Type aliases
    input: "type",
    enter_text: "type",
    text: "type",
    type_text: "type",
    // Wait aliases
    wait_for: "wait",
    wait_for_selector: "wait",
    delay: "wait",
    pause: "wait",
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
