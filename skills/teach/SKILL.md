---
name: teach
description: Watch the user perform a workflow and create a reusable skill from it
version: 1.0.0
category: meta
tags: [skills, learning, workflow, automation]
---

# Teach: Watch & Learn Workflow Capture

## When to Use
- The user says "/teach" or "schau mir zu" / "watch this" / "lerne daraus"
- The user wants to demonstrate a workflow once and have it captured as a reusable skill
- Ported from Grok Bot's "Show a Bot how it's done" feature

## Procedure

### 1. Announce observation mode

Tell the user:
```
📹 Teach-Mode aktiviert. Ich beobachte deine nächsten Schritte.
Führe den Workflow jetzt ganz normal aus.
Sag "fertig" oder "done" wenn du fertig bist, und ich erstelle einen Skill daraus.
```

### 2. Observe and record

For each user message during observation:
- Note the tools they ask you to use
- Note the sequence of operations
- Note any decisions, branches, or edge cases
- Note the expected output format
- Note any error handling

Do NOT execute the observed workflow yet - just record it.

### 3. Detect completion

When the user says "fertig", "done", "das war's", "that's it", or similar:
- Stop recording
- Ask one clarifying question if needed: "Soll dieser Workflow einen bestimmten Namen haben? Oder noch etwas, was ich beachten soll?"

### 4. Create the skill

Use the `/learn` approach to create a SKILL.md:

```
---
name: kebab-case-name
description: What this workflow does and when to use it
version: 1.0.0
category: user-workflows
tags: [relevant, tags]
---

# Workflow Title

## When to Use
Specific triggers for this workflow.

## Procedure
1. Step one (with any parameters the user specified)
2. Step two
3. ...

## Pitfalls
- Known edge cases the user encountered
- Workarounds discovered

## Verification
How to confirm the workflow completed successfully.
```

### 5. Save and present

Use `skill_manage(action="create", ...)` to save the skill.
Tell the user:
```
✅ Skill "/<name>" erstellt!
Du kannst ihn jederzeit mit /<name> aufrufen.
Zum Bearbeiten: /skills oder in den Einstellungen.
```

## Pitfalls
- Do NOT capture one-off tasks - only reusable workflows
- Do NOT include sensitive data (passwords, API keys) from the observation
- If the workflow is unclear, ask clarifying questions before saving
- Keep it focused: one skill per distinct workflow

## Verification
- The skill appears in the skills list
- The procedure matches what the user demonstrated
- Parameters and edge cases are documented