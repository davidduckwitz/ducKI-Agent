---
name: wiki-index
description: "Regenerate the LLM-wiki's index/MOC notes - one per folder (including the root) - so there is always a stable entry point into every part of the knowledge graph, not just the top level."
related_skills: [llm-wiki, shared-workspace-ops, cronjobs]

primary_skills: [llm-wiki, shared-workspace-ops]
fallback_skills: [cronjobs]
version: 2.1.0
---

# Wiki Index Skill

## Goal
Keep one Markdown note per folder in the wiki - `llm-wiki/index.md` for the root, plus
`llm-wiki/<folder>/index.md` for every subfolder (recursively) - each a Map of Content (MOC)
for exactly that folder's contents: a short grounded summary plus `[[wikilinks]]`. Because
every `index.md` lives inside the ingested `llm-wiki/` tree, the next ingest cycle reads them
all back in automatically and their `[[links]]` become real edges in the link graph
(`GET /api/wiki/graph`) - no special-casing needed. This mirrors the graph's synthetic
per-folder hub node (see `deriveFolderStructure` in `llm-wiki-service.ts`): the hub proves two
notes in a folder are related, an `index.md` in that same folder makes that relation *legible*,
with an actual title, a real summary, and curated links instead of just a structural edge.

## When to apply
- Run on the "Wiki Index Curator" cronjob (see `cronjobs`) - every run also repairs broken
  links left over from a previous run (see step 6), so this is self-correcting over time.
- Run on explicit request ("update the wiki index", "regenerate the wiki MOC").

## Execution order
1. Discover the folder tree: use the `filesystem` tool (`action=list`, `basePath=./shared-workspace`,
   recursive) on `llm-wiki/` to enumerate every subfolder, or derive it from `wiki action=links`'s
   `folder` field / each entry's `sourcePath` prefix (everything before the last `/`).
2. Inventory the wiki: `wiki action=search query="<broad terms>"` a few times, or read entries
   via the `http` tool against `GET /api/wiki/entries?status=approved`, to see what notes exist,
   which folder each one lives in, and enough of their content/title to summarize accurately.
   Use `wiki action=get sourceFile=<id>` on individual notes if you need more than the excerpt.
3. Find structure signal with `wiki action=links sourceFile="<path>"` on a handful of candidate
   hub notes - notes with many incoming links are natural section anchors, notes with zero
   incoming links ("orphans") are candidates to link FROM their folder's index so they are
   reachable from somewhere.
4. **For each folder, including the root**, draft that folder's `index.md`:
   - A short summary paragraph (2-4 sentences) of what this folder actually contains, grounded
     only in the titles/content you inventoried in step 2 - never invent topics, dates, or facts
     that are not visible in the actual notes. If a folder's notes are all about one narrow
     subject, say so specifically rather than writing something generic like "various notes".
   - Then `[[Note Name]]` links to every note directly inside that folder (not notes in
     subfolders - those get their own index).
   - One link per immediate subfolder, pointing at *that subfolder's index note specifically* -
     use its full relative path without extension, e.g. `[[Finanzen/Bitcoin_and_Crypto/index]]`,
     not a bare folder name like `[[Bitcoin_and_Crypto]]` (folders are not files and never
     resolve) and not a bare `[[index]]` (ambiguous - every folder has one).
5. Write each with `shared-workspace-ops`, path `llm-wiki/index.md` for the root or
   `llm-wiki/<folder>/index.md` for a subfolder (relative to the `./shared-workspace` basePath),
   `overwrite: true` since these files are fully regenerated each run, not appended to. Also
   pass `backup: false` on every one of these writes - the `filesystem` tool otherwise keeps a
   `.bak` copy of the previous version on every overwrite by default (a real safety net for
   hand-authored edits), which is pure clutter here since these files are always fully
   regenerated from the wiki's current state, never hand-edited.
6. Verify each write with a `read` on the same path, then check `wiki action=links
   sourceFile=<that index's path>` (after the next ingest, or via `GET /api/wiki/graph` if you
   need it immediately) for `resolved: false` outgoing links - remove or fix any you find before
   finishing. This is what makes the index self-healing across runs: broken references from
   an earlier, less careful run get cleaned up automatically the next time this skill runs.

## Guardrails
- Only link to notes/folders that actually exist (cross-check against the entries/folder list
  from steps 1-2) - do not invent `[[links]]` to notes or subfolders you have not confirmed.
- Only write facts you can point to in an actual note's title or content - no speculation, no
  filler sentences that sound informative but say nothing concrete.
- **Touch only `index.md` files, nothing else.** Never create scratch files, scripts (`.py` or
  any other language), logs, or "notes to self" describing your plan - if you need to think
  through the structure first, do that in your own reasoning, not as a file on disk. Any such
  file gets ingested as if it were real wiki content and pollutes the knowledge base with noise
  (this has happened before - a leftover `regeneration_logic.md` full of template placeholders
  ended up as a real, highly-connected graph node). This also covers `.bak` files specifically:
  don't create one yourself, and pass `backup: false` on every index.md write (step 5) so the
  `filesystem` tool doesn't create one automatically either.
- If a write fails or a tool errors, stop and report the error - do not work around it by trying
  an alternative approach involving new files (e.g. writing a script to do the write for you).
- One folder, one index - do not fold a subfolder's notes into its parent's index; link to the
  subfolder's own `index.md` instead, so the tree stays navigable and each file stays small.
- Keep each index concise: short summary + link list, not a long essay - the resulting graph
  node for each index should stay a manageable, meaningful entry point, not a wall of text.
- Skip empty folders (no notes and no non-empty subfolders) - no index needed for those.

## Skill Interop
- Use `llm-wiki` (`wiki` tool) to inventory notes, their content, and their existing links.
- Use `shared-workspace-ops` (`filesystem` list + write/read) to discover the folder tree and
  write/read every `index.md`.
- Scheduled via `cronjobs` (targetType=skill, targetRef=wiki-index).
