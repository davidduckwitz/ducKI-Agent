---
name: discord
description: "Reliable Discord send flow using gateway configs, diagnostics, and recovery steps"
related_skills: [shared-workspace-ops, cronjobs, workflow-orchestrator]
primary_skills: [shared-workspace-ops]
fallback_skills: [cronjobs, workflow-orchestrator]
version: 1.2.0
---

# Discord Gateway Skill

## Goal
Send messages to Discord reliably by using established gateway configurations. Avoid URL guessing, hardcoded endpoints, or unsafe assumptions. Always react to diagnostic data structurally.

## When to Use
- When the user wants to send a message to Discord.
- When an instruction mentions "Discord", "Gateway", "Channel", "send", "reply", or "notify".
- Outbound messages from UI chats should land in a Discord channel that was either explicitly mentioned by the user, is the last used, or is the default channel in the settings.

## Execution Flow
1. **Extract**: Identify the message content and potential target candidates (IDs, aliases, or names).
2. **Discovery (Mandatory)**: Execute `gateway` with `action=list_configs` first to see available transports.
3. **Config Selection**: Filter for a Discord configuration that meets these criteria:
   - `portal=discord`
   - `enabled=true`
   - **Preference**: `outboundReady=true`
4. **Target Resolution**:
   - Priority 1: `externalConversationId` or `channelId` explicitly provided in the user's text.
   - Priority 2: `defaultTarget` from the selected Discord configuration.
5. **Transmission**: Execute `gateway action=send` with the resolved config and target.
6. **Verification**: Check the result. If it fails, perform recovery based on the provided diagnostic code.

## Hard Rules
- **No Guessing**: Never ask for `http://localhost...` or invent endpoints. Use the gateway.
- **No Direct HTTP**: Never construct direct HTTP requests to Discord if the `gateway` tool is available.
- **Sequential Flow**: Always perform `list_configs` in the same turn before any send attempt.
- **Explicit over Default**: If multiple configs exist, prioritize the one matching the user's explicit `configId` or target ID.

## Configuration & Resolution

### Transport Source
The configuration is primarily sourced from the `MESSAGING_GATEWAYS` setting (managed via UI/API).

### Key Configuration Fields
- `id`: Unique configuration ID.
- `portal`: Must be `discord` for this skill.
- `enabled`: Only use configurations where `enabled=true`.
- `defaultTarget`: The configured default channel (ID).
- `outboundReady`: Indicates if the outbound transport is ready for use.

### Token & Transport Resolution (Discord)
1. **Bot Token**: Highest priority. Check environment variable `DISCORD_BOT_TOKEN`.
2. **Auth Token**: Fallback to `authToken` in the configuration (as a Bot Token).
3. **Webhook Secret**: If a URL is provided, use `webhookSecret` for Webhook transport.
4. **Failure**: If none are found, return diagnostic: `discord_transport_not_configured`.

### Target Channel Resolution
1. `externalConversationId` from tool input.
2. Alias `channelId` from tool input.
3. `defaultTarget` from the `list_configs` output.
4. **Failure**: If all are empty, return diagnostic: `missing_target`.

## Tool Patterns

### 1. List Available Configs
```json
{"action":"list_configs"}
```
*Expected Output*: List containing `id`, `portal`, `enabled`, `defaultTarget`, `outboundReady`.

### 2. Send Message (Discord)
```json
{
	"action": "send",
	"portal": "discord",
	"configId": "<config-id>",
	"externalConversationId": "<channel-id>",
	"message": "<text>"
}
```
*Alternative (Direct Channel)*:
```json
{
	"action": "send",
	"portal": "discord",
	"channelId": "<channel-id>",
	"message": "<text>"
}
```

## Diagnostics & Recovery
When the `gateway` tool fails, use the `error` message combined with `data.diagnostic.code`:

- `config_not_found`:
  - Re-run `list_configs` immediately and select the correct Discord config.
- `missing_target`:
  - Use `externalConversationId/channelId` from the request; otherwise, use `defaultTarget`.
  - If still missing, explicitly ask the user for a Channel ID.
- `discord_transport_not_configured`:
  - Inform the user clearly that the Bot Token or Discord Webhook is missing.
- `discord_http_error` or `discord_webhook_http_error`:
  - State the HTTP status and attempt one retry with an alternative Discord configuration (if available).
- `missing_message`:
  - Ask the user to reformulate the message or reconstruct it from the context.

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
