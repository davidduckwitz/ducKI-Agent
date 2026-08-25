# Agent Empty Response Issue - Root Cause Analysis

## Problem
When the agent executes multiple different tools (e.g., task list, workflow list, cronjob list) and receives results, the LLM doesn't generate a text response. Instead it returns empty/whitespace, causing the fallback message "Ich habe zu dieser Anfrage keine Antwort erzeugt..." to be shown.

## Root Cause
The system prompt **lacks explicit instructions** for the LLM to analyze tool results and provide a response. When the runloop continues after tool execution:

1. **Iteration N:** LLM generates response with tool call markers (e.g., `[TOOL:task_list(...)]`)
2. **Tool execution:** Tools execute, results added to conversation as `role: "tool"` messages
3. **Iteration N+1:** Loop continues (line 4005: `continue;`)
4. **LLM receives:** 
   - System prompt
   - User message (original request)
   - Assistant message (tool calls)
   - Tool result messages ✓
5. **Problem:** No explicit instruction to "analyze these results and respond to the user"
6. **Result:** LLM outputs empty/whitespace
7. **Fallback:** `buildNonEmptyResponse()` catches this and shows fallback message

## Evidence
- Tool results ARE properly added to conversation (agent.ts:2948)
- Tool results ARE included in LLM context (agent.ts:3650-3652: "Tool results are CRITICAL")
- Message building includes tool results with proper ordering (agent.ts:3706: `.reverse()`)
- LLM receives complete conversation with results
- **Gap:** System prompt has no instruction for "after tools execute, analyze results"

## System Prompt Gap
The DEFAULT_SYSTEM_PROMPT (lines 65-118) covers:
- ✓ How to emit tool calls
- ✓ Browser tool workflow
- ✓ Vision/image support
- ✗ **What to do when you receive tool results**
- ✗ **Expectation to analyze results and respond**

## Solution Strategy
Multi-layered approach:

### 1. Enhance System Prompt
Add explicit instruction about handling tool results:
```
When you receive tool results (role: "tool" messages):
1. Analyze what each tool returned
2. Synthesize results into a coherent response
3. Answer the user's original question based on the results
4. If results show an error, explain it clearly
```

### 2. Add Analysis Prompt (Already Partially Implemented)
When tools complete and iteration budget remains, add a user message asking for analysis:
```
"Please analyze the tool results above. What information did they provide? 
How does it answer my original question?"
```
This is already done for screenshots (lines 3959-3966) - extend it to all tool results.

### 3. Retry Logic for Empty Responses
If LLM returns empty after tool execution:
- Log as "Model went silent after tool execution"
- Generate a synthetic prompt: "Please summarize the results from the [tools executed]"
- Retry once (within iteration budget)

### 4. Conversation Context Improvement
Ensure tool results are formatted in a way that makes the LLM feel obligated to respond:
- Add result count to logging/context
- Ensure results are complete (not truncated)
- Add summary metadata to tool messages

## Implementation Details

### 1. Enhanced System Prompt (Lines 65-76)
Added explicit section:
```
## Responding to Tool Results - CRITICAL
When you receive tool execution results (messages marked as "tool" role):
1. ALWAYS analyze what each tool returned
2. Synthesize the results into a coherent summary
3. Answer the user's original question based on the actual results
4. If a tool returned an error, acknowledge it and explain what it means
5. Do NOT emit only a tool call and then go silent - you MUST provide a response after tools execute
6. If multiple tools were executed, summarize their combined results together
```

### 2. Generalized Analysis Prompt (Lines 4016-4061)
Replaces screenshot-only logic:
- When `toolResultsMap.size > 0` (tools were executed)
- And `iterations < maxIterations` (budget remaining)
- Adds explicit user message asking for analysis
- Detects screenshot messages and customizes prompt
- Creates natural follow-up: "Please analyze the results from X tool(s) that just executed"

### 3. Empty Response Recovery (Lines 3923-3968)
New recovery mechanism:
- Tracks `toolsJustExecuted` flag (set after tool execution)
- Tracks `emptyResponseAfterTools` flag (for one-time recovery)
- Detects empty response: `response.trim().length === 0`
- Conditions: `toolsJustExecuted && !emptyResponseAfterTools && iterations < maxIterations`
- Adds recovery prompt: "You executed the tools. Please provide a concise response based on their results."
- Retries LLM call once
- Logs outcome and emits guardrail events

### 4. Tool Execution Tracking (Lines 4010-4014)
- Sets `toolsJustExecuted = true` when `toolResultsMap.size > 0`
- Resets `emptyResponseAfterTools = false` for each batch
- Resets `toolsJustExecuted = false` when exiting (line 4077)

## Files Modified
1. **agent.ts:65-76** - DEFAULT_SYSTEM_PROMPT (enhanced)
2. **agent.ts:3588-3589** - New tracking variables
3. **agent.ts:3923-3968** - Empty response recovery logic
4. **agent.ts:4010-4014** - Tool execution tracking
5. **agent.ts:4016-4061** - Generalized analysis prompt
6. **agent.ts:4077** - Reset flag on exit

## Expected Outcome
After fixes:
1. **System knows expectations:** LLM explicitly told to analyze tool results
2. **Guided analysis:** Analysis prompt explicitly asks model to synthesize results
3. **Recovery mechanism:** If model goes silent, one retry with explicit recovery prompt
4. **Proper tracking:** Clear logs showing when recovery happens
5. **Better UX:** 
   - No more silent empty responses after tool execution
   - User always sees meaningful output or clear error
   - Fallback message only for genuinely non-productive runs

## Testing Scenarios
1. **Multi-tool execution:** task list + workflow list + cronjob list
2. **Empty response trigger:** Model returns whitespace after tools
3. **Recovery success:** Model responds after recovery prompt
4. **Recovery failure:** Message logged, fallback shown
5. **No tools scenario:** Flag reset, normal exit path
