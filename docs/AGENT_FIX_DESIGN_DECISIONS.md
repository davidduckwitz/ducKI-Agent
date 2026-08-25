# Agent Empty Response Fix - Design Decisions

## Why This Approach?

### Decision 1: System Prompt Over Hardcoded Logic
**Alternative Considered:** Hardcode response generation when tools execute
**Chosen:** Enhance system prompt with explicit instructions

**Rationale:**
- LLMs are instruction-following systems; explicit instructions are the primary lever
- Hardcoding response generation breaks model autonomy and creativity
- System prompt changes benefit all future iterations without code rewrites
- Aligns with "guide the model, don't override it" principle
- Scales better across different model sizes/capabilities

---

### Decision 2: User Messages vs System Messages for Analysis Prompts
**Alternative Considered:** Add system message asking for analysis
**Chosen:** Add user message asking for analysis

**Rationale:**
- User messages are more direct and authoritative in LLM context
- Tool results are presented in response to tool execution, which is a user-driven action
- User message clearly separates "here are results" (tool message) from "now respond" (user message)
- More natural conversation flow: User → Tool Execution → User (analysis request) → Assistant (response)
- System messages are for instructions, user messages are for direction

---

### Decision 3: One-Time Recovery vs Unlimited Retries
**Alternative Considered:** 
- No retry (just fallback)
- Multiple retries (up to N times)

**Chosen:** One-time automatic retry with recovery prompt

**Rationale:**
- No retry: Too pessimistic; some models just need a nudge
- Multiple retries: Risk of infinite loop, token waste, timeout issues
- One-time recovery: Balanced approach that helps without excessive retries
- Most LLMs that go silent after tools need just one explicit recovery prompt
- If model still returns empty after recovery prompt, it's genuinely not capable/configured properly
- Respects iteration budget constraint

---

### Decision 4: Detection Timing (After Response vs During Generation)
**Alternative Considered:** Prevent tool execution if budget is low
**Chosen:** Detect empty response after LLM generation

**Rationale:**
- Pre-emptive prevention: Would require knowing response will be empty before it's generated (impossible)
- Post-response detection: Allows natural flow and only intervenes when needed
- Tool execution must happen for results to be available to recovery attempt
- Recovery prompt has tool results in context, so intervention after generation makes sense

---

### Decision 5: Generalized Analysis Prompt Over Tool-Specific Prompts
**Alternative Considered:** Unique prompt per tool type (task, workflow, shell, etc.)
**Chosen:** Generalized prompt with tool-name customization

**Rationale:**
- Single maintenance burden vs. N tool-type variants
- Generalization works for most scenarios
- Future: Can add tool-specific variants if needed without removing general logic
- Keeps code simpler and easier to understand
- Dynamic tool name extraction means it's somewhat tool-aware anyway

---

### Decision 6: Flags (Tracking Variables) vs Message History Inspection
**Alternative Considered:** Inspect conversation history to determine if tools just executed
**Chosen:** Simple boolean flags (toolsJustExecuted, emptyResponseAfterTools)

