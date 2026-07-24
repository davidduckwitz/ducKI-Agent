/**
 * Enhanced tool descriptions for better Agent understanding and MCP integration
 */
export const ENHANCED_TOOL_DESCRIPTIONS = {
  task: {
    description: "Manage project tasks - create, list, update, complete, or fail tasks",
    examples: [
      '[TOOL:task({"action": "create", "title": "Implement feature X", "description": "Add feature X to the system", "projectId": 1})]',
      '[TOOL:task({"action": "list", "projectId": 1})]',
      '[TOOL:task({"action": "update", "id": 5, "status": "in_progress"})]',
      '[TOOL:task({"action": "complete", "id": 5})]',
    ],
    actions: {
      create: "Create new task with title, description, and optional projectId",
      list: "List tasks, optionally filtered by projectId or status",
      get: "Get details of a specific task by id",
      update: "Update task status, priority, result, or reassign",
      start: "Mark task as in_progress",
      complete: "Mark task as completed with optional result",
      fail: "Mark task as failed with error details",
      delete: "Delete a task",
    },
  },

  project: {
    description: "Manage projects - create, list, view, and update project information",
    examples: [
      '[TOOL:project({"action": "create", "name": "My Project", "description": "Project description"})]',
      '[TOOL:project({"action": "list"})]',
      '[TOOL:project({"action": "get", "id": 1})]',
      '[TOOL:project({"action": "update", "id": 1, "name": "Updated Name"})]',
    ],
    actions: {
      create: "Create new project with name and optional description",
      list: "List all projects",
      get: "Get details of a specific project",
      update: "Update project metadata (name, description, folder)",
      delete: "Delete a project and its tasks",
    },
  },

  shell: {
    description: "Execute shell commands (bash, PowerShell, sh, zsh) to run system operations",
    examples: [
      '[TOOL:shell({"command": "ls -la"})]',
      '[TOOL:shell({"command": "npm run build"})]',
      '[TOOL:shell({"command": "git status"})]',
    ],
    notes: [
      "On Windows, use PowerShell-compatible commands or bash syntax",
      "Commands run with timeout (default 120s, configurable)",
      "Returns both stdout and stderr",
      "Use for file operations, package management, and system tasks",
    ],
  },

  http: {
    description: "Make HTTP requests (GET, POST, PUT, PATCH, DELETE) to APIs and web services",
    examples: [
      '[TOOL:http({"action": "get", "url": "https://api.example.com/data"})]',
      '[TOOL:http({"action": "post", "url": "https://api.example.com/users", "body": {"name": "John"}})]',
      '[TOOL:http({"action": "put", "url": "https://api.example.com/users/1", "body": {"name": "Jane"}})]',
    ],
    actions: {
      get: "Fetch data from an endpoint",
      post: "Send data to create a new resource",
      put: "Replace an entire resource",
      patch: "Partially update a resource",
      delete: "Delete a resource",
    },
  },

  memory: {
    description: "Manage agent memory - store, query, update, and retrieve long-term information",
    examples: [
      '[TOOL:memory({"action": "add", "content": "User prefers dark mode"})]',
      '[TOOL:memory({"action": "query", "query": "user preferences"})]',
      '[TOOL:memory({"action": "list"})]',
      '[TOOL:memory({"action": "batch", "operations": [{"action": "add", "content": "fact 1"}]})]',
    ],
    actions: {
      add: "Store new information in long-term memory",
      query: "Search memory for relevant information",
      list: "List all stored memories",
      replace: "Update existing memory content",
      remove: "Delete memory entries",
      batch: "Perform multiple memory operations atomically",
      pending_list: "List pending memory approvals",
      approve: "Approve a pending memory entry",
    },
  },

  workflow: {
    description: "Orchestrate multi-step workflows - create, manage, run, and resume workflows",
    examples: [
      '[TOOL:workflow({"action": "create", "name": "Data Pipeline", "description": "ETL workflow"})]',
      '[TOOL:workflow({"action": "list"})]',
      '[TOOL:workflow({"action": "run", "id": 1})]',
      '[TOOL:workflow({"action": "resume", "id": 1})]',
    ],
    actions: {
      create: "Create new workflow with name and description",
      list: "List all workflows",
      get: "Get workflow details and execution history",
      update: "Update workflow definition or metadata",
      run: "Execute workflow from start",
      resume: "Resume paused workflow from last step",
      delete: "Delete a workflow",
    },
  },

  history: {
    description: "Search and retrieve conversation history for context and references",
    examples: [
      '[TOOL:history({"action": "search", "query": "database migration"})]',
      '[TOOL:history({"action": "get_messages", "conversationId": 1})]',
      '[TOOL:history({"action": "list_conversations"})]',
    ],
    actions: {
      search: "Find conversations or messages matching a query",
      list_conversations: "List all past conversations",
      get_messages: "Retrieve all messages from a conversation",
      get_conversation: "Get metadata of a specific conversation",
    },
  },

  skill_manage: {
    description: "Manage agent skills - view, create, patch, edit, and remove skill definitions",
    examples: [
      '[TOOL:skill_manage({"action": "view", "name": "my-skill"})]',
      '[TOOL:skill_manage({"action": "create", "name": "new-skill", "content": "skill definition"})]',
      '[TOOL:skill_manage({"action": "patch", "name": "my-skill", "content": "updated content"})]',
    ],
    actions: {
      view: "View skill definition and metadata",
      create: "Create new skill",
      patch: "Update skill content",
      edit: "Edit skill (alias for patch)",
      delete: "Remove skill",
      write_file: "Write skill to file",
      remove_file: "Remove skill file",
    },
  },

  gateway: {
    description: "Send messages to external services (Discord, Slack, Telegram) via configured gateways",
    examples: [
      '[TOOL:gateway({"action": "list_configs"})]',
      '[TOOL:gateway({"action": "send", "message": "Hello world", "target": "channel-name"})]',
    ],
    actions: {
      list_configs: "List available gateway configurations",
      send: "Send message to configured destination",
    },
  },

  filesystem: {
    description: "File operations - read, write, list, delete, move, and manage files and directories",
    examples: [
      '[TOOL:filesystem({"action": "read", "path": "file.txt"})]',
      '[TOOL:filesystem({"action": "write", "path": "file.txt", "content": "Hello"})]',
      '[TOOL:filesystem({"action": "list", "path": "."})]',
      '[TOOL:filesystem({"action": "delete", "path": "old-file.txt"})]',
    ],
    actions: {
      read: "Read file contents",
      write: "Write or overwrite file",
      append: "Append to file",
      list: "List directory contents",
      delete: "Delete file",
      move: "Move or rename file",
      copy: "Copy file",
      mkdir: "Create directory",
      exists: "Check if file/directory exists",
      stat: "Get file metadata",
    },
  },
};

/**
 * Default system context for tool usage
 */
export const TOOL_USAGE_CONTEXT = `
## Tool Integration Guidelines

### When to Use Each Tool:
- **task**: Always create a task before starting work that needs tracking
- **project**: Organize related tasks under projects for better structure
- **shell**: Run scripts, build commands, compile code, manage packages
- **http**: Call APIs, fetch data, send webhooks
- **memory**: Store important facts, user preferences, and context
- **workflow**: Chain multiple steps that need orchestration
- **history**: Reference previous conversations and decisions
- **skill_manage**: Create reusable skills for common operations
- **gateway**: Send notifications to external services
- **filesystem**: Manage files and directories

### Tool Call Best Practices:
1. Start simple - use basic tool calls before complex ones
2. Check tool results for errors and adapt strategy
3. Use memory to track important decisions
4. Create tasks for significant work to maintain history
5. Chain independent operations in parallel when possible
6. Always validate input before tool calls

### Error Recovery:
- If a tool call fails, examine the error message
- Adjust parameters based on error hints (e.g., missing required fields)
- Use alternative tools if available (e.g., shell instead of specific tool)
- Ask for clarification if inputs are ambiguous
`;
