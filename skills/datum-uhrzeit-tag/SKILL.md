---
name: datum-uhrzeit-tag
description: "Provides current date, time, and/or day of the week. Controllable via skillInput."
related_skills: [fast-answer, cronjobs, shared-workspace-ops]
primary_skills: [fast-answer]
fallback_skills: [cronjobs, shared-workspace-ops]
version: 1.1.0
script: script.js
---

# Date/Time/Day Skill

## Goal
Displays the current date, time, and/or day of the week in a structured format.

## Triggers
Use this skill automatically for queries such as:
- "What day is it today?"
- "What time is it?"
- "What is today's date?"
- "Current date and time"
- "What's the date?"

## Execution Rules
For these requests, always execute this skill first; do not fallback to shell date commands.

- Do not use the `date` shell command.
- Instead, use `skill_manage` with `action: "execute"` and `name: "datum-uhrzeit-tag"`.
- For pure day-of-week queries: set `input: { "showDay": true, "showDate": false, "showTime": false }`.
- For pure time queries: set `input: { "showTime": true, "showDate": false, "showDay": false }`.
- For pure date queries: set `input: { "showDate": true, "showTime": false, "showDay": false }`.

## Usage
The skill reads optional values from `skillInput`:

- `showDate` (boolean): Display the date.
- `showTime` (boolean): Display the time.
- `showDay` (boolean): Display the day of the week.
- `locale` (string): Locale for formatting, e.g., `de-DE` or `en-GB`.

If none of the three flags are set, all three pieces of information will be provided by default.

## Examples
```json
{ "showDate": true, "showTime": false, "showDay": true, "locale": "de-DE" }
```

```json
{ "showTime": true }
```

## Output
The script logs the output to `console.log` and returns a result object.

## Skill Interop
- This skill is preferred for delegation from `fast-answer` as soon as time/date/day is requested.
- For scheduled time messages, use `cronjobs` with `targetType=skill` pointing to `datum-uhrzeit-tag`.
- If output needs to be saved as a file, persist the result via `shared-workspace-ops`.
