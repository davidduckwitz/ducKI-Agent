# Skill: Filesystem Operations

## Summary
Work safely and efficiently with the file system via the `filesystem` tool.
All paths are confined to `shared-workspace` (unless `basePath`/`safeMode:false` is set).

## Directory or file? (IMPORTANT — most common source of errors)

Directories and files need **different actions**:

| Target | Correct | Wrong |
|---|---|---|
| See folder contents (`./shared-workspace`) | `list` | ~~`read`~~ |
| Read file contents (`./shared-workspace/notes.md`) | `read` | ~~`list`~~ |
| Unclear what the path is | `stat` (returns `isDirectory`) | guessing |

Rule of thumb: **path without a file extension → `list` or `stat` first.**

```
# Explore a folder
[TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
# then read a specific file from it
[TOOL:filesystem({"action": "read", "path": "./shared-workspace/report.md"})]
```

`read` on a directory now returns the folder listing plus a hint as a fallback —
but don't rely on that, use `list` directly.

## All actions

| Action | Purpose | Required fields |
|---|---|---|
| `read` | Read file contents | `path` |
| `write` | Create/fully overwrite a file | `path`, `content` |
| `append` | Append content | `path`, `content` |
| `edit` | Replace an exact text section | `path`, `oldString`, `newString` |
| `delete` | Delete file/folder | `path` (folder: `recursive:true`) |
| `list` | List folder contents | `path` |
| `mkdir` | Create folder (recursive) | `path` |
| `exists` | Check existence | `path` |
| `stat` | Size, timestamps, `isDirectory` | `path` |
| `move` | Move/rename | `path`, `destination` |
| `copy` | Copy a single file | `path`, `destination` |
| `glob` | Find files by pattern | `path`, `pattern` |
| `grep` | Search file contents by regex | `path`, `pattern` |

## Core functions

### Reading — also partial
```
[TOOL:filesystem({"action": "read", "path": "config.json"})]
```
Read large files in sections instead of all at once:
```
[TOOL:filesystem({"action": "read", "path": "server.log", "offset": 200, "limit": 100})]
```
- `offset` = first line (0-based), `limit` = number of lines
- `maxBytes` (default 262144) caps the output; the response tells you if it was truncated

### Modifying — prefer `edit` over `write`
```
[TOOL:filesystem({"action": "edit", "path": "src/main.ts", "oldString": "const port = 3000", "newString": "const port = 8080"})]
```
- `oldString` must occur **exactly once**, otherwise you get an error with the match count
  → provide more context or set `replaceAll:true`
- `write` overwrites the **entire** file — only for new files or a full replacement
- `write`/`append` create a `.bak` and write atomically; JSON is validated before writing

### Creating
```
[TOOL:filesystem({"action": "write", "path": "my-project/README.md", "content": "# My Project"})]
```
Parent folders are created automatically (`createDirs`, default true) — a separate `mkdir`
is only needed when you want an empty folder.

### Search instead of guess
```
[TOOL:filesystem({"action": "glob", "path": "./shared-workspace", "pattern": "**/*.ts"})]
[TOOL:filesystem({"action": "grep", "path": "./shared-workspace", "pattern": "TODO|FIXME", "filePattern": "**/*.ts"})]
```
Use this instead of walking folder by folder with `list`.

### Move, copy, delete
```
[TOOL:filesystem({"action": "move", "path": "old.txt", "destination": "new.txt"})]
[TOOL:filesystem({"action": "copy", "path": "config.json", "destination": "config.json.bak"})]
[TOOL:filesystem({"action": "delete", "path": "tmp", "recursive": true})]
```
- `move`/`copy` need `path` **and** `destination` (not `from`/`to`)
- `copy` copies single files only — for folders use the `shell` tool
- `delete` on a folder without `recursive:true` is rejected

### Dry run
Almost all writing actions accept `dryRun:true` — validates and reports without changing anything.

## Safe workflows

### Modify an existing file
```
1. [TOOL:filesystem({"action": "read", "path": "important.conf"})]
2. [TOOL:filesystem({"action": "edit", "path": "important.conf", "oldString": "[exact old section]", "newString": "[new section]"})]
```
The tool creates the `.bak` itself — no extra `copy` is needed.

### Explore an unknown directory
```
1. [TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
2. [TOOL:filesystem({"action": "glob", "path": "./shared-workspace", "pattern": "**/*.md"})]
3. [TOOL:filesystem({"action": "read", "path": "[specific file from step 1/2]"})]
```

## Read errors correctly

The tool responds with clear, actionable messages — follow them instead of giving up:

| Message | What to do |
|---|---|
| `'…' is a file, not a directory` | use `read` instead of `list` |
| `'…' is a directory, not a file` | use `list` instead of `read`/`edit`/`append` |
| `oldString is not unique (N matches)` | more context in `oldString`, or `replaceAll:true` |
| `oldString not found in file` | `read` the file first, copy the exact text |
| `Path is outside shared workspace` | put the path under `shared-workspace` or set `basePath` |
| `is a directory. Pass recursive:true` | add `recursive:true` |

## Size guidelines

- **Small** (<256KB): `read` directly
- **Large**: `read` with `offset`/`limit` in sections, or `grep` first to narrow down
- **Writing large files**: `write` first, then `append` in parts (see skill `large-file-writing`)
- **Binary files**: do not edit with `read`/`write`

## Common mistakes

❌ `read` on a folder
```
[TOOL:filesystem({"action": "read", "path": "./shared-workspace"})]
```
✅ use `list`
```
[TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
```

❌ Overwrite the whole file for one line
```
[TOOL:filesystem({"action": "write", "path": "config.json", "content": "[entire file]"})]
```
✅ Replace surgically
```
[TOOL:filesystem({"action": "edit", "path": "config.json", "oldString": "\"port\": 3000", "newString": "\"port\": 8080"})]
```

❌ `from`/`to` for move/copy — those fields do not exist
✅ `path` + `destination`

## Integration with other tools

- **git:** modify files, then `git add` + `git commit`
- **shell:** generate and run scripts, recursive copying
- **http:** store downloaded content in `shared-workspace`
