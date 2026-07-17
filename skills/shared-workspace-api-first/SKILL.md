---
name: shared-workspace-api-first
description: "Strict API-first shared workspace operations using /api/shared with filesystem fallback only on API failure."
version: 1.0.0
---

# Shared Workspace API First

## Purpose
Use this skill when shared workspace changes must follow backend API behavior exactly.

## Primary Policy
Always use /api/shared endpoints first.
Use filesystem only if API is unavailable or explicitly blocked.

## Priority Order
1. API mode (default)
2. Filesystem fallback (only after API failure)

## API Endpoints
Use these endpoints for all shared operations:
- GET /api/shared/files
- GET /api/shared/read?path=<relativePath>
- GET /api/shared/download?path=<relativePath>
- POST /api/shared/write with body { path, content }
- POST /api/shared/upload with body { fileName, contentBase64, folder? }
- POST /api/shared/move with body { fromPath, toPath }
- DELETE /api/shared/file?path=<relativePath>

## Required Execution Flow
1. Discover with GET /api/shared/files when path state is unknown.
2. Read current file content before overwrite operations.
3. Apply write/move/delete via API.
4. Verify with read or files list after mutation.
5. Use filesystem fallback only if API call fails.

HTTP control options:
- Prefer baseUrl + path + query (instead of raw url)
- Set allowedHosts to localhost-only during local runs

## Filesystem Fallback Rules
- Allowed actions: read, write, append, list, move, delete.
- Restricted root: ./shared-workspace only.
- Never perform fallback if API succeeded.
- Required options for fallback calls:
- basePath: "./shared-workspace"
- safeMode: true
- dryRun: true before destructive mutations

## Safety Rules
- Use only relative paths for API path fields.
- Reject path traversal sequences (for example ..).
- For destructive operations, output exact target path before executing.

## Output Contract
Return these fields in final summary:
1. Mode used: api or filesystem-fallback
2. Endpoint or tool actions executed
3. Paths affected
4. Verification result

## Example Tool Calls
- [TOOL:http({"action":"get","baseUrl":"http://localhost:3001","path":"/api/shared/files","allowedHosts":["localhost","127.0.0.1"]})]
- [TOOL:http({"action":"post","baseUrl":"http://localhost:3001","path":"/api/shared/write","body":{"path":"notes/today.md","content":"Daily note"},"allowedHosts":["localhost","127.0.0.1"]})]
- [TOOL:http({"action":"delete","baseUrl":"http://localhost:3001","path":"/api/shared/file","query":{"path":"notes/old.md"},"allowedHosts":["localhost","127.0.0.1"]})]
- [TOOL:filesystem({"action":"write","path":"notes/fallback.md","basePath":"./shared-workspace","safeMode":true,"createDirs":true,"content":"fallback write"})]
