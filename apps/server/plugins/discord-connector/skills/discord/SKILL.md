---
name: discord
description: "Reliable Discord send flow using the gateway tool, diagnostics, and recovery steps"
related_skills: [shared-workspace-ops, cronjobs, workflow-orchestrator]
primary_skills: [shared-workspace-ops]
fallback_skills: [cronjobs, workflow-orchestrator]
version: 2.0.0
---

# Discord Gateway Skill

This skill ships WITH the discord-connector plugin (provides.skills) - it is only visible to
the agent while the plugin is enabled, so the agent never sees Discord instructions when Discord
isn't actually available. The portal-neutral contract for the `gateway` tool itself (list_configs/
send, generic result shape) lives in `tools/gateway/TOOL.md` in core - this file only covers
Discord-specific behavior.

## Goal
Send messages to Discord reliably by using the `gateway` tool's Discord config. Avoid URL
guessing, hardcoded endpoints, or unsafe assumptions. Always react to diagnostic data
structurally.

## When to Use
- When the user wants to send a message to Discord.
- When an instruction mentions "Discord", "Gateway", "Channel", "send", "reply", or "notify".
- Outbound messages from UI chats should land in a Discord channel that was either explicitly
  mentioned by the user, is the last used, or is the default channel in the settings.

## Execution Flow
1. **Extract**: Identify the message content and potential target candidates (IDs, aliases, or names).
2. **Discovery (Mandatory)**: Execute `gateway` with `action=list_configs` first to see available transports and their capabilities.
3. **Config Selection**: Filter for a Discord entry (`portal=discord`) that is `outboundReady=true`.
4. **Target Resolution** (Discord's target field is `channelId`, a Discord channel ID):
   - Priority 1: `externalConversationId` or `channelId` explicitly provided in the user's text.
   - Priority 2: `defaultTarget`/`exampleTarget` from the selected Discord entry.
5. **Transmission**: Execute `gateway action=send` with the resolved config and target.
6. **Verification**: Check the result. If it fails, perform recovery based on the provided diagnostic code.

## Hard Rules
- **No Guessing**: Never ask for `http://localhost...` or invent endpoints. Use the `gateway` tool.
- **No Direct HTTP**: Never construct direct HTTP requests to Discord's API - the connector plugin owns that.
- **Sequential Flow**: Always perform `list_configs` in the same turn before any send attempt.
- **Explicit over Default**: If multiple configs exist, prioritize the one matching the user's explicit `configId` or target ID.

## Discord Specifics
- Message length limit: 1900 characters per chunk (the connector auto-splits longer text).
- Attachments: up to 10 files, 8MB each, as shared-workspace-relative paths.
- Reactions: supported (emoji ack on the source message).
- Bot token: configured in the discord-connector plugin's settings (or env `DISCORD_BOT_TOKEN` as a fallback seed).

## Tool Patterns

### 1. List Available Configs
```json
{"action":"list_configs"}
```
*Expected Output*: entries with `id`, `portal`, `enabled`, `defaultTarget`, `outboundReady`, plus capability metadata (`maxMessageLength`, `supportsAttachments`, `supportsReactions`, `targetFieldName`, `exampleTarget`).

### 2. Send Message (Discord)
```json
{
	"action": "send",
	"portal": "discord",
	"configId": "<config-id>",
	"channelId": "<channel-id>",
	"message": "<text>"
}
```

### 3. Send Message with Attachments (Discord)
Add `attachments`: an array of shared-workspace-relative file paths (images or documents). Max 10 files, 8MB each - larger or missing files return an `attachment_error` diagnostic instead of sending.
```json
{
	"action": "send",
	"portal": "discord",
	"channelId": "<channel-id>",
	"message": "<text>",
	"attachments": ["chat-uploads/photo.png"]
}
```
Paths may optionally be prefixed with `shared-workspace/` (as sometimes shown in file hints) - it is stripped automatically.

## Diagnostics & Recovery
When the `gateway` tool fails, use the `error` message combined with `data.diagnostic.code`:

- `config_not_found`: Re-run `list_configs` immediately and select the correct Discord config.
- `missing_target`: Use `channelId` from the request; otherwise, use `defaultTarget`. If still missing, explicitly ask the user for a Channel ID.
- `discord_transport_not_configured` / `not_connected`: Inform the user clearly that the bot token is missing or the connector isn't connected - check the discord-connector plugin settings.
- `send_failed`: State the error and attempt one retry with an alternative Discord configuration (if available).
- `missing_message`: Ask the user to reformulate the message or reconstruct it from the context.
- `attachment_error`: The `error` message states the exact cause (file not found in shared workspace, too large, or too many files). Re-check the path and retry, or drop the attachment and send text only.

## Output Format
- **Success**: Brief confirmation: "Sent to [Channel/Config Name]."
- **Failure**: Specifically state what is missing and provide the next clear step.
- **No Hallucinations**: Do not ask for URLs if the diagnostic data already identifies a specific cause (e.g., missing token).

## Guardrails
- Do not ask for hypothetical localhost URLs if a gateway configuration is available.
- On send failure, re-verify `list_configs` and check `outboundReady` status before retrying.
- **No Infinite Loops**: Maximum one retry with a different suitable configuration.

## Skill Interop
- Use `shared-workspace-ops` if Discord messages need to be stored as files/artifacts.
- Use `cronjobs` for scheduled, recurring Discord messages.
- Use `workflow-orchestrator` for complex, multi-step gateway processes.
