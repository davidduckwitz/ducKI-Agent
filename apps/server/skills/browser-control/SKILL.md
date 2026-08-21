---
name: browser-control
description: Use the browser tool to inspect, control, and verify browser-based flows safely
category: automation
tags: [browser, ui, automation, testing, web]
scripts:
  screenshot: "./scripts/screenshot.js"
  click: "./scripts/click.js"
dependencies: [filesystem-ops]
priority: high
related_skills: [shared-workspace-ops, shared-workspace-api-first, workflow-orchestrator, plan, fast-answer]
primary_skills: [shared-workspace-ops]
fallback_skills: [shared-workspace-api-first, workflow-orchestrator]
---

# Browser Control Skill

Use the `browser` tool whenever you need to inspect a browser page, verify UI behavior, or control a browser session.

## Rules

- **Snapshot first**: Call `action=snapshot` after navigating to learn the interactive elements (role, accessible name, deterministic CSS selector) instead of guessing CSS selectors.
- **Interact by name, not by selector guess**: Use `click { text: "..." }`, `click { role: "button", text: "..." }`, `type { target: "...", text: "..." }`, `select { option: "..." }`, `hover { text: "..." }`. Only fall back to raw `selector` when the element has no accessible name.
- Prefer `action=detect` first if browser availability is uncertain.
- Use `action=launch` to start a browser session before any navigation or interaction. Never use `open` as an action; use `launch` to start the session and `goto` to navigate to a URL.
- Keep one session per task when possible, and reuse it instead of launching multiple browsers.
- **Verify after acting**: use `action=expect` (`text_visible`, `element_visible`, `url_contains`, `no_page_errors`, ...) and `action=get_page_errors` to confirm the page actually worked.
- Use `frame: "<iframe-selector>"` on click/type/hover/expect when the target lives inside an iframe.
- Use `screenshot` to capture visual state when text inspection is not enough (needs a vision-capable model; `snapshot` and `expect` work without one).
- Use `form_fill` for multi-field forms (selector -> value map), `login` for standard username/password flows.
- Use `cookies_get`, `cookies_set`, and `cookies_clear` to control authenticated state safely.
- Use `pdf` when you need printable artifacts from a page; `download` to trigger file downloads (provide `saveDir` for deterministic storage).
- Close sessions with `action=close` when the task is finished.

## Action Guide

- `detect`: Check local browser availability and worker isolation status.
- `launch`: Start a session (reuses the shared default session; pass `newSession: true` to force a fresh browser). Optional: `url`, `headless`, `viewport`, `executablePath`, `proxyUrl`.
- `goto`: Navigate to a URL. Optional: `waitUntil`, `timeout`.
- `snapshot`: **List interactive elements** — tag, role, accessible name, state, and a deterministic CSS selector. Use this before interacting; it works without a vision model. Optional `maxNodes` (default 120).
- `click` / `hover`: Target by CSS `selector` **or** by accessible name via `text` (+ optional `role`, `exact`). Example: `click { text: "Speichern" }`.
- `type`: Fill a field by CSS `selector` **or** by accessible name via `target` (+ optional `role`); `text` is the content to type. Without a selector/target it types into the focused element.
- `select`: Choose a dropdown option by `value` **or** by visible label via `option`. Example: `select { selector: "#land", option: "Österreich" }`.
- `upload`: Attach files to an `<input type=file>` via `selector`/`target` and `filePaths` (string or array).
- `drag_drop`: Drag `source` onto `target` (both selectors). Add `html5: true` for pages that rely on DragEvent handlers.
- `press` / `wait`: Keyboard shortcuts and waits. `wait` accepts a `selector` (waits until visible) or a fixed `timeout`.
- `evaluate`: Execute page-context JavaScript for state inspection.
- `expect`: **Assertion** — polls until the condition passes or `timeout` expires, returns `passed: true/false` (not an error). Conditions: `element_visible`, `element_hidden`, `text_visible`, `text_absent`, `url_contains`, `title_contains`, `no_page_errors`.
- `get_page_errors`: Captured console errors, uncaught page errors, and failed network requests for the session. Use `clear: true` to reset.
- `screenshot`: Capture page image to `filePath` or in-memory bytes. Optional `preferLive` for live-streamed sessions.
- `switch_tab`: Activate another tab by `index` (0-based) or `urlPart`.
- `cookies_get` / `cookies_set` / `cookies_clear`: Manage cookies for the current URL (or an explicit `url`).
- `form_fill`: Fill many fields with `fields: { selector: value }`.
- `login`: Use selectors and credentials (`usernameSelector`, `passwordSelector`, `submitSelector`, `username`, `password`).
- `pdf`: Save PDF to `filePath` with optional `format`, `landscape`, `printBackground`.
- `download`: Click download trigger (`selector`) and optionally enforce `saveDir`.
- `stream_start` / `stream_stop`: Live frame streaming for vision-based inspection.
- `close`: End session and release browser resources.

## Good Usage

- **Test a UI flow**: navigate -> `snapshot` -> interact by name -> `expect` the result -> `get_page_errors`.
- Verify whether an element exists before asking the user for clarification (`expect { condition: "element_visible" }`).
- Inspect DOM state with `evaluate` when the UI is not behaving as expected.
- Capture screenshots for visual confirmation or debugging (vision model required).
- Use cookies actions to switch between authenticated and anonymous states in reproducible tests.
- Use `form_fill` before `login` to keep selectors and inputs explicit and auditable.

## Reliability Notes

