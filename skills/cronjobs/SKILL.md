---
name: cronjobs
description: "Manage scheduled cronjobs for tasks, prompts, tools, and skills using the cronjob tool."
version: 1.0.0
---

# Cronjobs Skill

## Purpose
Use this skill when the user asks to schedule, list, edit, enable, disable, or delete time-based automations.

## Rules
1. Use the cronjob tool for all CRUD operations.
2. Validate schedule syntax as 5 fields: minute hour day month weekday.
3. Prefer explicit target types: task, prompt, tool, skill.
4. Do not guess missing critical fields; ask the user if schedule or target is unclear.
5. When editing existing jobs, call list or get first, then update only the required fields.

## Typical Flows
1. Create prompt cronjob:
- action=create
- targetType=prompt
- schedule="0 9 * * 1-5"
- payload.prompt="Daily standup summary"

2. Create task cronjob:
- action=create
- targetType=task
- targetRef="42"
- schedule="*/30 * * * *"

3. Create tool cronjob:
- action=create
- targetType=tool
- targetRef="http"
- payload.input={"url":"http://127.0.0.1:3001/health","method":"GET"}

4. Create skill cronjob:
- action=create
- targetType=skill
- targetRef="workflow-orchestrator"
- payload.prompt="Review pending workflows and propose next steps"

## Safety
- Never store secrets inside prompt payloads.
- Keep tool payloads minimal and deterministic.
- If the user asks for destructive automation, confirm intent before creating or updating the cronjob.