**Rationale:**
- Flags are O(1) instead of O(n) message history scan
- Clear, intention-revealing code
- Reduce cognitive load (boolean flag is easier to reason about than message pattern matching)
- Less fragile (doesn't break if message format changes)
- Scoped to single iteration (easy to understand lifecycle)

---

### Decision 7: Logging Strategy
**Alternative Considered:** 
- Silent recovery (no logs)
- Verbose logging (log every step)

**Chosen:** Structured logging with clear severity levels

**Rationale:**
- Warn level for "empty response detected" (noteworthy but not critical)
- Info level for recovery attempt result (operational awareness)
- Error level for recovery failure (indicates potential model issue)
- Debug level for detailed state (off by default, available when needed)
- Emit guardrail events for UI/monitoring (critical for user understanding)

---

## Tradeoffs

### What We Optimize For
1. **User Experience**: Always provide meaningful output, never silent
2. **Debuggability**: Clear logs showing what happened
3. **Scalability**: Works with any number of tools
4. **Maintainability**: Simple, understandable code

### What We Accept
1. **One Extra Iteration**: Recovery attempt uses one iteration from budget
2. **Message Bloat**: Analysis prompt adds one message to conversation per tool batch
3. **Model-Specific Behavior**: Some models might ignore recovery prompt anyway
4. **No Guarantee**: Recovery might still produce empty (but we tried)

---

## Future Extensibility Points

### 1. Per-Model Configuration
```typescript
const recoveryStrategy = modelConfig.getRecoveryStrategy(modelId);
if (recoveryStrategy === "aggressive") {
  // Retry with multiple different recovery prompts
} else if (recoveryStrategy === "conservative") {
  // Single retry (current implementation)
}
```

### 2. Tool-Specific Recovery Prompts
```typescript
if (toolsExecuted.includes("browser")) {
  recoveryPrompt = "Please describe what you see in the screenshot...";
} else if (toolsExecuted.includes("task")) {
  recoveryPrompt = "Please summarize the tasks you retrieved...";
}
```

### 3. Metrics Collection
```typescript
emit("metric", "empty_response_recovery_attempted", {
  attempt: 1,
  modelId: this.provider.modelId,
  toolsExecuted,
  recovered: responseLength > 0,
});
```

### 4. Context-Aware Recovery
```typescript
const conversation = this.conversation.getMessages();
const lastToolResult = conversation.findLast(m => m.role === "tool");
const recoveryPrompt = `The last tool returned: ${lastToolResult.content}. Please respond...`;
```

---

## Edge Cases Handled

### Case 1: No Tools Executed
- `toolsJustExecuted` stays false
- Recovery logic never triggers
- Normal exit path taken

### Case 2: Tools Executed but LLM Generates Content
- Empty response detection fails (response.trim().length > 0)
- Recovery never triggers
- Normal flow continues

### Case 3: Tools Executed, Empty Response, Recovery Succeeds
- Recovery prompt triggers
- LLM retries and generates content
- Recovery logged as "succeeded"
- Normal flow continues with new response

### Case 4: Tools Executed, Empty Response, Recovery Also Empty
- Recovery attempt made and logged
- Second empty response caught
- emptyResponseAfterTools flag prevents infinite loop
- Falls through to normal processing
- buildNonEmptyResponse() provides fallback

### Case 5: Out of Iterations Before Recovery
- Check: `iterations < adjustedControls.maxIterations`
- Recovery skipped to preserve iteration budget
- Fallback message shown

### Case 6: Multiple Tool Batches in Sequence
- Flags reset between batches
- Each batch gets its own recovery attempt if needed
- No cross-batch state pollution

---

## Why Not Just Change the Fallback Message?

**Bad approach** (what we're NOT doing):
```typescript
// DON'T do this:
if (toolsUsed.length > 0) {
  return "I executed these tools but have no analysis. Check the results above.";
}
```

**Why it's bad:**
- Doesn't solve the root problem (model not analyzing results)
- Users still see no actual analysis
- Defeats the point of having tools
- Encourages larger models to be lazy

**Our approach is better:**
- Actually makes the model generate analysis
- Users get meaningful answers
- Tool results are synthesized into conversation
- Scales to future use cases

---

## Validation & Testing Strategy

### Unit Tests Needed
1. Test empty response detection
2. Test recovery prompt addition
3. Test flag lifecycle
4. Test no tools scenario (flags not set)

### Integration Tests Needed
1. Full runloop with tool execution → empty response → recovery
2. Multiple tool batches
3. Iteration budget exhaustion

### Manual Testing
1. Run agent with task/workflow/cronjob list
2. Observe recovery prompts in logs
3. Verify meaningful response generated
4. Check message ordering in conversation

---

## Documentation for Users/Maintainers

When reviewing logs and seeing recovery attempts, understand:
1. **Normal behavior**: Recovery attempts are expected when using certain models
2. **Success indicator**: "Recovery retry succeeded" = good, system working as designed
3. **Failure indicator**: "Recovery retry failed" = model may need tuning or different model recommended
4. **Guardrail event**: Appears in dashboard/monitoring to track recovery frequency per model

---

## Alignment with Project Philosophy

This fix embodies ducki-node's approach:
- ✓ **Graceful degradation**: Tries recovery before giving up
- ✓ **Observable**: Clear logging and events
- ✓ **Debuggable**: Tool-specific traces and structured logs
- ✓ **Extensible**: Easy to add model-specific behavior
- ✓ **Respectful of budgets**: Honors iteration limits
- ✓ **User-centric**: Always provides an answer, never silent
