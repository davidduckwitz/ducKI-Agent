---
name: "Auto Plan"
description: "Automatically create detailed plans when tasks or workflows are created"
primary_skills: ["plan", "tool-orchestration"]
related_skills: ["task-splitter"]
fallback_skills: []
---

# Auto Plan Skill

Automatically invoked when creating tasks or workflows to ensure structured planning and task decomposition.

## Activation Triggers

This skill **automatically activates** when:
1. Creating a task with description > 50 characters
2. Creating a workflow with multiple steps
3. Updating a task with significant scope changes
4. Starting execution of a complex task

## Automatic Planning Process

### Step 1: Analyze Task/Workflow
When triggered, automatically:
- Extract goals and objectives
- Identify complexity level (1-10 scale)
- Determine if decomposition is needed
- Assess dependencies

### Step 2: Generate Plan
- **If simple task**: Execute directly
- **If medium task**: Create 2-3 focused subtasks
- **If complex task**: Split into 5+ subtasks with dependencies

### Step 3: Present Options
Show user with:
- Suggested breakdown
- Estimated completion time
- Parallel vs sequential execution strategy
- Option to refine or proceed

### Step 4: Execute (Optional)
- User can immediately start auto-execution
- Tasks are assigned and tracked
- Progress updates in real-time

## Plan Format

Plans automatically include:

```
PLAN: [Task Title]
├── Phase 1: Analysis & Design
│   ├── Subtask 1.1: Gather requirements
│   ├── Subtask 1.2: Design approach
│   └── Subtask 1.3: Create timeline
├── Phase 2: Implementation
│   ├── Subtask 2.1: Build component A
│   ├── Subtask 2.2: Build component B
│   └── Subtask 2.3: Integration
├── Phase 3: Testing
│   ├── Subtask 3.1: Unit tests
│   ├── Subtask 3.2: Integration tests
│   └── Subtask 3.3: UAT
└── Phase 4: Completion
    ├── Subtask 4.1: Documentation
    ├── Subtask 4.2: Deployment
    └── Subtask 4.3: Handover

Estimated Total Time: 12 hours
Execution Strategy: Sequential phases, parallel tasks within phases
```

## Integration with Agent Workflow

### Auto-Invocation Points

**When creating task:**
```
[TOOL:task({"action": "create", "title": "Build user authentication", ...})]
↓
Auto Plan activates
↓
[TOOL:task_split({"action": "split", "taskId": 123, "autoExecute": true})]
```

**When updating task scope:**
```
[TOOL:task({"action": "update", "id": 5, "description": "Now includes OAuth + SAML"})]
↓
Auto Plan detects scope increase
↓
Suggests re-planning with new subtasks
```

**When starting workflow:**
```
[TOOL:workflow({"action": "run", "id": 1})]
↓
Auto Plan ensures execution plan exists
↓
Starts execution with tracking
```

## Configuration

### Automatic Splitting Thresholds

| Complexity | Action | Threshold |
|-----------|--------|-----------|
| Simple | Execute directly | Description < 50 chars |
| Medium | Split 2-3 subtasks | Complexity 3-5, time 1-4 hours |
| Complex | Split 5+ subtasks | Complexity 6-10, time 4+ hours |
| Very Complex | Create workflow | Multiple goals + many dependencies |

### Execution Strategies

**Sequential** (default for complex tasks):
- Subtasks executed one after another
- Each depends on previous completion
- Safe but longer execution time
- Used for: backend work, deployments, migrations

**Parallel** (for independent tasks):
- Multiple subtasks run simultaneously
- No dependencies between tasks
- Faster execution time
- Used for: frontend components, testing, documentation

**Mixed** (for complex workflows):
- Phases execute sequentially
- Tasks within phases run in parallel
- Balanced speed and safety
- Used for: full feature development, major releases

## Smart Decisions

The skill makes intelligent decisions:

### Complexity Assessment
```
Task: "Implement user authentication"
Keywords: authentication, security, database, frontend, API
Complexity Score: 7/10
Decision: Mixed strategy (plan phases, parallel within)
```

### Time Estimation
```
- Each goal: +5-10 min planning
- Frontend task: +30-60 min
- Backend task: +45-90 min
- Testing task: +15-30 min
- Security task: +double time
- Database task: +migration buffer
```

### Dependency Analysis
```
Input: "Build API, then build frontend, then test"
Detected: Sequential dependency
Creates: API → Frontend → Testing chain
```

