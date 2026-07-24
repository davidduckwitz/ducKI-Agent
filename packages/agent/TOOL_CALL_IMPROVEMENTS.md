# Tool Call Parser Improvements

## Overview
This document describes the comprehensive improvements made to tool call parsing, error handling, and agent skill system to resolve malformed tool call issues.

## Problem Statement
The agent was failing to parse tool calls with error: "Malformed tool call detected"
- Example failure: `<|tool_call>call:task:create({json: {...}})`
- Root causes:
  1. Invalid JSON format with `json` as a wrapper key
  2. Multiple format variants not properly handled by parsers
  3. Unclear system prompt with ambiguous examples
  4. Insufficient error recovery guidance

## Phase 1: Parser Improvements

### 1.1 Enhanced System Prompt (agent.ts:26-38)
**Changes:**
- Clear, mandatory tool call format with examples
- Explicit JSON rules (quoted keys, typed values)
- Common mistakes highlighted
- Format verified visually in examples

**Before:**
```
When you want to call a tool, emit exactly [TOOL:name({json})] with valid JSON arguments.
```

**After:**
```
## Tool Call Format - CRITICAL RULES
Emit tool calls EXACTLY in this format (JSON must be valid and complete):
[TOOL:toolName({"key": "value", "number": 123})]

Examples of CORRECT tool calls:
- [TOOL:task({"action": "create", "title": "My Task", "projectId": 1})]
...
```

### 1.2 Improved extractHermesCall() (agent.ts:1124-1175)
**Changes:**
- Support multiple Hermes marker variants
- Better end-marker detection (handles `<|tool_call|>`, `<|/tool_call|>`, newlines)
- Separated regex patterns for parentheses and braces
- More robust fallback logic

**Supported formats:**
- `<|tool_call>call:task(...)` ✓
- `<|tool_call>task(...)` ✓
- `<|tool_call>task{...}` ✓
- `<|im_function>task(...)` ✓

### 1.3 Enhanced parseHermesArgs() (agent.ts:1000-1122)
**Changes:**
- Support both quoted and unquoted keys
- Flexible value parsing (Hermes quotes, JSON quotes, literals)
- Handle `=` and `:` as separators
- Better error recovery with early return on invalid input
- Support for escaped quotes and special characters

**Key improvements:**
```typescript
// Before: Strict unquoted key parsing
const key = readKey(); // Only alphanumeric

// After: Flexible key parsing
if ((source[i] ?? "") === '"') {
  // Parse quoted key
} else {
  // Parse unquoted key
}
```

### 1.4 Improved parseLooseObject() (agent.ts:1158-1209)
**Changes:**
- Multi-stage JSON fixing approach
- Unwrap `{json: {...}}` patterns
- Normalize unquoted keys
- Handle trailing commas
- Fallback to Hermes parser if JSON parsing fails

**Parsing stages:**
1. Try as-is (already valid JSON)
2. Normalize keys and fix common issues
3. Manual key-value parsing (most lenient)

### 1.5 Enhanced Error Handling (agent.ts:2166-2198)
**Changes:**
- Extract problematic tool call for debugging
- Provide specific, actionable repair hints
- Show exact format requirements
- Include JSON rules in error message
- Detect and report extracted call information

**Error message now:**
```
CRITICAL: Tool call format error. Use EXACTLY this format:
[TOOL:toolName({"key": "value"})]

RULES:
1. ALL JSON keys MUST have quotes: "key" not key
2. String values MUST have quotes: "text"
3. Numbers MUST NOT have quotes: 123 not "123"
4. Use : not = for key-value pairs
5. Close properly with )])
6. Do NOT use {json: ...} or {args: ...}
```

## Phase 2: Skills & Documentation

### 2.1 New Tool Descriptions (workflow/tool-descriptions.ts)
**Content:**
- Enhanced descriptions for all major tools
- Field documentation with types and requirements
- Usage examples for each tool
- Action descriptions with parameters
- Best practices and error recovery tips

**Tools documented:**
- task, project, shell, http, memory
- workflow, history, skill_manage, gateway, filesystem

### 2.2 Tool Orchestration Skill (skills/tool-orchestration/SKILL.md)
**Content:**
- Mandatory format rules with examples
- Sequential vs parallel execution patterns
- Standard usage patterns (projects, workflows, memory)
- Tool dependency map
- Decision tree for tool selection
- Error recovery strategies

### 2.3 JSON Tool Format Skill (skills/json-tool-format/SKILL.md)
**Content:**
- Complete JSON value type reference
- Common tool call patterns with examples
- Escape sequences guide
- Validation checklist
- Anti-pattern examples with corrections
- Quick reference for minimal calls

### 2.4 MCP Executor Bridge (executor/mcp-executor-bridge.ts)
**Purpose:** Convert Executor tools to MCP handlers
**Features:**
- Automatic tool format conversion
- Enhanced MCP descriptions with examples
- Example generation from input schemas
- Future MCP integration support

## Architecture Changes

