---
name: attached-file-analysis
description: How to work with files the user attached to the chat (images, PDFs, txt/html/css/json/csv/code) - what's already inlined in the prompt, when to reach for the filesystem tool instead, and pitfalls specific to PDF extraction and large tabular data.
primary_skills: ["filesystem-operations"]
related_skills: ["json-tool-format"]
fallback_skills: []
---

# Skill: Attached File Analysis

## What's already in front of you

When the user attaches a file, its content is usually already embedded directly in THIS
message - you don't need a tool call just to "find" or "open" it:

- **Images** arrive as real vision content in this turn. Describe what you actually see.
  Do not call a tool to "load", "process", or "locate" an attached image - you're already
  looking at it.
- **PDF / txt / html / css / json / csv / code files** appear inline as a block:
  ```
  --- Attached file: notes.txt (shared-workspace/chat-uploads/notes.txt) ---
  <content>
  ```
  (PDFs are labeled `Attached PDF` and contain extracted text, not the original layout.)

Read that block first. Only reach for the `filesystem` tool when you actually need
something beyond it (see below).

## When to still use the filesystem tool

- **Truncated content**: a block ending in `[... truncated - use the filesystem tool
  (read action) to read the rest at shared-workspace/<path> ...]` means only the first
  ~20k characters were inlined. Use `read` with an `offset` to continue from where it cut
  off - do not guess or hallucinate what the rest contains.
  ```
  [TOOL:filesystem({"action": "read", "path": "chat-uploads/big-report.pdf.txt", "offset": 20000})]
  ```
  (Note: PDFs don't have a `.txt` sidecar - re-read the original path; offset applies to
  the extracted text position for any file type.)
- **No inline block appeared at all** (attachment format not recognized/supported, or a
  binary format like `.docx`/`.xlsx`/images-as-data that isn't auto-extracted): use
  `filesystem` `read` on `shared-workspace/<path>` from the attachment listing yourself.
- **You need to modify, move, or re-save** the attached file - inlining is read-only
  context, not a working copy.

## PDF extraction pitfalls

Extracted PDF text is best-effort, not a faithful layout copy:
- Tables often collapse into run-on lines with lost column alignment - don't assume
  numbers you see are still grouped in their original columns; say so if it's ambiguous.
- Headers/footers/page numbers can get interleaved into the body text mid-sentence.
- Hyphenated line-break words may or may not be rejoined.

When precision matters (financial figures, exact table structure), flag the extraction
uncertainty rather than presenting a guessed structure as fact.

## Large CSV / tabular attachments

For anything beyond "skim and summarize" - counting rows matching a condition, computing
aggregates, sorting - don't eyeball a truncated text dump. Prefer:
- `script` tool (Python/Node) to actually parse and compute over the file on disk, or
- `filesystem` `grep`/`glob` to search it,

both of which see the full file, not just the ~20k-character inlined preview.