## Auto-Execution Features

### Real-time Progress Tracking
- Shows percentage complete
- Lists completed subtasks
- Highlights current work
- Warns about failures

### Automatic Retries
- Failed subtask: auto-retry (max 3 attempts)
- After retry failure: flag for review
- Detailed error logs for debugging

### Pause/Resume Capability
- Pause mid-execution for review
- Resume from where paused
- No loss of progress

### Progress Reporting
Every subtask completion:
- Update task status
- Store result in database
- Notify via configured channels
- Update project metrics

## Example: Full Workflow

### Input
```
User: "Create a payment processing system that handles credit cards, PayPal, 
       and Apple Pay with PCI compliance and fraud detection"
```

### Auto Plan Activation
```
Complexity: 9/10 (detected: payment, security, integrations, compliance)
Strategy: Mixed (sequential phases, parallel integrations)
Estimated Time: 8-10 hours
```

### Generated Plan
```
PLAN: Payment Processing System

Phase 1: Setup & Security (1-2 hrs)
├─ Set up PCI compliance framework
├─ Configure encryption & tokenization
└─ Create secure API endpoints

Phase 2: Payment Methods (4-5 hrs) [PARALLEL]
├─ Implement Credit Card processing
├─ Implement PayPal integration
└─ Implement Apple Pay integration

Phase 3: Fraud Detection (1-2 hrs)
├─ Configure fraud detection rules
├─ Integrate with external service
└─ Test detection accuracy

Phase 4: Testing & Deployment (1-2 hrs)
├─ Unit & integration testing
├─ Security audit
└─ Production deployment

AutoExecute: Yes
```

### Automatic Execution
```
Running Phase 1: Setup & Security
├─ ✓ Set up PCI compliance framework (12:05 PM)
├─ ► Configure encryption & tokenization (12:15 PM, in progress)
└─ ○ Create secure API endpoints (pending)

Completed: 1/3 in Phase 1
Estimated remaining: 6-8 hours
```

## Commands

### Automatic (no command needed)
- Plans are created automatically
- Execution starts if auto-enabled
- Progress tracked automatically

### Manual Overrides (if needed)
```
# View plan for existing task
[TOOL:task_split({"action": "status", "taskId": 123})]

# Manually split a task
[TOOL:task_split({"action": "split", "taskId": 123})]

# Start execution
[TOOL:task_split({"action": "execute", "taskId": 123})]

# Pause execution
[TOOL:task_split({"action": "pause", "taskId": 123})]

# Resume execution
[TOOL:task_split({"action": "resume", "taskId": 123})]

# Cancel execution
[TOOL:task_split({"action": "cancel", "taskId": 123})]
```

## Best Practices

### For Best Results:
1. **Clear titles**: "Build payment system" not "work"
2. **Detailed descriptions**: Include goals, requirements, constraints
3. **Use keywords**: Mention tech stack, integrations, quality requirements
4. **Set expectations**: Include timeline or complexity hints

### Example Good Task:
```
Title: Implement OAuth2 authentication
Description:
- Support GitHub and Google OAuth providers
- Implement secure token storage
- Add session management
- Create login/logout flows
- Target: 4 hours completion
- Must: HTTPS only, secure cookies
- Should: Rate limiting on login attempts
```

### Example Bad Task:
```
Title: Do auth stuff
Description: implement authentication
(Too vague - plan would be ineffective)
```

## Skill Coordination

Auto Plan works with:
- **tool-orchestration** - Executes the generated plans
- **json-tool-format** - Formats tool calls for execution
- **plan skill** - Detailed manual planning when needed
- **task-splitter** - Intelligent decomposition
- **auto-executor** - Runs subtasks automatically

## Advanced Configuration

### Disable Auto-Execution
Set during task creation:
```
[TOOL:task({
  "action": "create",
  "title": "Task Title",
  "description": "...",
  "skipAutoExecute": true  // Skip planning/execution
})]
```

### Force Re-Planning
```
[TOOL:task_split({
  "action": "split",
  "taskId": 123,
  "force": true  // Ignore cached plan
})]
```

### Custom Strategy
```
[TOOL:task_split({
  "action": "split",
  "taskId": 123,
  "strategy": "sequential"  // Force strategy
})]
```

---

**Remember**: Auto Plan is designed to be transparent and helpful. Plans are shown before execution, and you can always refine them or execute manually if needed.