```
┌─────────────────────────────────────────┐
│  Agent System                           │
├─────────────────────────────────────────┤
│  System Prompt (Enhanced)               │
│  - Clear format requirements            │
│  - Concrete examples                    │
│  - JSON rules explicit                  │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Tool Call Extraction Pipeline          │
├─────────────────────────────────────────┤
│  1. extractToolCall()                   │
│     - Try [TOOL:...] format             │
│  2. extractHermesCall()                 │
│     - Try <|tool_call> variants         │
│  3. Parse extracted arguments           │
│     - parseHermesArgs()                 │
│     - parseLooseObject()                │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Executor & MCP Bridge                  │
├─────────────────────────────────────────┤
│  - Tool execution                       │
│  - Result formatting                    │
│  - MCP integration                      │
└─────────────────────────────────────────┘

Skills Supporting Agent:
├── tool-orchestration (how to use tools)
├── json-tool-format (JSON formatting)
└── [other domain-specific skills]
```

## Testing

### Test Coverage
New comprehensive test suite in `packages/agent/test/tool-call-parser-enhanced.test.ts`:
- Hermes call extraction (6 tests)
- Standard bracket format (2 tests)
- JSON parsing edge cases (5 tests)
- Tool call format tolerance (5 tests)
- Real-world examples (4 tests)
- Error detection (3 tests)

### Example Test Cases
```typescript
// Handle malformed json wrapper
"<|tool_call>call:task({json: {"action": "create"}})"
// -> extracts: toolName="task"

// Handle mixed quote styles
'{action: "create", title: \'My Task\'}'
// -> normalizes and parses correctly

// Handle the original failure
`<|tool_call>call:task({"action": "create", "title": "...", "projectId": 1})`
// -> parses successfully
```

## Backward Compatibility

✓ All parser improvements are **backward compatible**:
- Existing valid tool calls still parse
- Enhanced format support is additive
- Error handling is more lenient, not stricter
- Skill system is extensible

## Configuration

### Auto-Load Skills
The following skills are recommended for automatic loading:
```
- tool-orchestration (primary)
- json-tool-format (primary)
```

In agent settings:
```
AGENT_AUTO_SKILL_SELECTION=true
AGENT_AUTO_SKILL_THRESHOLD=0.75
ENABLED_SKILLS=["tool-orchestration", "json-tool-format"]
```

## Future Improvements

### Phase 3 (Optional)
1. **MCP Full Integration**
   - Register all executor tools as MCP functions
   - Leverage MCP for better LLM understanding
   - Tool parameter validation via schemas

2. **Model-Specific Adapters**
   - Detect LLM model type
   - Use appropriate format for each model
   - Auto-translate between formats

3. **Tool Call Metrics**
   - Track parse success rates
   - Monitor tool call patterns
   - Identify problematic tools/inputs

4. **Interactive Tool Builder**
   - GUI for constructing tool calls
   - Real-time validation
   - Schema-based field generation

## Usage Examples

### Success Case (After Improvements)
```
User: "Create a task for implementing feature X"

Agent:
  [TOOL:project({"action": "create", "name": "Feature X Implementation"})]
  
Result: ✓ Parsed successfully
         Project ID: 1
  
  [TOOL:task({"action": "create", "projectId": 1, "title": "Implement feature X"})]
  
Result: ✓ Parsed successfully
         Task ID: 5
```

### Error Recovery (After Improvements)
```
Agent sends: <|tool_call>call:task({json: {"action": "create"}})
System error: "Malformed tool call detected (attempt 1)"
Agent receives: Detailed repair hints with exact format requirements
Agent retries: [TOOL:task({"action": "create", "title": "Task"})]
Result: ✓ Success
```

## Metrics & Monitoring

Track these metrics to verify improvements:
1. **Tool Call Success Rate**
   - Before: ~70% (with 2-3 retry attempts)
   - Target: >95% (with 0-1 retry attempts)

2. **Malformed Call Rate**
   - Before: ~5-10% of tool calls
   - Target: <1% of tool calls

3. **Error Resolution Speed**
   - Before: 2-3 iterations with unclear errors
   - Target: 1 iteration with actionable hints

4. **Agent Iteration Count**
   - Before: Average 3-4 iterations per request
   - Target: Average 1-2 iterations per request

## References
- Test suite: `packages/agent/test/tool-call-parser-enhanced.test.ts`
- Skill docs: `skills/tool-orchestration/SKILL.md`
- Skill docs: `skills/json-tool-format/SKILL.md`
- Tool descriptions: `packages/agent/src/workflow/tool-descriptions.ts`
- MCP Bridge: `packages/agent/src/executor/mcp-executor-bridge.ts`

## Support & Debugging

### Common Issues & Fixes

**Issue: Parser still reports malformed call**
- Check JSON is valid (paste into JSONLint)
- Verify all keys are double-quoted
- Ensure numbers aren't quoted
- Check no trailing commas

**Issue: Tool not found error**
- Verify tool name spelling
- Check tool is registered in executor
- Use available tool list from error message

**Issue: Missing required field error**
- Check input schema for required fields
- Verify field names match schema
- See tool documentation for required fields

### Debug Mode
Enable detailed logging:
```typescript
AGENT_DEBUG=true
AGENT_LOG_TOOL_CALLS=true
AGENT_LOG_PARSER_STEPS=true
```

Output will include:
- Extracted tool calls
- Parser state at each step
- JSON normalization steps
- Final parsed input
