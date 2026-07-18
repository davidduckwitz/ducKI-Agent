# MCP Integration Skill

## Goal
Use MCP servers safely and reliably: configure servers, discover tools, execute calls, and handle streaming output with reconnect awareness.

## When To Use
- The user asks to connect external MCP servers.
- A tool should be executed through MCP instead of local tool registry.
- You need to inspect MCP connectivity or available remote tools.
- You need progressive/streaming output from an MCP tool.

## Available API Endpoints
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
- `url` (base URL)
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
- If server is disconnected, wait for reconnect and retry once.
- If tool is missing, refresh/reload and re-check discovered tools.
- If stream fails mid-output, retry as non-stream call to capture final error payload.
- If configs are malformed, reset to an empty server list and re-add entries one by one.

## Skill Interop

- Fuer Dokumentation von MCP-Outputs oder Konfig-Snapshots `shared-workspace-ops` nutzen.
- Fuer geordnete, mehrstufige MCP-Tasks `workflow-orchestrator` einsetzen.
- Wenn MCP-Ergebnisse Codeaenderungen ausloesen, mit `test-driven-development` umsetzen und mit `code-review` absichern.
