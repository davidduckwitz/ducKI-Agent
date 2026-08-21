---
name: task-sync-usage
description: How to manage tasks with deadlines and priority using the task_sync tool, and how to sync them with Todoist. Use when the user wants a real to-do with a due date/priority (not just a note), or wants their tasks synced with Todoist.
---

# Task management with deadlines

The `task_sync` tool stores tasks (title, description, due date, priority, project) in this plugin's OWN SQLite database. Use it instead of the `notes` tool whenever the user needs a deadline or priority — `notes` has no due dates.

```
[TOOL:task_sync({"action": "add_task", "title": "Angebot an Kunde X schicken", "due_date": "2026-08-25", "priority": "high", "project": "Vertrieb"})]
[TOOL:task_sync({"action": "list_tasks", "status": "open", "overdue_only": true})]
[TOOL:task_sync({"action": "complete_task", "id": 5})]
[TOOL:task_sync({"action": "update_task", "id": 5, "due_date": "2026-08-28"})]
```

`priority` is one of `low`, `medium`, `high`. `due_date` is `YYYY-MM-DD`.

## Todoist sync (optional)

Only works if the user has set a Todoist API token in this plugin's settings. Only Todoist is implemented — Linear and Trello are NOT connected yet; if the user asks for those, tell them it isn't available.

```
[TOOL:task_sync({"action": "sync_todoist", "direction": "both"})]
```

- `pull` fetches open Todoist tasks and upserts them locally (matched by `external_id`); a locally-synced task that disappeared from Todoist is marked done here too (someone completed it on the Todoist side).
- `push` creates any local task that has no `external_id` yet as a new Todoist task, then stores the returned id.
- `both` (default) does pull then push.
- If the tool returns an error about a missing token, tell the user to add their Todoist API token (Todoist → Settings → Integrations → Developer) in this plugin's settings page.
