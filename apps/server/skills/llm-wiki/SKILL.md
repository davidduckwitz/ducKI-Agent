---
name: llm-wiki
description: "Use the LLM wiki as the primary knowledge source, with a clear order for search, moderation, and answer construction."
related_skills: [shared-workspace-ops, cronjobs, history-search, workflow-orchestrator]

primary_skills: [shared-workspace-ops]
fallback_skills: [history-search, workflow-orchestrator]
version: 1.0.0
---

# LLM Wiki Skill

## Goal
Use the LLM wiki correctly before resorting to external or unreliable sources.

## When to apply
Use this skill for questions about existing knowledge, internal documents, recurring facts, rules, project conventions, or whenever the user explicitly asks for the wiki/knowledge base.

## Execution order
1. Search with the `wiki` tool: `wiki action=search query="..."`.
2. Phrase the search as keywords, not a full sentence - it searches over terms.
3. If nothing matches: search once more with different/broader terms before giving up.
4. For the full text of a hit: `wiki action=get id=<id>`.
5. Prefer `approved` entries; use `candidate` only with `includeCandidates=true` and flag it as preliminary.
6. If there are no hits, say so explicitly - do not invent wiki content.

## Tool usage
- Primary: the native `wiki` tool (`action=search|get|status`). It runs in the same process,
  so no URLs, ports, or HTTP calls are needed.
- Use the HTTP tool only for moderation (approve/reject) against `/api/wiki/entries/:id/approve`
  or `.../reject`, and only on an explicit review request.

## Answer rules
- When stating facts, briefly cite the source (`sourcePath`/title).
- With multiple hits: prioritize the highest score plus more recent entries.
- Separate confirmed knowledge (approved) from preliminary knowledge (candidate).

## Guardrails
- No hallucinating when there are no hits.
- Do not silently treat `candidate` entries as hard truth.
- If the wiki is disabled, point that out and continue with alternative sources.

## Skill Interop

- If relevant knowledge is missing, store new/updated content in `shared-workspace/llm-wiki` via `shared-workspace-ops`.
- Use `cronjobs` for periodic learning/reindexing.
- On answer conflicts between the wiki and history, use `history-search` as a cross-check.
- For longer knowledge pipelines, use `workflow-orchestrator`.
