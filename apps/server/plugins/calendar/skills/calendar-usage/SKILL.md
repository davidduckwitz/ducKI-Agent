---
name: calendar-usage
description: How to manage the user's calendar (create, read, change, delete appointments) with the calendar tool. Use when the user asks to schedule a meeting, add an appointment/reminder to the calendar, check what's coming up, move or cancel an event, or list appointments in a date range.
---

# Calendar (persistent appointments)

The `calendar` tool stores appointments in this plugin's OWN SQLite database (separate from the main app database). The same data is shown on the calendar's frontend page and its widget, so anything you add here appears in the UI immediately.

Each event has: `id`, `title`, `category` (`work` | `private` | `important`), `start` and optional `end` (ISO datetime, e.g. `2026-08-10T10:00`), `all_day` (0/1), `location`, `description`.

## Create an appointment
```
[TOOL:calendar({"action": "add", "title": "Zahnarzt", "start": "2026-08-14T09:30", "end": "2026-08-14T10:15", "category": "private", "location": "Praxis Dr. Müller"})]
```
- `title` and `start` are required. `start`/`end` are ISO datetimes. For a whole-day event pass `"allDay": true` and a date like `"2026-08-16"`.
- `category` defaults to `work` if omitted.

## See what's coming up
```
[TOOL:calendar({"action": "upcoming", "limit": 5})]
```
Returns the next events from now (in `result.events`). Use this to answer "what's on my schedule".

## List / filter
```
[TOOL:calendar({"action": "list", "from": "2026-08-01", "to": "2026-08-31", "category": "work"})]
```
`from`, `to` and `category` are all optional filters. Without them, `list` returns all events sorted by start.

## Change an appointment
```
[TOOL:calendar({"action": "update", "id": 3, "start": "2026-08-14T11:00", "end": "2026-08-14T12:00"})]
```
Only the fields you pass are changed; everything else stays as it was. Use `get` (with `id`) first if you need the current values.

## Delete an appointment
```
[TOOL:calendar({"action": "delete", "id": 3})]
```

## Appointment with an automatic action
An appointment can trigger an automatic action at its start time via the internal cron system. Set `actionType` to one of `task` | `prompt` | `workflow` | `coding` (or `none`), with `actionRef` and optional `actionPayload` (JSON string):

```
[TOOL:calendar({"action": "add", "title": "Nightly Build", "start": "2026-08-12T02:00", "actionType": "workflow", "actionRef": "build-nightly"})]
```
- `task` → `actionRef` = task id; `prompt` → prompt text in `actionRef` or `actionPayload` `{"prompt":"…"}`; `workflow` → `actionRef` = workflow id; `coding` → goal in `actionRef`, options in `actionPayload` (e.g. `{"verifyCommand":"npm test"}`).
- The calendar UI links each such appointment to a one-shot cronjob (fires once at the start time). When the agent sets these fields directly, remind the user to attach/verify the cronjob, or create it with the `cronjob` tool (`targetType`, `runAt`, `runOnce: true`).

- Report created/changed/listed appointments back plainly with their date and time; the data persists across restarts.
- When the user is vague about a time, confirm the resolved date/time before adding.
