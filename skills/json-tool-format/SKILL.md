---
name: "JSON Tool Format"
description: "Precise JSON formatting for tool calls - avoid errors with correct syntax"
primary_skills: ["tool-orchestration"]
related_skills: []
fallback_skills: []
---

# JSON Tool Format - Prevention Guide

This skill prevents the most common tool-call formatting errors.

## The Core Rule

Every tool call is:
```
[TOOL:toolName({"key1": value1, "key2": value2})]
```

Where:
- `toolName` = the tool name (no quotes)
- `{"key1": value1}` = valid JSON object
- Closing with `)]`

## JSON Value Types

| Type | Example | Correct | Wrong |
|------|---------|---------|-------|
| String | text value | `"hello"` | `hello` or `'hello'` |
| Number | integer | `123` | `"123"` |
| Decimal | float | `45.67` | `45,67` |
| Boolean | yes/no | `true` or `false` | `"true"` or `True` |
| Null | empty | `null` | `"null"` or `nil` |
| Array | list | `[1, 2, 3]` | `1, 2, 3` |
| Object | nested | `{"a": 1}` | `{a: 1}` |

## Common Tool Call Patterns

### Create Task (Most Common)
```json
{
  "action": "create",
  "title": "Task Name",
  "description": "What to do",
  "projectId": 1,
  "priority": "high"
}
```

Full call:
```
[TOOL:task({"action": "create", "title": "Implement Feature", "projectId": 1})]
```

### List Items
```json
{
  "action": "list",
  "projectId": 1
}
```

Full call:
```
[TOOL:task({"action": "list", "projectId": 1})]
```

### Update with Status
```json
{
  "action": "update",
  "id": 5,
  "status": "completed",
  "result": "Feature implemented successfully"
}
```

Full call:
```
[TOOL:task({"action": "update", "id": 5, "status": "completed"})]
```

### Shell Command
```json
{
  "command": "npm run build",
  "timeout": 300000
}
```

Full call:
```
[TOOL:shell({"command": "npm run build"})]
```

### HTTP GET
```json
{
  "action": "get",
  "url": "https://api.example.com/data",
  "headers": {
    "Authorization": "Bearer token"
  }
}
```

Full call:
```
[TOOL:http({"action": "get", "url": "https://api.example.com/data"})]
```

### HTTP POST with Body
```json
{
  "action": "post",
  "url": "https://api.example.com/users",
  "body": {
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

Full call (one line, but shown formatted):
```
[TOOL:http({
  "action": "post",
  "url": "https://api.example.com/users",
  "body": {"name": "John Doe", "email": "john@example.com"}
})]
```

### Memory Operations
```json
{
  "action": "add",
  "content": "User prefers dark theme and weekly emails"
}
```

Full call:
```
[TOOL:memory({"action": "add", "content": "User prefers dark mode"})]
```

## Escape Sequences in JSON

If you need special characters in strings:

| Character | Escape | Example |
|-----------|--------|---------|
| Quote | `\"` | `"He said \"hello\""` |
| Backslash | `\\` | `"Path: C:\\Users"` |
| Newline | `\n` | `"Line1\nLine2"` |
| Tab | `\t` | `"Col1\tCol2"` |

Example:
```
[TOOL:task({"action": "create", "title": "Task: \"Important\" work", "description": "Line1\nLine2"})]
```

## Validation Checklist

Before emitting a tool call, verify:

- [ ] Tool name is spelled correctly (no quotes)
- [ ] Opening `({"` with no space
- [ ] All JSON keys have double quotes: `"key"`
- [ ] All string values have double quotes: `"value"`
- [ ] All numbers are unquoted: `123`
- [ ] All booleans are unquoted: `true` or `false`
- [ ] Commas separate key-value pairs: `"a": 1, "b": 2`
- [ ] No trailing commas: `{"a": 1}` not `{"a": 1,}`
- [ ] Proper nesting: `{"outer": {"inner": 1}}`
- [ ] Closing with `})` or `})])` depending on context
- [ ] No extra text after the closing `]`

## Anti-Patterns (DO NOT DO)

### ❌ Wrong: Using 'json' or 'args' wrapper
```
[TOOL:task({json: {"action": "create"}})]  ← WRONG
[TOOL:task({args: {"action": "create"}})]  ← WRONG
```

**Fix**: Put the actual parameters directly:
```
[TOOL:task({"action": "create"})]  ← CORRECT
```

### ❌ Wrong: Unquoted keys
```
[TOOL:task({action: "create"})]  ← WRONG
```

**Fix**: Quote all keys:
```
[TOOL:task({"action": "create"})]  ← CORRECT
```

### ❌ Wrong: Single quotes for strings
```
[TOOL:task({"action": 'create'})]  ← WRONG
```

**Fix**: Use double quotes:
```
[TOOL:task({"action": "create"})]  ← CORRECT
```

### ❌ Wrong: Quoted numbers
```
[TOOL:task({"id": "123"})]  ← WRONG if id is numeric
```

**Fix**: Unquote numbers:
```
[TOOL:task({"id": 123})]  ← CORRECT
```

### ❌ Wrong: Missing commas
```
[TOOL:task({"a": 1 "b": 2})]  ← WRONG
```

**Fix**: Add comma separator:
```
[TOOL:task({"a": 1, "b": 2})]  ← CORRECT
```

### ❌ Wrong: Unclosed braces
```
[TOOL:task({"action": "create")  ← WRONG
```

**Fix**: Close properly:
```
[TOOL:task({"action": "create"})]  ← CORRECT
```

### ❌ Wrong: Extra text after call
```
[TOOL:task({"action": "create"})] now creating task ← WRONG
```

**Fix**: Keep tool call clean:
```
[TOOL:task({"action": "create"})]  ← CORRECT
```

## Testing Your Tool Call

Before using a complex tool call, mentally verify:

1. **Syntax**: Is the JSON valid?
   - Use a JSON validator if unsure
   
2. **Semantics**: Do the parameters make sense?
   - Does `action` have a valid value?
   - Are all required fields present?

3. **Format**: Does it match `[TOOL:name({...})]`?
   - Check brackets match
   - No extra spaces or characters

4. **Types**: Are values the right type?
   - Numbers unquoted
   - Strings quoted
   - IDs numeric if applicable

## Quick Reference

### Minimal calls:
```
[TOOL:project({"action": "list"})]
[TOOL:task({"action": "list"})]
[TOOL:memory({"action": "query", "query": "users"})]
[TOOL:shell({"command": "ls"})]
[TOOL:http({"action": "get", "url": "https://..."})]
```

### With IDs:
```
[TOOL:task({"action": "get", "id": 123})]
[TOOL:project({"action": "update", "id": 1, "name": "New Name"})]
[TOOL:task({"action": "complete", "id": 456})]
```

### With Required Fields:
```
[TOOL:task({"action": "create", "title": "My Task"})]
[TOOL:project({"action": "create", "name": "My Project"})]
[TOOL:shell({"command": "npm install"})]
```

Remember: **JSON formatting is strict. When in doubt, check every quote and comma.**
