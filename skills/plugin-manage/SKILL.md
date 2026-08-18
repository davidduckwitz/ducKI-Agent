---
name: plugin-manage
description: Author a new file-first plugin (plugins/<name>/plugin.json + tools/ + skills/) within the strict safety rules for agent-authored plugins. Use when asked to create a new plugin for the agent.
---

# Skill: Plugin Authoring

## Summary
A plugin is a self-contained bundle of files under `plugins/<name>/` — a manifest (`plugin.json`) plus one or more tool definitions and an optional usage skill. No npm package, no database row, no build step: writing the files is the whole job. This skill documents the manifest schema and, critically, the hard safety rules that apply when **you** (the agent) are the one authoring the plugin, not a human.

## Manifest schema (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "One sentence describing what this plugin does.",
  "icon": "🔧",
  "category": "automation",
  "provides": {
    "dataSourceTools": ["tools/my-plugin.datasource.json"],
    "scriptTools": ["tools/my-plugin.tool.json"],
    "skills": ["skills/my-plugin-usage"]
  },
  "storage": { "sqlite": false },
  "enabled": true
}
```

- `name`: lowercase-kebab (`^[a-z0-9]+(-[a-z0-9]+)*$`), **must exactly match the directory name**.
- `category`: one of `overview`, `workspace`, `automation`, `knowledge`, `system`.
- `provides.dataSourceTools`: relative paths to declarative `*.datasource.json` files (no code — see below).
- `provides.scriptTools`: relative paths to `*.tool.json` files with an embedded JS snippet run in a sandbox.
- `provides.skills`: relative paths to skill directories (each with its own `SKILL.md`) that teach the *main* agent how to call your new tool.
- `storage.sqlite: true` only if the plugin genuinely needs its own persistent data (gets its own SQLite file automatically, plus a free `<name>_storage` query/exec tool).
- Everything else in the schema (`trust`, `provides.moduleTools`, `provides.oauth`, `provides.settingsPage`, `provides.frontendPage`, `provides.widgetPage`, `provides.overlayPage`, `provides.connector`) — **do not use it**. See "Hard rules" below.

## Two tool shapes

### 1. Data-source tool (preferred — no code, just config)
Use for "call a public API and summarize the result". No script to get wrong, no sandbox to escape.

`tools/<name>.datasource.json`:
```json
{
  "name": "my_plugin",
  "description": "What this tool returns, in one sentence.",
  "params": { "query": { "type": "string", "description": "..." } },
  "defaults": { "query": "default value" },
  "requests": [{ "urlTemplate": "https://api.example.com/v1/{query}" }],
  "response": { "summaryTemplate": "Result: {someField}" },
  "allowedHosts": ["api.example.com"],
  "cacheTtlMs": 3600000
}
```
Always set `allowedHosts` to the exact API host(s) you call — this is enforced, not decorative.

### 2. Script tool (only when a data-source tool genuinely cannot express the logic)
`tools/<name>.tool.json`:
```json
{
  "name": "my_plugin",
  "description": "...",
  "parameters": { "type": "object", "properties": { "action": { "type": "string" } }, "required": ["action"] },
  "async": true,
  "script": "const s = toolContext.storage; ... return { result: ... };"
}
```
The script runs in a sandbox and, when `async: true`, gets `toolContext.storage` (only if `storage.sqlite: true`) — never assume network/filesystem/secrets access beyond what `toolContext` explicitly hands you.

## Reference examples (copy these, don't invent new shapes)

- `plugins/exchange-rates/` — minimal data-source plugin: `plugin.json`, one `*.datasource.json`, one usage skill. Start here for anything that just calls a public API.
- `plugins/notes/` — script-tool plugin with its own SQLite storage. Use this shape only if the task genuinely needs persisted state.

## Hard rules (agent-authored plugins — never violate these)

⚠️ **CRITICAL — these will fail validation and your run will not complete:**
- Never set `"trust": "node"`. Always leave `trust` unset (defaults to `"sandboxed"`) or set it explicitly to `"sandboxed"`.
- Never use `provides.moduleTools` or `provides.connector` — both require `trust: "node"` and run real, unsandboxed JS. Not allowed for you, ever.
- Never use `provides.oauth`, `provides.settingsPage`, `provides.frontendPage`, `provides.widgetPage`, or `provides.overlayPage`. You may only produce backend tools (`dataSourceTools`/`scriptTools`) plus `skills` plus optional `storage.sqlite`. No browser-rendered surfaces.
- The manifest `name` must equal the directory name exactly.
- Do not fabricate API keys/secrets. If a data source needs auth, either pick a keyless public API instead, or note in your final report that the user must add a secret manually via the plugin's settings — do not invent a fake key.

✅ **Always do this before finishing:**
- Write `plugin.json` first, then the tool file(s), then the usage skill.
- Run the verify command you were given (a `validate-plugin` check) after writing files. If it fails, read the error list — it tells you exactly which rule was violated — and fix that specific thing. Do not guess.
- Keep the usage skill short (like `plugins/exchange-rates/skills/exchange-rates-usage/SKILL.md`): a summary plus one `[TOOL:your_tool({...})]` example.

## Workflow

1. Read the goal (user prompt + chosen options: category, whether storage is needed, target API hint).
2. Pick data-source vs. script tool (prefer data-source; only use script if truly necessary).
3. Write `plugin.json`, the tool file, and a short usage skill — matching the reference examples above.
4. Run the verify command. On failure, fix exactly what it reports and re-run. Never try to bypass or weaken the check.
5. Report concisely what the plugin does and which tool name the main agent will see.

Note: even after your run succeeds, the plugin is created **disabled** on purpose — a human reviews and enables it. That is expected behavior, not a failure on your part.
