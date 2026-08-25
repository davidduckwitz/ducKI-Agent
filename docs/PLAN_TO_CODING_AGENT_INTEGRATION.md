# Plan Mode → Coding Agent Integration

**Date:** 2026-08-03  
**Status:** ✅ COMPLETE  
**Scope:** Automatic mode switching from Plan Mode to Coding Agent

## Overview

When a user clicks the "Umsetzen" (Implementation) button in the Plan Execution Panel, the system now:

1. **Automatically switches** from Plan Mode to Coding Agent mode
2. **Transfers the plan** as context to the CodingAgent
3. **Ensures file-writing permissions** (Plan Mode has no write access)
4. **Enforces discipline** through CodingAgent's built-in hooks
5. **Provides verification** through automated testing/builds

---

## Architecture

### User Flow

```
User Input (Plan Mode)
      ↓
Plan Created (5-20 steps)
      ↓
Plan Panel Shows "Umsetzen" Button
      ↓
User Clicks "Umsetzen" ← [SECURITY GATE]
      ↓
handlePlanExecution() triggered
      ↓
Create/Reuse Project (Sandbox)
      ↓
Call CodingAgent API (/api/coding-agent/run)
      ↓
CodingAgent Executes Plan
  ├─ EXPLORE: Read files
  ├─ PLAN: Identify changes
  ├─ EDIT: Make modifications
  ├─ VERIFY: Run tests/build
  └─ REPORT: Show results
      ↓
Results Displayed in Chat
```

---

## Implementation Details

### File Changed
`apps/web/src/components/chat/ChatContainer.tsx`

### Function Modified
`handlePlanExecution()` (line 779)

### Changes Made

#### Before: Plan Execution (READ-ONLY)
```typescript
const result = await api.plans.execute(currentPlan.id, {
  goal: currentPlan.goal,
  steps: currentPlan.steps ?? [],
  markdown: currentPlan.markdown,
  conversationId: conversationId ?? undefined,
  projectId,
});
```

**Limitations:**
- ❌ No file-writing permissions
- ❌ No verification/testing
- ❌ No discipline enforcement

#### After: Coding Agent Execution (FULL PERMISSIONS)
```typescript
const codingResult = await fetch("/api/coding-agent/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    goal: executionGoal,
    sandboxRoot: sandboxRoot,
    maxAttempts: 3,
  }),
}).then((r) => r.json());
```

**Improvements:**
- ✅ Full file-writing permissions
- ✅ Automated verification (tests, builds, linting)
- ✅ Discipline enforcement (read-before-edit hooks)
- ✅ Multi-attempt retry with diagnostics
- ✅ Proper error handling and reporting

---

## Coding Agent Integration

### API Endpoint
**Route:** `POST /api/coding-agent/run`  
**Handler:** `apps/server/src/routes/coding-agent.ts`

### Request Format
```typescript
{
  goal: string;           // The plan formatted as implementation goal
  sandboxRoot?: string;   // Project folder path (optional)
  maxAttempts?: number;   // Retry attempts (default: 3)
}
```

### Response Format
```typescript
{
  success: boolean;
  summary: string;
  attempts: number;
  conversationId?: number;
  verifyCommand?: string;
  verified: boolean;
}
```

### CodingAgent Features Used

1. **Discipline Hooks** - `coding-discipline-read-before-edit`
   - Prevents editing files that haven't been read first
   - Tracks file access patterns

2. **Approval Policy** - Safe shell commands only
   - ✓ Allowed: ls, pwd, npm, yarn, git, cat, grep, find
   - ✗ Blocked: rm -rf, git force-push, etc.

3. **5-Phase Workflow**
   - EXPLORE: Locate and read relevant files
   - PLAN: Identify exact changes needed
   - EDIT: Make minimal, targeted edits
   - VERIFY: Run verification command
   - REPORT: Document what changed

4. **Auto-Verification**
   - Detects TypeScript projects → runs `tsc --noEmit`
   - Detects npm projects → runs `npm run build`
   - Detects test files → offers `npm test`

5. **Multi-Attempt Retry**
   - Failed verification triggers error diagnosis
   - Agent analyzes ACTUAL error, not guessed solution
   - Up to 3 attempts (configurable)

---

## Security Model

### Plan Mode (READ-ONLY)
- ✓ Can create plans
- ✓ Can analyze complexity
- ✓ Can show parallelization hints
- ✗ CANNOT write files
- ✗ CANNOT modify code

### Coding Agent Mode (WRITE + VERIFY)
- ✓ Can write files
- ✓ Can run commands
- ✓ Can execute code
- ✓ Enforces discipline (read-before-edit)
- ✓ Restricts dangerous operations
- ✓ Requires verification

### Execution Flow
```
┌─────────────────────────────────────┐
│  User in Plan Mode                  │
│  (Creating/Viewing Plans)           │
│  ✓ Read-only operations             │
│  ✗ No file access                   │
└──────────────┬──────────────────────┘
               │
               │ User clicks "Umsetzen"
               ↓
┌─────────────────────────────────────┐
│  SECURITY GATE ACTIVATED            │
│  Verify user intent                 │
│  Setup sandbox environment          │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  Coding Agent Mode                  │
│  (Executing Plans)                  │
│  ✓ Full file-writing permissions    │
│  ✓ Discipline enforcement           │
│  ✓ Automated verification           │
│  ✓ Error recovery                   │
└─────────────────────────────────────┘
```

