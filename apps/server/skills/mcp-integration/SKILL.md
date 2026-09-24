---
name: mcp-integration
description: Use MCP servers safely and reliably - configure servers, discover tools, execute calls, and handle streaming output with reconnect awareness. Use for MCP integration tasks.
---

# MCP Integration Skill

## Goal
Use MCP servers safely and reliably: configure servers, discover tools, execute calls, and handle streaming output with reconnect awareness.

## When To Use
- The user asks to connect external MCP servers.
- A tool should be executed through MCP instead of local tool registry.
- You need to inspect MCP connectivity or available remote tools.
- You need progressive/streaming output from an MCP tool.

## Available API Endpoints
For agent work, prefer the registered `mcp` tool. It is a router with its own
arguments, separate from the remote tool's schema:

```json
{"action":"list_tools","serverId":"godot-mcp"}
```

After discovering the remote tool, call it with:

```json
{"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}
```

If `mcp` is deferred behind `tool_call`, use this exact nesting:

```json
{"tool_name":"mcp","arguments":{"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}}
```

Use actual discovered server IDs and tool names. Never send remote fields such
as `op` directly to `mcp`; they belong inside `input`. Missing/unknown `action`
means the wrapper is malformed, not that the server is down. Correct the wrapper
before switching approaches. For Godot work, load skill `godot-mcp` using
`skill_manage` with `action: "view"` and `name: "godot-mcp"`.

These HTTP endpoints are available for integration and administration:
- `GET /api/mcp/servers` -> configured + runtime server status
- `PUT /api/mcp/servers` -> replace server list and sync runtime
- `POST /api/mcp/servers/reload` -> reload from settings and resync
- `GET /api/mcp/tools` -> list discovered MCP tools
- `POST /api/mcp/tools/call` -> execute a tool once
- `POST /api/mcp/tools/stream` -> SSE stream output

## Data Model
Each MCP server entry:
- `id` (stable identifier)
- `name` (human label)
- `transport` (`stdio`, standard MCP `http`, or ducki `legacy-http`)
- `url` (HTTP endpoint) or `command` and `args` (stdio process)
- optional `env` and `cwd` for stdio
- `enabled` (`true` or `false`)

Runtime status fields:
- `connected`
- `reconnectAttempts`
- `tools`

## Recommended Flow
1. Load server state with `GET /api/mcp/servers`.
2. If needed, save server config with `PUT /api/mcp/servers`.
3. Trigger `POST /api/mcp/servers/reload` after config changes.
4. Discover tools via `GET /api/mcp/tools`.
5. Execute with `POST /api/mcp/tools/call`.
6. For long responses, switch to `POST /api/mcp/tools/stream`.

## Safety Rules
- Validate `toolName` before calling.
- Validate JSON input before sending.
- Prefer explicit `serverId` when same tool names exist on multiple servers.
- Do not store secrets in plain settings fields.
- Surface server disconnect status to users before running critical calls.

## Failure Recovery
- If server is disconnected, check its error and reload after fixing the cause.
- If tool is missing, refresh/reload and re-check discovered tools.
- If stream fails mid-output, retry as non-stream call to capture final error payload.
- If configs are malformed, correct the invalid entry and preserve other servers.

## Skill Interop

- Use `shared-workspace-ops` to document MCP outputs or config snapshots.
- Use `workflow-orchestrator` for ordered, multi-step MCP tasks.
- When MCP results trigger code changes, implement with `test-driven-development` and safeguard with `code-review`.
