---
name: "Tool Orchestration"
description: "Master guide for coordinating tool calls in proper sequence and parallel execution"
primary_skills: []
related_skills: ["workflow-orchestrator"]
fallback_skills: []
---

# Tool Orchestration Skill

This skill provides systematic guidance for using tools effectively in the agent's workflow.

## Tool Call Format Rules (MANDATORY)

Always use this exact format:
```
[TOOL:toolName({"key": "value", "number": 123})]
```

### JSON Rules:
1. **Keys**: ALL must have double quotes `"key"` NOT `key` or `'key'`
2. **String values**: Must have quotes `"hello"` NOT `hello`
3. **Numbers**: NO quotes `123` NOT `"123"`
4. **Booleans**: No quotes `true` or `false`
5. **Nulls**: No quotes `null`

### Common Mistakes to Avoid:
❌ `[TOOL:task({json: {...}})]` - WRONG: 'json' is not a key
❌ `[TOOL:task({action: 'create'})]` - WRONG: unquoted key, single-quoted value
❌ `[TOOL:task({"id": "123"})]` - WRONG: numeric id should not be quoted
✅ `[TOOL:task({"action": "create", "id": 123})]` - CORRECT

## Sequential vs Parallel Execution

### Parallel Execution (Independent Calls)
Use multiple `[TOOL:...]` markers in one response when calls don't depend on each other:
```
[TOOL:project({"action": "list"})]
[TOOL:task({"action": "list"})]
[TOOL:memory({"action": "query", "query": "recent decisions"})]
```

### Sequential Execution (Dependent Calls)
Emit one at a time, wait for result before next:
```
[TOOL:project({"action": "create", "name": "MyProject"})]
# Wait for result with project ID
[TOOL:task({"action": "create", "projectId": <returned-id>, "title": "Task1"})]
```

## Standard Tool Usage Patterns

### Pattern 1: Create Project and Tasks
```
# Step 1: Create or get project
[TOOL:project({"action": "create", "name": "New Initiative"})]

# Wait for project ID from result

# Step 2: Create related tasks (now you have projectId)
[TOOL:task({"action": "create", "projectId": <id>, "title": "Task 1"})]
[TOOL:task({"action": "create", "projectId": <id>, "title": "Task 2"})]
```

### Pattern 2: Workflow Orchestration
```
# Step 1: Create workflow
[TOOL:workflow({"action": "create", "name": "Pipeline", "description": "ETL"})]

# Step 2: Run workflow
[TOOL:workflow({"action": "run", "id": <workflow-id>})]

# Step 3: Monitor progress
[TOOL:workflow({"action": "get", "id": <workflow-id>})]
```

### Pattern 3: Memory-Driven Decisions
```
# Step 1: Query relevant memory
[TOOL:memory({"action": "query", "query": "user preferences"})]

# Step 2: Use query results in subsequent tool calls
[TOOL:project({"action": "create", "name": "Project", "description": "Based on user preference X"})]
```

### Pattern 4: Error Recovery
```
# Step 1: Attempt operation
[TOOL:task({"action": "create", "title": "Task"})]

# If fails, check error and retry with fixed parameters
# Step 2: Retry with corrected input
[TOOL:task({"action": "create", "title": "Task", "projectId": 1})]
```

## Tool Dependency Map

```
task
  └── requires: projectId (optional)
  └── affects: history, memory (log creation)

project
  └── no dependencies
  └── affects: tasks, workflow

workflow
  ├── can use: shell, http, filesystem
  └── orchestrates: multi-step operations

memory
  ├── queries: historical decisions
  └── stores: patterns and preferences

shell
  ├── accesses: filesystem
  └── runs: external commands

http
  ├── no dependencies
  └── fetches: external data

filesystem
  ├── reads/writes: local files
  └── affects: shell commands
```

## Decision Tree for Tool Selection

```
Do you need to track work?
├─ Yes → Create Task/Project
└─ No → Use direct tool (shell, http, filesystem)

Is it a multi-step workflow?
├─ Yes → Use Workflow tool
└─ No → Use individual tools

Do you need to recall past decisions?
├─ Yes → Query Memory first
└─ No → Proceed with tool calls

Are calls independent?
├─ Yes → Use parallel [TOOL:] markers
└─ No → Emit sequentially and wait for results
```

## Tool Error Responses

When a tool fails, the error message contains:
- **Problem**: What went wrong
- **Cause**: Why it failed (e.g., missing field, invalid value)
- **Hint**: How to fix it (when available)

### Common Fixes:
- `action is required` → Add "action" field with valid action name
- `id is required` → Get id from previous tool result
- `projectId is required` → Create project first, use returned id
- `Unknown tool` → Check tool name spelling
- `permission denied` → Might need different approach

## Best Practices

1. **Start Simple**: Begin with basic tool calls before complex workflows
2. **Validate Early**: Check if resources exist before operations
3. **Batch Parallel**: Group independent calls for efficiency
4. **Log Results**: Store important results in memory for later reference
5. **Handle Errors**: Always check tool results and adjust strategy
6. **Document Flow**: Add memory entries for significant decisions
7. **Reuse Patterns**: Follow established patterns from successful runs

## Example: Complete Workflow

```
# 1. Store initial decision in memory
[TOOL:memory({"action": "add", "content": "Starting user onboarding flow"})]

# 2. Create project for this user
[TOOL:project({"action": "create", "name": "User Onboarding"})]

# 3-4. In parallel: fetch config and list existing tasks
[TOOL:http({"action": "get", "url": "https://config.api/settings"})]
[TOOL:task({"action": "list"})]

# 5. Create onboarding tasks (requires project ID from step 2)
[TOOL:task({"action": "create", "projectId": <id>, "title": "Step 1: Verify Email"})]
[TOOL:task({"action": "create", "projectId": <id>, "title": "Step 2: Setup Profile"})]
[TOOL:task({"action": "create", "projectId": <id>, "title": "Step 3: First Login"})]

# 6. Store completion in memory
[TOOL:memory({"action": "add", "content": "Onboarding workflow initialized with 3 tasks"})]
```

Remember: **Clear, well-formatted tool calls prevent errors and keep workflows running smoothly.**
