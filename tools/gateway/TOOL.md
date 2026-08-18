---
name: gateway
description: "List connector configs and send outbound messages via connected portals (Discord, and any other installed connector plugin)"
core: false
category: integration
---

# Gateway Tool

## Goal
Send a message out through a connected messaging portal (e.g. Discord) using the generic
`gateway` tool. This tool is portal-neutral - it dispatches to whichever connector plugin is
enabled and configured for the requested portal (see each connector plugin's own SKILL.md,
shipped alongside the plugin, for portal-specific details like field names, size limits, and
attachment support).

## Actions

### `list_configs`
Lists every configured/connected portal. No parameters beyond `action`.

```json
{"action":"list_configs"}
```

Each entry includes:
- `id`, `portal`, `name`, `enabled`, `defaultTarget`, `outboundReady`
- Capability metadata (ground truth, not prose): `maxMessageLength`, `supportsAttachments`, `supportsReactions`, `targetFieldName`, `exampleTarget`

Always call this first - it tells you which portals actually exist and are ready, and what the
correct target field name is for each one.

### `send`
Sends a message to a target on a portal.

```json
{
  "action": "send",
  "portal": "<portal-id, e.g. discord>",
  "configId": "<optional explicit config id>",
  "channelId": "<target id - see targetFieldName from list_configs>",
  "message": "<text>",
  "attachments": ["<optional shared-workspace-relative file paths>"]
}
```

`channelId` is the generic target field every connector normalizes onto (aliases `to`/`target`
also resolve to it). `message` accepts aliases `content`/`text`/`body`.

## Diagnostics
On failure, `data.diagnostic.code` gives a structured reason (e.g. `config_not_found`,
`missing_target`, `missing_message`, `attachment_error`, `not_connected`, `send_failed`). Use
`list_configs` again to re-check available portals and their `outboundReady`/capability state
before retrying.

## Portal-Specific Behavior
This document intentionally stops here. Message length limits, attachment rules, reaction
support, and example payloads are portal-specific and documented in that connector plugin's own
SKILL.md (only visible to the agent while the plugin is enabled) - see e.g. the discord-connector
plugin's `skills/discord/SKILL.md`.
