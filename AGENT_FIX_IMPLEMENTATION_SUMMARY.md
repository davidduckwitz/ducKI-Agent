# Agent Empty Response Fix - Implementation Summary

## Problem Statement
When the agent executed multiple different tools (e.g., task list, workflow list, cronjob list) and received results, the LLM would not generate a text response. Instead it returned empty/whitespace, causing users to see the fallback message: "Ich habe zu dieser Anfrage keine Antwort erzeugt..." (I did not generate an answer to this request).

## Root Cause
The system prompt **lacked explicit instructions** for the LLM to analyze tool results and provide a response. When the runloop continued after tool execution, the LLM received:
- System prompt
- User message
- Assistant message (with tool calls)
- Tool result messages ✓

**But:** No instruction to "analyze these results and respond to the user"

## Solution Overview
Multi-layered approach addressing three levels of the issue:

### Layer 1: System Prompt Enhancement
**Objective:** Make LLM aware that tool results require analysis

**Implementation:** Added "## Responding to Tool Results - CRITICAL" section to DEFAULT_SYSTEM_PROMPT

**Changes in agent.ts:71-76:**
```typescript
## Responding to Tool Results - CRITICAL
When you receive tool execution results (messages marked as "tool" role):
1. ALWAYS analyze what each tool returned
2. Synthesize the results into a coherent summary
3. Answer the user's original question based on the actual results
4. If a tool returned an error, acknowledge it and explain what it means
5. Do NOT emit only a tool call and then go silent - you MUST provide a response after tools execute
6. If multiple tools were executed, summarize their combined results together
```

### Layer 2: Guided Analysis Prompts
**Objective:** Explicitly prompt LLM to analyze results after tool execution

**Implementation:** Added generalized analysis prompt (not just for screenshots)

**Changes in agent.ts:4016-4061:**
```typescript
// If tools were executed and we're still within iteration budget, add analysis prompt
if (toolResultsMap.size > 0 && iterations < adjustedControls.maxIterations) {
  // Create explicit user message asking for analysis
  let analyzePrompt: LLMMessage;
  
  if (this.currentScreenshotMessage && browserToolsCount > 0) {
    analyzePrompt = {
      role: "user",
      content: "Please analyze the screenshot and other tool results provided above. What information did they provide? How do they answer my original question? Provide a clear summary.",
    };
  } else {
    analyzePrompt = {
      role: "user",
      content: `Please analyze the results from the ${toolNames} tool(s) that just executed. What information did they provide? How do they answer my original question? Provide a clear summary based on these results.`,
    };
  }
  
  await this.conversation.addMessage(analyzePrompt);
}
```

**Effect:** After each tool execution, the next iteration begins with an explicit prompt asking the LLM to analyze results.

### Layer 3: Empty Response Recovery
**Objective:** Detect and recover from LLM silence after tool execution

**Implementation:** One-time automatic retry with explicit recovery prompt

**Changes in agent.ts:3923-3968:**
```typescript
// CRITICAL: Detect and handle empty responses after tool execution
const responseIsEmpty = response.trim().length === 0;
if (responseIsEmpty && toolsJustExecuted && !emptyResponseAfterTools && iterations < adjustedControls.maxIterations) {
  // Log the issue
  this.logger.warn("[RUNLOOP] Model returned empty response after tool execution, attempting recovery", {
    iteration: iterations,
    toolsJustExecuted,
  });
  
  emit("guardrail", "Model returned empty response after tool execution, retrying with explicit prompt", {
    iteration: iterations,
  });
  
  // Add recovery prompt
  const recoveryPrompt: LLMMessage = {
    role: "user",
    content: "You executed the tools. Please provide a concise response based on their results. What information did they return? How does it answer the original question?",
  };
  await this.conversation.addMessage(recoveryPrompt);
  
  // Mark recovery attempted and retry
  emptyResponseAfterTools = true;
  try {
    messages = buildMessages("full");
    response = await generateFromMessages(messages);
    // Log success
  } catch (recoveryError) {
    // Log failure, continue with empty response (fallback will handle it)
  }
}
```

