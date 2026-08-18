---
name: telegram
description: "Reliable Telegram send flow using the gateway tool, diagnostics, and recovery steps"
related_skills: [shared-workspace-ops, cronjobs, workflow-orchestrator]
primary_skills: [shared-workspace-ops]
fallback_skills: [cronjobs, workflow-orchestrator]
version: 1.0.0
---

# Telegram Gateway Skill

This skill ships WITH the telegram-connector plugin (provides.skills) - it is only visible to
the agent while the plugin is enabled, so the agent never sees Telegram instructions when
Telegram isn't actually available. The portal-neutral contract for the `gateway` tool itself
(list_configs/send, generic result shape) lives in `tools/gateway/TOOL.md` in core - this file
only covers Telegram-specific behavior.

## Goal
Send messages to Telegram reliably by using the `gateway` tool's Telegram config. Avoid URL
guessing, hardcoded endpoints, or unsafe assumptions. Always react to diagnostic data
structurally.

## When to Use
- When the user wants to send a message to Telegram.
- When an instruction mentions "Telegram", "Chat", "Bot", "send", "reply", or "notify" in a
  Telegram context.
- Outbound messages from UI chats should land in a Telegram chat that was either explicitly
  mentioned by the user, is the last used, or is the default chat in the settings.

## Execution Flow
1. **Extract**: Identify the message content and potential target candidates (chat IDs, aliases, or names).
2. **Discovery (Mandatory)**: Execute `gateway` with `action=list_configs` first to see available transports and their capabilities.
3. **Config Selection**: Filter for a Telegram entry (`portal=telegram`) that is `outboundReady=true`.
4. **Target Resolution** (Telegram's target field is `channelId`, mapped internally to a Telegram chat_id):
   - Priority 1: `externalConversationId` or `channelId` explicitly provided in the user's text.
   - Priority 2: `defaultTarget`/`exampleTarget` from the selected Telegram entry.
5. **Transmission**: Execute `gateway action=send` with the resolved config and target.
6. **Verification**: Check the result. If it fails, perform recovery based on the provided diagnostic code.

## Hard Rules
- **No Guessing**: Never ask for `http://localhost...` or invent endpoints. Use the `gateway` tool.
- **No Direct HTTP**: Never construct direct HTTP requests to the Telegram Bot API - the connector plugin owns that.
- **Sequential Flow**: Always perform `list_configs` in the same turn before any send attempt.
- **Explicit over Default**: If multiple configs exist, prioritize the one matching the user's explicit `configId` or target ID.

## Telegram Specifics
- Message length limit: 4000 characters per chunk (the connector auto-splits longer text; Telegram's hard limit is 4096).
- Attachments: images are sent as photos, everything else as a document; up to 10 files, 20MB each, as shared-workspace-relative paths. The first text chunk becomes the caption of the first attachment.
- Reactions: not supported by this connector (Telegram message reactions are not implemented).
- Bot token: configured in the telegram-connector plugin's settings (or env `TELEGRAM_BOT_TOKEN` as a fallback seed) - get one from **@BotFather** in Telegram (`/newbot`).
- Inbound is long-polling (no public webhook URL needed) - the connector must be "active" (see `list_configs`) to receive messages at all.

## Tool Patterns

### 1. List Available Configs
```json
{"action":"list_configs"}
```
*Expected Output*: entries with `id`, `portal`, `enabled`, `defaultTarget`, `outboundReady`, plus capability metadata (`maxMessageLength`, `supportsAttachments`, `supportsReactions`, `targetFieldName`, `exampleTarget`).

### 2. Send Message (Telegram)
```json
{
	"action": "send",
	"portal": "telegram",
	"configId": "<config-id>",
	"channelId": "<telegram-chat-id>",
	"message": "<text>"
}
```

### 3. Send Message with Attachments (Telegram)
Add `attachments`: an array of shared-workspace-relative file paths (images or documents). Max 10 files, 20MB each - larger or missing files return an `attachment_error` diagnostic instead of sending.
```json
{
	"action": "send",
	"portal": "telegram",
	"channelId": "<telegram-chat-id>",
	"message": "<text>",
	"attachments": ["chat-uploads/photo.png"]
}
```
Paths may optionally be prefixed with `shared-workspace/` (as sometimes shown in file hints) - it is stripped automatically.

## Diagnostics & Recovery
When the `gateway` tool fails, use the `error` message combined with `data.diagnostic.code`:

- `config_not_found`: Re-run `list_configs` immediately and select the correct Telegram config.
- `missing_target`: Use `channelId` from the request; otherwise, use `defaultTarget`. If still missing, explicitly ask the user for the Telegram chat ID.
- `not_connected`: Inform the user clearly that the bot token is missing or the connector isn't connected - check the telegram-connector plugin settings.
- `send_failed`: State the error and attempt one retry with an alternative Telegram configuration (if available).
- `missing_message`: Ask the user to reformulate the message or reconstruct it from the context.
- `attachment_error`: The `error` message states the exact cause (file not found in shared workspace, too large, or too many files). Re-check the path and retry, or drop the attachment and send text only.

## Output Format
- **Success**: Brief confirmation: "Sent to [Chat/Config Name]."
- **Failure**: Specifically state what is missing and provide the next clear step.
- **No Hallucinations**: Do not ask for URLs if the diagnostic data already identifies a specific cause (e.g., missing token).

## Guardrails
- Do not ask for hypothetical localhost URLs if a gateway configuration is available.
- On send failure, re-verify `list_configs` and check `outboundReady` status before retrying.
- **No Infinite Loops**: Maximum one retry with a different suitable configuration.

## Skill Interop
- Use `shared-workspace-ops` if Telegram messages need to be stored as files/artifacts.
- Use `cronjobs` for scheduled, recurring Telegram messages.
- Use `workflow-orchestrator` for complex, multi-step gateway processes.