- Browser actions run in an isolated worker process. If Puppeteer crashes, treat it as a tool failure and retry with `detect` then `launch`.
- Keep `timeout` realistic for heavy pages and large downloads.
- For `download`, verify the target directory when post-click validation is required.
- If a text-based target is not found, run `snapshot` again — the accessible name may differ from what the user said (e.g. icon-only buttons have `aria-label`, inputs may use `placeholder`).

## Prompt Templates

Use these templates to generate valid browser tool calls quickly.

### Inspect & Click by Name (preferred)

```json
{
  "action": "launch",
  "url": "https://example.com",
  "headless": true
}
```

```json
{
  "action": "snapshot",
  "sessionId": "<sessionId>"
}
```

```json
{
  "action": "click",
  "sessionId": "<sessionId>",
  "text": "Speichern"
}
```

```json
{
  "action": "expect",
  "sessionId": "<sessionId>",
  "condition": "text_visible",
  "text": "Gespeichert",
  "timeout": 8000
}
```

### Login Flow

1. Check environment and launch a session.
2. Navigate to login page if needed.
3. Fill credentials and submit — prefer accessible names when they exist.

```json
{
  "action": "launch",
  "url": "https://example.com/login",
  "headless": false
}
```

```json
{
  "action": "type",
  "sessionId": "<sessionId>",
  "target": "Benutzername",
  "text": "<username>"
}
```

```json
{
  "action": "type",
  "sessionId": "<sessionId>",
  "target": "Passwort",
  "text": "<password>"
}
```

```json
{
  "action": "click",
  "sessionId": "<sessionId>",
  "text": "Anmelden"
}
```

### Download Flow

1. Navigate to the page with the download trigger.
2. Click the download element and store files in a deterministic folder.

```json
{
  "action": "download",
  "sessionId": "<sessionId>",
  "selector": "a.download-report",
  "saveDir": "./storage/downloads",
  "timeoutMs": 25000
}
```

### PDF Export Flow

1. Open the target page.
2. Export to PDF with explicit output path.

```json
{
  "action": "pdf",
  "sessionId": "<sessionId>",
  "filePath": "./storage/reports/report.pdf",
  "format": "A4",
  "printBackground": true,
  "landscape": false
}
```

### Multi-field Form Fill

Use `form_fill` when multiple fields must be set before submit.

```json
{
  "action": "form_fill",
  "sessionId": "<sessionId>",
  "clearFirst": true,
  "fields": {
    "input[name='firstName']": "Max",
    "input[name='lastName']": "Mustermann",
    "input[name='city']": "Fulda"
  }
}
```

## Failure Recovery Templates

Use these patterns when a browser action fails. Prefer one recovery step at a time, then re-check state.

### Timeout During Navigation or Wait

1. Increase timeout and retry once.
2. Fall back from strict waits to `domcontentloaded`.
3. Confirm current URL and page title before next action.

```json
{
  "action": "goto",
  "sessionId": "<sessionId>",
  "url": "<targetUrl>",
  "waitUntil": "domcontentloaded",
  "timeout": 30000
}
```

### Element Not Found (selector or text)

1. Run `snapshot` to see the real roles/names/selectors on the page.
2. Retry with the accessible name from the snapshot (add `role` to disambiguate, e.g. two "Löschen" buttons).
3. Only then fall back to an explicit CSS `selector` from the snapshot output.

```json
{
  "action": "snapshot",
  "sessionId": "<sessionId>",
  "maxNodes": 150
}
```

```json
{
  "action": "click",
  "sessionId": "<sessionId>",
  "role": "button",
  "text": "Löschen",
  "exact": true
}
```

### Assertion Failed (expect passed: false)

1. Re-check state with `snapshot` / `get_content` — the element may have a different name, be hidden, or the page may have navigated.
2. If the failure was a page error, read `get_page_errors` and react to the first error before retrying.
3. Retry the interaction once, then report what was observed instead of looping.

### Login Failed or No Redirect

1. Verify fields were filled (`form_fill`/`login` or text-based `type`).
2. Retry login once with higher timeout.
3. Capture screenshot and ask for MFA/captcha guidance if still blocked.

```json
{
  "action": "login",
  "sessionId": "<sessionId>",
  "usernameSelector": "<usernameSelector>",
  "passwordSelector": "<passwordSelector>",
  "submitSelector": "<submitSelector>",
  "username": "<username>",
  "password": "<password>",
  "waitForNavigation": true,
  "timeoutMs": 30000
}
```

### Download Triggered But File Missing

1. Ensure `saveDir` is set.
2. Retry click once with longer timeout.
3. Ask user to confirm browser download policy if still missing.

```json
{
  "action": "download",
  "sessionId": "<sessionId>",
  "selector": "<downloadSelector>",
  "saveDir": "./storage/downloads",
  "timeoutMs": 30000
}
```

### Worker Crash or Session Lost

1. Run `detect` to verify local browser readiness.
2. Start a new session with `launch`.
3. Re-run only the minimal remaining steps.

```json
{
  "action": "detect"
}
```

## Safety

- Do not use the browser tool to access private data without explicit user intent.
- Do not enter secrets, passwords, or tokens unless the user clearly instructs it.
- Prefer read-only inspection first when the task is about recognition rather than automation.
- Avoid excessive parallel browser sessions; keep the workflow predictable.

## Skill Interop

- Use `shared-workspace-ops` (or `shared-workspace-api-first`) for persistent artifacts from browser runs:
- Screenshots, PDFs, downloads, export files.
- When a browser run breaks into multiple steps, first create a step sequence with `plan` or use `workflow-orchestrator` for repeatability.
- When only a direct short answer is needed, check with `fast-answer` before browser actions whether browser control is required at all.
