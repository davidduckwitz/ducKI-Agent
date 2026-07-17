---
name: browser-control
description: Use the browser tool to inspect, control, and verify browser-based flows safely
---

# Browser Control Skill

Use the `browser` tool whenever you need to inspect a browser page, verify UI behavior, or control a browser session.

## Rules

- Prefer `action=detect` first if browser availability is uncertain.
- Use `action=launch` to start a browser session before any navigation or interaction.
- Keep one session per task when possible, and reuse it instead of launching multiple browsers.
- Use `goto`, `click`, `type`, `press`, `wait`, and `evaluate` for targeted interactions.
- Use `list_pages` when you need to understand open tabs or page targets.
- Use `screenshot` to capture visual state when text inspection is not enough.
- Close sessions with `action=close` when the task is finished.

## Good Usage

- Test a page flow from login to result.
- Verify whether an element exists before asking the user for clarification.
- Inspect DOM state with `evaluate` when the UI is not behaving as expected.
- Capture screenshots for visual confirmation or debugging.

## Safety

- Do not use the browser tool to access private data without explicit user intent.
- Do not enter secrets, passwords, or tokens unless the user clearly instructs it.
- Prefer read-only inspection first when the task is about recognition rather than automation.
- Avoid excessive parallel browser sessions; keep the workflow predictable.
