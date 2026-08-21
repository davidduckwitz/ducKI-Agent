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

Model output is capped per response. A file that won't fit in one turn must be split — this is the ONLY reason to chunk, and it is independent of escaping.

**Always number the parts.** Pass `totalParts` on the write and `partNumber`/`totalParts` on each append. The tool then VERIFIES the sequence: parts must arrive exactly once, in order, without gaps — a missing/duplicated/reordered part is a hard error, and the tool only reports the file complete once ALL parts arrived. Without the numbers, a silently dropped part would look like a finished file.

| Part | Action | Header args |
|------|--------|-------------|
| 1 | `write` | `path=app.js totalParts=3` |
| 2 | `append` | `path=app.js partNumber=2 totalParts=3` |
| 3 | `append` | `path=app.js partNumber=3 totalParts=3` |

Use the block form for each part too:

```
[TOOL:filesystem action=write path=app.js totalParts=3]
// Part 1: imports + setup
import { init } from "./init.js";
[/TOOL]
```
```
[TOOL:filesystem action=append path=app.js partNumber=2 totalParts=3]
// Part 2: main logic
export function run() { /* ... */ }
[/TOOL]
```
```
[TOOL:filesystem action=append path=app.js partNumber=3 totalParts=3]
// Part 3: exports + footer
[/TOOL]
```

The tool answers each part with a note naming the next part to send (`Send the next part with partNumber:3`) and confirms `All 3 parts received - the file is complete` on the last one. If the tool refuses with a gap/duplicate error, it tells you which part is missing — send exactly that part, do NOT restart from scratch.

Rough thresholds (only about fitting in one response):
- < ~300 lines → single `write` (no part args needed, or `totalParts=1`)
- ~300-800 lines → 2-3 parts
- 800+ lines → 4+ parts

## Legacy JSON form (only if you must inline content)

If you write content inside a JSON string instead of a block, THEN — and only then — the old escaping rules apply: `\n` for newlines, `\"` for quotes, and close with `})]`. This is fragile with large content; prefer the block form above. Part numbering works identically: pass `partNumber`/`totalParts` inside the JSON args.

## Key rules

✅ DO
- Use the block form (`[TOOL:...]\n...\n[/TOOL]`) for multi-line files.
- For any file split across calls: `write` with `totalParts=N`, then `append` with `partNumber=2..N` and `totalParts=N` — always in order, one part per response.
- Split at logical boundaries (closing tags, section breaks).
- On a gap/duplicate error from the tool, send exactly the missing part it names.

❌ DON'T
- Hand-escape a large document into a JSON `content` string.
- Chunk a file that already fits in one response.
- Skip `partNumber`/`totalParts` when a file is split across calls — the tool cannot verify completeness without them.
- Send parts out of order or repeat a part.

## Troubleshooting

**File looks truncated** — the write exceeded the token limit; split into more parts with `append`.
**`append` says "Gap detected: expected part X"** — part X was never written; send it now (the earlier parts are still on disk and in the sequence).
**`append` says "No part sequence is in progress"** — the sequence was never started or a plain write replaced it; restart with `action:write totalParts=N`.
**`append` says "No part sequence is in progress" after completing** — that is normal: the sequence is finished, so further appends must be plain (no part args) or a fresh parted write.
**Stray `[/TOOL]`, `"})]`, or tool markers in the file** — you used the JSON form and it mis-closed; switch to the block form, which cannot leak these.

## Related

- `filesystem-operations` — full filesystem tool reference (read/edit/list/etc.).
- `shell-commands-win` / `shell-commands-nix` — writing runnable `.ps1` / `.sh` scripts.
