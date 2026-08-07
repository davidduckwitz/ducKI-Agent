---
name: fast-answer
description: "Check if no Skill is needed for fast answers"
related_skills: [datum-uhrzeit-tag, llm-wiki, history-search, browser-control, plan]

primary_skills: [datum-uhrzeit-tag, llm-wiki]
fallback_skills: [history-search, browser-control, plan]
version: 1.0.0
---

# Fast Answer

## Purpose
Check whether a direct answer is possible without a complex skill chain.

## Decision
1. If the question can be answered immediately and reliably with the available context: answer directly.
2. If a special case is detected, delegate to the appropriate skill.
3. If the task is extensive, activate `plan` or `workflow-orchestrator`.

## Skill Interop

- Always delegate time/date questions to `datum-uhrzeit-tag`.
- Prefer `llm-wiki` for knowledge/documentation questions, and optionally cross-check with `history-search`.
- Delegate browser/UI tasks to `browser-control`; store any files via `shared-workspace-ops`.
- Delegate review/quality questions to `code-review`, and implementation runs to `test-driven-development`.
