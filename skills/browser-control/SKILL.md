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
- Use `form_fill` for multi-field forms (selector -> value map).
- Use `login` for standard username/password login flows.
- Use `cookies_get`, `cookies_set`, and `cookies_clear` to control authenticated state safely.
- Use `pdf` when you need printable artifacts from a page.
- Use `download` to trigger file downloads; provide `saveDir` when you need deterministic storage.
- Close sessions with `action=close` when the task is finished.

## Action Guide

- `detect`: Check local browser availability and worker isolation status.
- `launch`: Start a session. Optional: `url`, `headless`, `viewport`, `executablePath`.
- `goto`: Navigate to a URL. Optional: `waitUntil`, `timeout`.
- `click` / `type` / `press` / `wait`: Basic interaction primitives.
- `evaluate`: Execute page-context JavaScript for state inspection.
- `screenshot`: Capture page image to `filePath` or in-memory bytes.
- `cookies_get`: Read cookies for current page URL or provided `url`.
- `cookies_set`: Set one or more cookies via `cookies` array.
- `cookies_clear`: Clear all cookies for a URL or specific names via `cookieNames`.
- `form_fill`: Fill many fields with `fields: { selector: value }`.
- `login`: Use selectors and credentials (`usernameSelector`, `passwordSelector`, `submitSelector`, `username`, `password`).
- `pdf`: Save PDF to `filePath` with optional `format`, `landscape`, `printBackground`.
- `download`: Click download trigger (`selector`) and optionally enforce `saveDir`.
- `close`: End session and release browser resources.

## Good Usage

- Test a page flow from login to result.
- Verify whether an element exists before asking the user for clarification.
- Inspect DOM state with `evaluate` when the UI is not behaving as expected.
- Capture screenshots for visual confirmation or debugging.
- Use cookies actions to switch between authenticated and anonymous states in reproducible tests.
- Use `form_fill` before `login` to keep selectors and inputs explicit and auditable.

## Reliability Notes

- Browser actions run in an isolated worker process. If Puppeteer crashes, treat it as a tool failure and retry with `detect` then `launch`.
- Keep `timeout` realistic for heavy pages and large downloads.
- For `download`, verify the target directory when post-click validation is required.

## Safety

- Do not use the browser tool to access private data without explicit user intent.
- Do not enter secrets, passwords, or tokens unless the user clearly instructs it.
- Prefer read-only inspection first when the task is about recognition rather than automation.
- Avoid excessive parallel browser sessions; keep the workflow predictable.
