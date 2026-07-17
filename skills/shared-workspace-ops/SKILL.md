---
name: shared-workspace-ops
description: "Use shared-workspace directly or via /api/shared endpoints for read/write/create/move/delete operations."
version: 1.0.0
---

# Shared Workspace Operations

## Purpose
Use this skill when the user asks to create, read, edit, move, upload, download, or delete files that should live in the shared workspace.

## Decision Rule (First Step)
Before loading any heavy workflow, decide which path is best:
1. Use filesystem tool when direct local file editing in shared-workspace is enough.
2. Use http tool with /api/shared API when behavior must mirror backend/UI API contracts.
3. If uncertain, start with API discovery using GET /api/shared/files.

## Allowed Storage Scope
- Preferred root: ./shared-workspace
- Never write outside the shared workspace for shared artifacts.
- Reject any path traversal pattern (for example .. segments).

## API Endpoints
Use base URL from runtime settings and call these endpoints:
- GET /api/shared/files
- GET /api/shared/read?path=<relativePath>
- GET /api/shared/download?path=<relativePath>
- POST /api/shared/write with body { path, content }
- POST /api/shared/upload with body { fileName, contentBase64, folder? }
- POST /api/shared/move with body { fromPath, toPath }
- DELETE /api/shared/file?path=<relativePath>

## Tool Strategy

### Local Filesystem Preferred
Use filesystem actions for fast local operations in shared-workspace:
- read
- write
- append
- list
- move
- delete

Recommended control flags:
- basePath: "./shared-workspace"
- safeMode: true
- createDirs: true
- dryRun: false (set true for preview)
- overwrite: explicit for write operations

### API Preferred
Use http actions when:
- You need parity with frontend behavior.
- You must validate server-side path rules and responses.
- You need binary transfer semantics (upload/download).

Recommended control fields:
- baseUrl + path instead of full url
- query for path parameters
- allowedHosts for host allowlist (example: ["localhost", "127.0.0.1"])

## Safety Rules
- Always use relative paths inside shared-workspace.
- For writes, ensure parent folders exist.
- For replace edits, read first and verify expected content before writing.
- For destructive actions (delete/move), confirm exact target path in output.

## Output Contract
When done, return:
1. Chosen mode: filesystem or API
2. Exact path(s) changed
3. Operation result summary
4. Next recommended action (if any)

## Example Tool Calls
- [TOOL:filesystem({"action":"write","path":"notes/todo.md","basePath":"./shared-workspace","safeMode":true,"createDirs":true,"overwrite":true,"content":"# Todo"})]
- [TOOL:filesystem({"action":"delete","path":"notes/old.md","basePath":"./shared-workspace","safeMode":true,"dryRun":true})]
- [TOOL:http({"action":"get","baseUrl":"http://localhost:3001","path":"/api/shared/files","allowedHosts":["localhost","127.0.0.1"]})]
- [TOOL:http({"action":"get","baseUrl":"http://localhost:3001","path":"/api/shared/read","query":{"path":"docs/readme.md"},"allowedHosts":["localhost","127.0.0.1"]})]
- [TOOL:http({"action":"post","baseUrl":"http://localhost:3001","path":"/api/shared/write","body":{"path":"docs/readme.md","content":"Hello"},"allowedHosts":["localhost","127.0.0.1"]})]
