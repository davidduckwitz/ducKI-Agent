---
name: history-search
description: "Search older chats and reuse prior solutions with the history tool before re-solving from scratch."
related_skills: [llm-wiki, plan, code-review]
primary_skills: [llm-wiki]
fallback_skills: [plan, code-review]
version: 1.0.0
---

# History Search

## Purpose
Use this skill when the task may have been solved before and older conversations should be consulted.

## Primary Rule
Before implementing complex work, search historical chats for relevant prior solutions.

## Tool Contract
Use tool `history` with actions:
- `search`
- `list_conversations`
- `get_conversation`
- `get_messages`

## Recommended Flow
1. Run `history.search` with a focused query.
2. Open best matching conversation(s) with `get_messages`.
3. Extract reusable patterns, commands, and pitfalls.
4. Apply findings to current task.

## Query Guidance
- Use concise technical keywords.
- Include file names, error messages, or tool names.
- If no result, broaden query and retry once.

## Output Contract
When using this skill, report:
1. Which older chat(s) were matched
2. What was reused
3. What changed for current context
4. Remaining uncertainty or risks

## Skill Interop

- Kombiniere mit `llm-wiki`, wenn neben Chat-Historie auch kuratierte Wissenseintraege gebraucht werden.
- Ergebnisse in `plan` uebernehmen, damit Umsetzungsplaene auf realen Vorerfahrungen basieren.
- Bei wiederkehrenden Fehlermustern `code-review` hinzuziehen.