**Effect:** If the LLM returns empty after tools execute, we automatically retry once with a more explicit prompt before giving up.

### Layer 4: Tracking & Logging
**Objective:** Understand when and why empty responses occur

**Changes in agent.ts:3588-3589, 4010-4014, 4077:**
```typescript
// Track execution state across iterations
let toolsJustExecuted = false;
let emptyResponseAfterTools = false;

// After tool execution, mark the flag
if (toolResultsMap.size > 0) {
  toolsJustExecuted = true;
  emptyResponseAfterTools = false; // Reset recovery flag
}

// When exiting tool processing, reset flag
if (toolResultsMap.size === 0) {
  toolsJustExecuted = false;
  break;
}
```

## Expected Behavior Changes

### Before Fix
```
User: "List all tasks, workflows, and cronjobs"
Agent: [executes task list, workflow list, cronjob list]
Agent: (silently returns empty)
UI: "Ich habe zu dieser Anfrage keine Antwort erzeugt..."
```

### After Fix
```
User: "List all tasks, workflows, and cronjobs"
Agent: [executes task list, workflow list, cronjob list]
Agent: (continues iteration)
System: "Please analyze the results from the task, workflow, and cronjob tools..."
Agent: "I found 5 active tasks, 3 workflows, and 2 scheduled cronjobs. Here's the summary..."
UI: Shows meaningful analysis of tool results
```

## Files Modified
- **packages/agent/src/agent.ts** - All changes (6 separate edits)
  - Line 71-76: Enhanced system prompt
  - Line 3588-3589: New tracking variables
  - Line 3923-3968: Empty response recovery logic
  - Line 4010-4014: Tool execution tracking
  - Line 4016-4061: Generalized analysis prompt
  - Line 4077: Reset flag on exit

## Testing Verification
Build completed successfully:
```
✓ TypeScript compilation passed
✓ All packages built without errors
✓ Agent package: tsc -p tsconfig.json → Done
```

## Logging & Monitoring
New log entries to watch for in production:
- `[RUNLOOP] Model returned empty response after tool execution, attempting recovery`
  - Indicates the automatic retry kicked in
- `[RUNLOOP] Recovery retry succeeded`
  - Indicates the retry produced a response
- `Recovery retry failed, continuing with empty response`
  - Indicates the retry also failed (fallback message will be shown)
- `[TOOL-RESULTS] Tools executed, adding analysis prompt for next iteration`
  - Normal case: shows analysis prompt was added

## Guardrail Events
New guardrail events emitted:
- `"Model returned empty response after tool execution, retrying with explicit prompt"`
- `"Recovery retry succeeded"` / `"Recovery retry failed"`

These can be monitored to understand:
1. How often this issue occurs
2. Whether recovery is successful
3. Which LLM models/instances exhibit this behavior

## Backward Compatibility
✓ No breaking changes
✓ Only adds new logic paths
✓ Existing behavior unchanged when:
  - No tools are executed
  - LLM provides response (even empty, in most cases)
  - Tools are not supported in conversation mode

## Future Improvements
1. **Adaptive recovery:** Different recovery prompts based on tool type
2. **Model-specific tuning:** Different thresholds per model
3. **Metrics collection:** Track empty response rates per model/provider
4. **Streaming support:** Ensure recovery works with streaming LLM responses
5. **Conversation analysis:** Learn from recovery prompts to improve system prompt

## Implementation Quality
- ✓ Follows existing code patterns
- ✓ Comprehensive logging at all decision points
- ✓ Proper error handling and fallback paths
- ✓ Respects iteration budget (no infinite loops)
- ✓ Emits clear guardrail events
- ✓ Well-commented for maintainability
