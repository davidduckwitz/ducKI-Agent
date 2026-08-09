---
name: large-file-writing
description: "How to write files reliably - use the escaping-free block-write form for any multi-line file, and chunk with write+append only when a file is too large for one response. Use when writing HTML, CSS, JS/TS, JSON, or any multi-line file, especially large ones."
---

# Writing Files Reliably

Two things break file writes: (1) JSON-escaping multi-line content, and (2) exceeding the response token limit. Handle them separately.

## 1. Prefer the block-write form (no escaping - the safe default)

For ANY multi-line file, write the content as a verbatim block instead of a JSON string. The body between the header and `[/TOOL]` is taken exactly as-is — no `\n`, no escaped quotes, no chance of the tool-call syntax leaking into the file:

```
[TOOL:filesystem action=write path=index.html]
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My App</title>
</head>
<body>
  <h1>Hello</h1>
</body>
</html>
[/TOOL]
```

Rules:
- Header line holds only simple `key=value` args (`action`, `path`, and for the coding agent `project`). No JSON, no `(` or `{` on the header line.
- Everything until the `[/TOOL]` line is the literal file content.
- Always close with a line containing exactly `[/TOOL]`.

> When the backend supports **native tool calls**, arguments (including `content`) are passed as structured JSON by the runtime — also escaping-free. The block form is the reliable equivalent for the text protocol and for weaker local models. Either way: never hand-escape a large document into a JSON string.

## 2. Chunk only when a file is too big for one response

Model output is capped (~4-8k tokens per response). A file that won't fit in one turn must be split — this is the ONLY reason to chunk, and it is independent of escaping.

| Part | Action | Content |
|------|--------|---------|
| 1 | `write` | Structure / head / setup |
| 2 | `append` | Main content |
| 3 | `append` | Closing sections |

Use the block form for each part too:

```
[TOOL:filesystem action=write path=app.js]
// Part 1: imports + setup
import { init } from "./init.js";
[/TOOL]
```
```
[TOOL:filesystem action=append path=app.js]
// Part 2: main logic
export function run() { /* ... */ }
[/TOOL]
```

Rough thresholds (only about fitting in one response):
- < ~300 lines → single `write`
- ~300-800 lines → 2-3 parts
- 800+ lines → 4+ parts

## Legacy JSON form (only if you must inline content)

If you write content inside a JSON string instead of a block, THEN — and only then — the old escaping rules apply: `\n` for newlines, `\"` for quotes, and close with `})]`. This is fragile with large content; prefer the block form above.

## Key rules

✅ DO
- Use the block form (`[TOOL:...]\n...\n[/TOOL]`) for multi-line files.
- Chunk with `write` (Part 1) then `append` (Parts 2+) only to beat the response token limit.
- Split at logical boundaries (closing tags, section breaks) and report "Part X/Y".

❌ DON'T
- Hand-escape a large document into a JSON `content` string.
- Chunk a file that already fits in one response.
- Mix `write` and `append` for the same file in one turn without waiting for each result.

## Troubleshooting

**File looks truncated** — the write exceeded the token limit; split into more parts with `append`.
**`append` says "file not found"** — Part 1 must succeed with `write` before appending.
**Stray `[/TOOL]`, `"})]`, or tool markers in the file** — you used the JSON form and it mis-closed; switch to the block form, which cannot leak these.

## Related

- `filesystem-operations` — full filesystem tool reference (read/edit/list/etc.).
- `shell-commands-win` / `shell-commands-nix` — writing runnable `.ps1` / `.sh` scripts.
