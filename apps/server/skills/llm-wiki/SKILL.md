---
name: llm-wiki
description: "Use the LLM wiki as the primary knowledge source, with a clear order for search, moderation, and answer construction."
related_skills: [shared-workspace-ops, cronjobs, history-search, workflow-orchestrator, wiki-index]

primary_skills: [shared-workspace-ops]
fallback_skills: [history-search, workflow-orchestrator, wiki-index]
version: 1.0.0
---

# LLM Wiki Skill

## Goal
Use the LLM wiki correctly before resorting to external or unreliable sources.

## When to apply
Use this skill for questions about existing knowledge, internal documents, recurring facts, rules, project conventions, or whenever the user explicitly asks for the wiki/knowledge base.

## Execution order (two-tier: coarse first, then deepen only if needed)
1. **Tier 1 - coarse**: search with the `wiki` tool: `wiki action=search query="..."`, or read
   `llm-wiki/index.md` (the MOC entry point maintained by `wiki-index`) for orientation.
2. Phrase the search as keywords, not a full sentence - it searches over terms.
3. If nothing matches: search once more with different/broader terms before giving up.
4. **Tier 2 - deepen, only if Tier 1 wasn't enough**: `wiki action=expand query="..."` (or
   `seedIds=[...]` from a note you already found) to pull in its linked neighborhood via
   spreading activation. This is a targeted follow-up step, not a default - do not call
   `expand` before trying `search`, and do not expand when the search hits already answer
   the question.
5. For the full text of a hit or an expanded node: `wiki action=get id=<id>` (search results)
   or `wiki action=get sourceFile=<id>` (expand/links/graph results use the file path as id).
6. Prefer `approved` entries; use `candidate` only with `includeCandidates=true` and flag it as preliminary.
7. If there are no hits, say so explicitly - do not invent wiki content.

## Tool usage
- Primary: the native `wiki` tool (`action=search|get|status|links|expand`). It runs in the
  same process, so no URLs, ports, or HTTP calls are needed.
- `action=links sourceFile="<relative path>"` lists incoming/outgoing `[[wikilinks]]` for one
  note (parsed from the file plus any manually added via the graph UI). Use it before adding
  new content to see what a note already connects to, or to find orphaned notes.
- `action=expand query="..."` (or `seedIds=[...]`) spreads relevance across the link graph from
  a seed - a bounded, deterministic neighborhood lookup (hard-capped hops and node count, so it
  can never flood the context). Returns orientation only (title/status/tags/activation), never
  full text - follow up with `action=get sourceFile=<id>` on whichever result actually matters.
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

## "Befehl"/"command" tag - guaranteed-present instructions
A note whose frontmatter `tags:` includes `befehl` or `command` is not treated as ordinary
knowledge - on the next ingest it is promoted into a `[PROFILE:COMMAND:<sourceFile>]` long-term
memory at importance 9, the same guaranteed-present tier as the agent-behavior/human-info
profile blobs (see `apps/server/src/routes/memory.ts`). Ordinary wiki content is `semantic`
memory that has to compete for a limited context slot; a tagged note does not - it is reliably
present every turn, so a trigger phrase in it (e.g. "when I say 'Nachtmodus', turn off all
lights") gets recognized instead of depending on the note surfacing via search/relevance.
- This works identically for voice input: every voice path (web mic, Discord, cloud voice app)
  transcribes to text and then runs through the exact same agent loop as typed chat - there is
  no separate, lighter voice prompt path that would skip this.
- Editing the note updates the promoted instruction in place on the next ingest (no duplicate).
- Removing the tag, or deleting the file, demotes/removes the promoted instruction on the next
  ingest - it never lingers as a stale guaranteed-present memory.
- Keep command notes short and specific (a trigger phrase and what to do about it) - this is an
  always-injected instruction, not a place for long reference material.

## Skill Interop

- If relevant knowledge is missing, store new/updated content in `shared-workspace/llm-wiki` via `shared-workspace-ops`.
- Use `cronjobs` for periodic learning/reindexing.
- On answer conflicts between the wiki and history, use `history-search` as a cross-check.
- For longer knowledge pipelines, use `workflow-orchestrator`.
- For maintaining the `llm-wiki/index.md` entry point/MOC note, use `wiki-index`.
