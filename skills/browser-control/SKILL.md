---
name: browser-control
description: Use the browser tool to inspect, control, and verify browser-based flows safely

related_skills: [shared-workspace-ops, shared-workspace-api-first, workflow-orchestrator, plan, fast-answer]
primary_skills: [shared-workspace-ops]
fallback_skills: [shared-workspace-api-first, workflow-orchestrator]
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

## Prompt Templates

Use these templates to generate valid browser tool calls quickly.

### Login Flow

1. Check environment and launch a session.
2. Navigate to login page if needed.
3. Fill credentials and submit.

```json
{
	"action": "launch",
	"url": "https://example.com/login",
	"headless": false
}
```

```json
{
	"action": "login",
	"sessionId": "<sessionId>",
	"usernameSelector": "input[name='email']",
	"passwordSelector": "input[name='password']",
	"submitSelector": "button[type='submit']",
	"username": "<username>",
	"password": "<password>",
	"waitForNavigation": true,
	"timeoutMs": 20000
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

### Selector Not Found

1. Capture current DOM hints with `evaluate`.
2. Retry using alternative selectors.
3. Only then ask user for updated selector.

```json
{
	"action": "evaluate",
	"sessionId": "<sessionId>",
	"script": "() => ({ url: location.href, title: document.title, inputs: Array.from(document.querySelectorAll('input,button,a')).slice(0,25).map(el => ({tag: el.tagName, id: el.id, name: el.getAttribute('name'), cls: el.className})) })"
}
```

### Login Failed or No Redirect

1. Verify fields were filled (`form_fill`/`login` selectors).
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

- Nutze `shared-workspace-ops` (oder `shared-workspace-api-first`) fuer persistente Artefakte aus Browser-Faellen:
- Screenshots, PDFs, Downloads, Exportdateien.
- Wenn ein Browser-Lauf in mehrere Schritte zerfaellt, erstelle zuerst mit `plan` eine Schrittfolge oder nutze `workflow-orchestrator` fuer Wiederholbarkeit.
- Wenn nur eine direkte Kurzantwort noetig ist, pruefe vor Browser-Aktionen mit `fast-answer`, ob Browser-Control ueberhaupt erforderlich ist.


