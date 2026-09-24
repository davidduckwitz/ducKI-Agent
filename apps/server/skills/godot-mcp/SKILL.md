---
name: godot-mcp
description: "Control or diagnose the running Godot editor through ducki-node MCP. Use for Godot scenes, nodes, project execution, editor errors, or incorrect MCP argument formats."
---

# Godot through ducki-node MCP

The `mcp` tool routes calls to configured servers. A remote tool's arguments are
not the arguments of `mcp`. Use the native tool interface when available; otherwise
use the existing `tool_call` bridge. Load this skill with
`skill_manage` action `view`, name `godot-mcp`.

## Discover and connect

1. Call `mcp` with `{"action":"list_servers"}` and use the actual Godot server ID.
2. Discover its tools using `{"action":"list_tools","serverId":"godot-mcp"}`.
   To retrieve just one schema, also specify `"toolName":"session_manage"`.
3. Call the discovered session tool, then inspect `editor_state`. If multiple
   editor sessions exist, select the session belonging to the requested project.
   Use returned IDs; do not invent them.

Exact direct `mcp` arguments for listing Godot sessions:

```json
{"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}
```

The same invocation through **tool_call** (these are arguments to tool_call):

```json
{"tool_name":"mcp","arguments":{"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}}
```

Read editor state through **tool_call**:

```json
{"tool_name":"mcp","arguments":{"action":"call_tool","serverId":"godot-mcp","toolName":"editor_state","input":{}}}
```

Only use these names after discovery confirms them. For other tools, replace
`toolName` and build `input` according to the returned `inputSchema`.
In particular, `op`, `params` and `session_id` belong **inside input**.
`{"op":"list","serverId":"godot-mcp"}` is not a valid router call.

## Recover from errors

- Missing/unknown MCP `action`: fix the wrapper and retry. This is a local
  argument error, not evidence that Godot or its server is unavailable.
- Missing remote argument or unknown operation: retrieve the exact tool schema,
  correct `input`, then retry. Do not blindly repeat the same failing arguments.
- Server disconnected or no sessions: report that specific state. Check the
  Godot plugin connection; do not launch competing servers or change ports just
  because an argument was malformed.
- Inspect both the router's `success` and MCP `isError`/content. A successful
  discovery alone does not prove that an editor operation succeeded.

## Godot diagnosis

Use editor errors and actual scene contents to diagnose compatibility problems.
`[ext_resource]` and `[sub_resource]` are valid Godot 4 TSCN sections; their presence
does not imply a Godot 3 scene. Do not replace them with script `load()` calls as
a supposed format migration. See the [Godot 4 TSCN reference](https://docs.godotengine.org/en/4.5/engine_details/file_formats/tscn.html).

Perform only the project operations requested by the user. After edits, verify
the affected scene or run the relevant project check through discovered tools.
Report actual results in the user's language.
