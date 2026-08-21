---
name: time-tracking-usage
description: How to track project time and generate weekly reports with the time_tracking tool, and how to hand a week's billable hours to the invoicing plugin. Use when the user wants to start/stop a timer, log worked hours, or bill a client for time spent.
---

# Time tracking

The `time_tracking` tool stores projects and time entries in this plugin's OWN SQLite database. Only one timer can run at a time — `start_timer` automatically stops any other running entry first.

Projects, then a timer:
```
[TOOL:time_tracking({"action": "add_project", "name": "Kunde X - Website", "hourly_rate": 85})]
[TOOL:time_tracking({"action": "start_timer", "project_id": 1, "note": "Frontend-Anpassungen"})]
[TOOL:time_tracking({"action": "stop_timer"})]
```

Manual entry (when the user just tells you hours worked, no live timer):
```
[TOOL:time_tracking({"action": "add_entry", "project_id": 1, "started_at": "2026-08-24T09:00:00.000Z", "ended_at": "2026-08-24T12:30:00.000Z", "note": "Meeting + Umsetzung"})]
```

Weekly report — hours and amount (hours × hourly_rate) per project:
```
[TOOL:time_tracking({"action": "week_report", "start_date": "2026-08-24"})]
```

To bill a client for the week: take the report's `hours`/`amount` per project and call the `invoicing` tool's `create_invoice` action with one item per project, e.g. `{"description": "<project_name>, KW ...", "qty": hours, "unit_price": hourly_rate}` (see the invoicing-usage skill) — this is a cross-plugin hand-off, time-tracking never writes to invoicing's database directly.