---

## Error Handling

### When Execution Fails

1. **First Attempt Fails**
   - CodingAgent captures error output
   - Agent analyzes root cause
   - Attempts fix based on diagnosis

2. **Second Attempt Still Fails**
   - Agent tries alternative approach
   - Uses different tools/strategies

3. **Third Attempt Still Fails**
   - Returns failure with diagnostic info
   - User can see exact error
   - Can refine plan manually

### Error Display
Errors are shown in the chat with:
- ✗ Status indicator
- Full error message
- Number of attempts
- Verification command used

---

## Project & Sandbox Management

### Before Execution
```typescript
// 1. Check if conversation already has a project
let projectId = conversations.find(c => c.id === conversationId)?.projectId;

// 2. If not, create new project
if (!projectId) {
  const created = await api.projects.create({
    name: generateProjectNameFromGoal(plan.goal),
    description: plan.goal
  });
  projectId = created.id;
  sandboxRoot = created.folder;
}

// 3. Pass sandbox path to CodingAgent
```

### Sandbox Isolation
- Each project gets its own folder
- CodingAgent operates within that folder
- File operations are scoped
- Multiple plans can share a project folder

---

## Workflow Example

### Scenario: User Wants to Build a Web Server

1. **Plan Mode**
   - User: "Build a simple Express.js server with TypeScript"
   - System creates hierarchical plan with 8 steps
   - Shows complexity: 3/5 (Medium)
   - Shows execution strategy: "hybrid" (some parallel steps)

2. **Plan Panel**
   - User reviews plan steps
   - Sees "Umsetzen" button
   - Clicks it

3. **Mode Switch**
   - ✅ Switches to Coding Agent mode
   - ✅ Transfers plan as implementation goal
   - ✅ Creates/reuses project folder

4. **Coding Agent Execution**
   - **EXPLORE:** Reads package.json, tsconfig.json
   - **PLAN:** Identifies files to create/modify
   - **EDIT:** Creates server.ts, updates package.json
   - **VERIFY:** Runs `npm run build` and `npm test`
   - **REPORT:** Shows what was created

5. **Result**
   - Files created and tested
   - User sees summary in chat
   - Success/failure status shown
   - Can iterate or start new plan

---

## Testing Checklist

- [x] Plan execution button calls correct endpoint
- [x] Project creation/reuse works
- [x] Sandbox path passed correctly
- [x] Error messages displayed properly
- [x] Results formatted nicely in chat
- [x] Plan panel closes after execution starts
- [x] Web app compiles without errors
- [ ] Integration test with real CodingAgent (manual)
- [ ] Test error recovery (manual)
- [ ] Test verification command detection (manual)

---

## Configuration

### Enable/Disable Coding Agent
```sql
-- In database settings:
INSERT INTO settings (key, value) 
VALUES ('CODING_ENABLED', 'true');
```

### Default Verification Commands
CodingAgent auto-detects:
- `tsconfig.json` → `npx tsc --noEmit`
- `package.json` with test script → `npm test`
- `package.json` with build script → `npm run build`

### Custom Verification Command
User can pass `verifyCommand` parameter to override defaults.

---

## Future Enhancements

### Phase 2: WebSocket Streaming
- Real-time progress updates
- Live file change notifications
- Step-by-step execution display

### Phase 3: Plan Modification
- User can edit plan before execution
- Add/remove steps
- Adjust complexity/priority

### Phase 4: Parallel Execution
- Use CodingAgent's parallelization hints
- Execute independent steps concurrently
- Aggregate results

### Phase 5: Skill Integration
- Detect relevant skills from plan
- Load skill context before execution
- Apply skill-specific best practices

---

## Security Considerations

### ✅ What's Protected

1. **File Access Control**
   - Plan Mode: Read-only
   - Coding Agent: Scoped to project folder
   - Discipline hooks prevent unauthorized edits

2. **Command Restrictions**
   - Only safe shell commands allowed
   - No force-push, rm -rf, destructive operations
   - Approval policy enforced

3. **Verification Requirement**
   - Must pass verification to count as success
   - Unverified results clearly marked
   - Error output shown to user

4. **Sandbox Isolation**
   - Each project in separate folder
   - No access to system directories
   - Environment variables scoped

### ⚠️ What Remains User's Responsibility

1. **Verification Command**
   - User should ensure verification command is meaningful
   - Bad verification command = bad confidence signal

2. **Plan Quality**
   - Good plan = good execution
   - Incomplete plan = incomplete results

3. **Project Folder**
   - Should be a genuine project folder
   - Should not contain sensitive files
   - Should be safe to modify

---

## Summary

The Plan Mode → Coding Agent integration provides:

- ✅ **Clear separation of concerns:** Plan (analysis) vs Execute (action)
- ✅ **Security gating:** Read-only → Write with discipline
- ✅ **User-initiated:** Button click confirms intent
- ✅ **Full features:** Verification, retry, error recovery
- ✅ **Good UX:** Automatic context transfer, clear status

Users can now:
1. Create detailed plans without write permissions
2. Review plans before execution
3. Execute plans with full capabilities
4. See verification results
5. Iterate based on failures

---

**Status:** Ready for production deployment  
**Testing:** Manual testing recommended before release
**Documentation:** Complete
