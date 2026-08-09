---
name: skill-manage
description: Create, update, and manage Markdown-based skills so the agent can extend its own capabilities. Use when adding, editing, or documenting skills.
---

# Skill: Skill Management

## Summary
Management of skills (Markdown-based knowledge extension). With it, the agent can extend, update, and manage its own capabilities.

## Core functions

### 1. Create or update a skill
```
[TOOL:skill_manage({
  "action": "write",
  "name": "my-new-skill",
  "content": "# Skill: My Skill\n\n## Description\n..."
})]
```

**When to use:**
- Add new capabilities for specific tasks
- Document best practices and workflows
- Establish reusable patterns

### 2. List skills
```
[TOOL:skill_manage({
  "action": "list"
})]
```

**When to use:**
- Check available skills
- Before performing operations on skills
- To see which capabilities already exist

### 3. View a skill
```
[TOOL:skill_manage({
  "action": "view",
  "name": "existing-skill"
})]
```

**When to use:**
- Understand and learn from existing skills
- Check what already exists before updates
- Adopt best practices from other skills

### 4. Execute a skill (sandbox script)
```
[TOOL:skill_manage({
  "action": "execute",
  "name": "my-skill-with-script"
})]
```

**When to use:**
- Perform automated tasks
- Run scripts stored in the skill
- Only when the skill contains a `script.js`

### 5. Delete a skill
```
[TOOL:skill_manage({
  "action": "delete",
  "name": "obsolete-skill"
})]
```

**When to use:**
- Remove outdated skills
- Keep a clean code architecture
- CAUTION: deletion is permanent!

## Skill structure (best practice)

```markdown
# Skill: Descriptive Name

## Summary
1-2 sentences on what this skill does and what it is good for.

## Usage examples

### Use Case 1: [Concrete Task]
Show a code example:
\`\`\`
[TOOL:relevant_tool(...)]
\`\`\`
Explain what happens.

## Best Practices
- What to avoid
- Gotchas/pitfalls
- Performance tips

## Dependencies
- Which tools/skills are needed
- Prerequisites for use

## See also
- [other-related-skills]
```

## Integration patterns

### Pattern 1: tool-skill combination
Skills work best when they:
1. Document a specific tool (e.g. skill-manage itself)
2. Show specific use cases
3. Fit with agent workflows

### Pattern 2: skill chaining
Skills can reference other skills:
- `[TOOL:skill_manage({"action": "view", "name": "filesystem-operations"})]`
- Helps the agent learn best practices
- Creates a coherent knowledge base

## Important rules

⚠️ **CRITICAL:**
- Skills are **JSON-safe**: content must be correctly escaped
- Do not store sensitive information in skills
- Skills are PUBLIC - all agents can read them
- Skill names should be kebab-case (my-skill-name)

✅ **RECOMMENDED:**
- Short, focused skills (not > 2000 characters)
- Practical examples instead of just theory
- Include tool links: `[TOOL:tool_name(...)]`
- Think of related skills as an ecosystem

## Workflow integration

A good workflow with skills:
1. **Define the goal** - What do I need to do?
2. **Find relevant skills** - `skill_manage list` + `skill_manage view`
3. **Learn best practices** - From similar skills
4. **Use the tool** - With the documentation from the skill
5. **Evaluate the result** - Does it work?
6. **Update the skill?** - If new patterns were found

## Common mistakes

❌ **Don't:**
- Skill names too long or with underscores
- Too much text, too little structure
- Use tools without explanation
- Rely on outdated skills

✅ **Instead:**
- Short, meaningful names
- Structure with `## headings`
- Always show tool examples
- Update skills regularly

## Self-reference

This skill documents the `skill_manage` tool.
You can also use it to update itself:

```
[TOOL:skill_manage({
  "action": "write",
  "name": "skill-manage",
  "content": "[new skill text]"
})]
```

Useful for establishing best practices that all skills should follow.
