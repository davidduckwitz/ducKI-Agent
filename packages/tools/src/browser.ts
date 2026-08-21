import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { existsSync } from "node:fs";
import { execSync, fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

type BrowserAction =
  | "detect"
  | "launch"
  | "list_pages"
  | "list_sessions"
  | "goto"
  | "click"
  | "type"
  | "press"
  | "wait"
  | "screenshot"
  | "get_content"
  | "evaluate"
  | "cookies_get"
  | "cookies_set"
  | "cookies_clear"
  | "form_fill"
  | "login"
  | "pdf"
  | "download"
  | "close"
  // Macro actions: collapse the common multi-step sequences (launch -> goto -> wait ->
  // screenshot, or goto -> wait -> evaluate) into ONE call. Each round-trip through the
  // LLM is a chance for a weak/local model to drop the real sessionId or only emit one
  // step per turn instead of the documented batch - a single macro call removes that
  // failure mode entirely for the two most common workflows.
  | "screenshot_url"
  | "verify_page"
  // Live preview: CDP screencast pushes frames from the worker to the main process as they
  // render, instead of the caller polling `screenshot` repeatedly. See browserFrameEvents.
  | "stream_start"
  | "stream_stop"
  // Interaction & testing upgrades: accessibility-style element snapshot + text/role-based
  // targeting (so the model doesn't have to guess CSS selectors), page-error capture and
  // expect-style assertions, plus hover/drag&drop/select/upload/tab-switching.
  | "snapshot"
  | "get_page_errors"
  | "expect"
  | "hover"
  | "drag_drop"
  | "select"
  | "upload"
  | "switch_tab";

interface BrowserSession {
  browser: import("puppeteer-core").Browser;
  page: import("puppeteer-core").Page;
  launchedAt: string;
  targetUrl?: string;
  /** Puppeteer fixes headless mode at launch - it can't be toggled on a running browser.
   *  Recorded so a later launch/screenshot_url call that requests a DIFFERENT headless
   *  mode (e.g. the user just changed BROWSER_HEADLESS_MODE in Settings) can detect the
   *  mismatch and relaunch instead of silently reusing a session in the wrong mode. */
  headless: boolean;
  /** Console errors + uncaught page errors captured since the session started (or since
   *  the last get_page_errors with clear=true). See attachPageListeners(). */
  pageErrors: Array<{ type: string; text: string; url: string; timestamp: string }>;
  /** Failed network requests captured since the session started. See attachPageListeners(). */
  networkErrors: Array<{ url: string; method: string; error: string; timestamp: string }>;
}

interface BrowserWorkerRequest {
  id: string;
  input: Record<string, unknown>;
}

interface BrowserWorkerResponse {
  kind?: "response";
  id: string;
  result: ToolResult;
}

/** Pushed unsolicited from the worker whenever a live-streamed session renders a new frame -
 *  not a response to any pending request, so it's distinguished from BrowserWorkerResponse by
 *  `kind`. */
interface BrowserWorkerFrame {
  kind: "frame";
  sessionId: string;
  data: string;
  format: string;
  timestamp: string;
}

type BrowserWorkerMessage = BrowserWorkerResponse | BrowserWorkerFrame;

/**
 * Emits a "frame" event, `{sessionId, data, format, timestamp}`, for every screencast frame
 * received from a live-streaming session (see action="stream_start"). This module runs inside
 * apps/server's main process (the actual browser lives in the forked worker), so the server
 * can subscribe once at startup and relay frames to the UI over its own transport (socket.io)
 * without this package needing to know sockets exist.
 */
export const browserFrameEvents = new EventEmitter();

// Sessions map - kept alive in main process so they persist across worker restarts
const mainProcessSessions = new Map<string, { launchedAt: string; url?: string }>();
const sessions = new Map<string, BrowserSession>();
// The session every agent/UI reuses by default so a chat doesn't spawn its own browser
// on every run. Only cleared when that specific session is closed or has died.
let defaultSessionId: string | undefined;
// Worker-local: sessions currently live-streaming via CDP screencast, and the most recent
// frame received for each (so a `screenshot` call can return it instantly instead of paying
// for a brand-new page.screenshot() capture - see resolveScreenshot()).
const activeStreams = new Map<string, { client: import("puppeteer-core").CDPSession; onFrame: (...args: any[]) => void }>();
const lastFrames = new Map<string, { data: string; format: string; width: number; height: number; timestampMs: number }>();

/** A buffered live frame is only useful if it's actually recent - an active stream should
 *  refresh many times per second, so anything older than this is stale (tab backgrounded,
 *  page idle, or the stream silently died) and a real capture is safer. */
const LIVE_FRAME_MAX_AGE_MS = 1500;

function getFreshLiveFrame(sessionId: string): { data: string; format: string; width: number; height: number; timestampMs: number } | undefined {
  const frame = lastFrames.get(sessionId);
  if (!frame) return undefined;
  if (Date.now() - frame.timestampMs > LIVE_FRAME_MAX_AGE_MS) return undefined;
  return frame;
}

/** Stops the CDP screencast for a session, if one is running. Safe to call on a session that
 *  isn't streaming (no-op) - used by action=stream_stop, action=close, and session cleanup. */
async function stopStream(sessionId: string): Promise<boolean> {
  const stream = activeStreams.get(sessionId);
  if (!stream) return false;
  activeStreams.delete(sessionId);
  lastFrames.delete(sessionId);
  try {
    await stream.client.send("Page.stopScreencast");
  } catch {
    // Session/page may already be gone - nothing left to stop.
  }
  try {
    stream.client.off("Page.screencastFrame", stream.onFrame);
  } catch {
    // Ignore - client is being torn down anyway.
  }
  console.info(`[browser] Live stream stopped: ${sessionId}`);
  return true;
}
const pending = new Map<
  string,
  {
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    settled: boolean;
  }
>();

let workerProcess: ChildProcess | null = null;

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

function isWorkerMode(): boolean {
  return process.argv.includes("--browser-worker");
}

function workerRunning(): boolean {
  return Boolean(workerProcess && workerProcess.connected && !workerProcess.killed);
}

function teardownWorker(message: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timeout);
    entry.reject(new Error(message));
    pending.delete(id);
  }
  workerProcess = null;
}

function ensureWorker(): ChildProcess {
  if (workerRunning() && workerProcess) return workerProcess;

  const modulePath = fileURLToPath(import.meta.url);
  const child = fork(modulePath, ["--browser-worker"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  child.on("message", (payload: unknown) => {
    const message = payload as BrowserWorkerMessage;
    if (message?.kind === "frame") {
      browserFrameEvents.emit("frame", message);
      return;
    }
    if (!message?.id) return;
    const entry = pending.get(message.id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timeout);
    pending.delete(message.id);
    entry.resolve(message.result ?? fail("Worker returned no result"));
  });

  child.on("error", (error) => {
    teardownWorker(`Browser worker error: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    teardownWorker(`Browser worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });

  if (child.stderr) {
    child.stderr.on("data", () => {
      // Keep stderr drained to avoid blocked child process buffers.
    });
  }
  if (child.stdout) {
    child.stdout.on("data", () => {
      // Keep stdout drained to avoid blocked child process buffers.
    });
  }

  workerProcess = child;
  return child;
}

async function callWorker(input: Record<string, unknown>): Promise<ToolResult> {
  const worker = ensureWorker();
  const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return await new Promise<ToolResult>((resolve, reject) => {
    // The agent injects `timeoutMs` (= AGENT_TOOL_TIMEOUT_BROWSER_MS, default 120000) and
    // the long-running actions (download/login/pdf) read it too. This outer round-trip
    // guard must honor the SAME budget (+3s grace) or it kills those actions early - it
    // previously only read `input["timeout"]`, capping every browser call at ~33s
    // regardless of the configured browser timeout.
    const workerBudgetMs = Number(input["timeoutMs"] ?? input["timeout"] ?? 30000);
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (entry && !entry.settled) {
        entry.settled = true;
        pending.delete(id);
        reject(new Error("Browser worker timed out"));
      }
    }, workerBudgetMs + 3000);

    pending.set(id, { resolve, reject, timeout, settled: false });

    const request: BrowserWorkerRequest = { id, input };
    worker.send(request, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry || entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timeout);
      pending.delete(id);
      reject(new Error(`Failed to send request to browser worker: ${error.message}`));
    });
  });
}

function getPuppeteer(): Promise<typeof import("puppeteer-core")> {
  return import("puppeteer-core") as Promise<typeof import("puppeteer-core")>;
}

function makeSessionId(): string {
  return `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseViewports(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const width = Number(record["width"] ?? 0);
  const height = Number(record["height"] ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function windowsKnownBrowserPaths(): string[] {
  const roots = [
    process.env["PROGRAMFILES"],
    process.env["PROGRAMFILES(X86)"],
    process.env["LOCALAPPDATA"],
  ].filter((value): value is string => Boolean(value && value.trim()));

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
    candidates.push(join(root, "Chromium", "Application", "chrome.exe"));
  }

  return candidates;
}

function resolveBrowserPath(): string | undefined {
  const candidates = process.platform === "win32"
    ? [
        process.env["PUPPETEER_EXECUTABLE_PATH"],
        process.env["EDGE_BIN"],
        process.env["CHROME_BIN"],
        process.env["BROWSER_PATH"],
      ]
    : [
        process.env["PUPPETEER_EXECUTABLE_PATH"],
        process.env["CHROME_BIN"],
        process.env["EDGE_BIN"],
        process.env["BROWSER_PATH"],
      ];

  const explicit = candidates.filter((value): value is string => Boolean(value && value.trim()));
  for (const candidate of explicit) {
    if (existsSync(candidate)) return candidate;
  }

  if (process.platform === "win32") {
    for (const candidate of windowsKnownBrowserPaths()) {
      if (existsSync(candidate)) return candidate;
    }
  }

  const commands = process.platform === "win32"
    ? ["where msedge", "where msedge.exe", "where chrome", "where chrome.exe"]
    : ["which google-chrome", "which chromium", "which chromium-browser", "which google-chrome-stable"];

  for (const command of commands) {
    try {
      const output = execSync(command, { encoding: "utf8", timeout: 2000 });
      const first = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (first && existsSync(first)) return first;
    } catch {
      // Ignore lookup failures and continue to next candidate.
    }
  }

  return undefined;
}

function browserSelectionLabel(executablePath: string): string {
  const normalized = executablePath.toLowerCase();
  if (normalized.includes("msedge")) return "Microsoft Edge";
  if (normalized.includes("chrome")) return "Google Chrome";
  if (normalized.includes("chromium")) return "Chromium";
  return "browser";
}

async function getSession(sessionId: string): Promise<BrowserSession | undefined> {
  return sessions.get(sessionId);
}

async function createSession(options: {
  headless?: boolean;
  viewport?: { width: number; height: number };
  executablePath?: string;
  userAgent?: string;
  disableImages?: boolean;
  blockResources?: "none" | "tracking" | "ads" | "all";
  hideAutomation?: boolean;
  cookieDetection?: boolean;
  proxyUrl?: string;
}): Promise<{ sessionId: string; targetUrl?: string; browserPath?: string }> {
  const puppeteer = await getPuppeteer();
  const executablePath = options.executablePath ?? resolveBrowserPath();
  if (!executablePath) {
    throw new Error("No local browser executable found. Set PUPPETEER_EXECUTABLE_PATH, CHROME_BIN, EDGE_BIN, or BROWSER_PATH.");
  }

  const browser = await puppeteer.launch({
    headless: options.headless ?? true,
    executablePath,
    defaultViewport: options.viewport ?? { width: 1440, height: 1024 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Anti-bot detection measures
      "--disable-blink-features=AutomationControlled",
      "--disable-web-resources",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-device-discovery-notifications",
      "--disable-hang-monitor",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      ...(options.disableImages ? ["--blink-settings=imagesEnabled=false"] : []),
      ...(options.proxyUrl ? [`--proxy-server=${options.proxyUrl}`] : []),
    ],
  });
  const page = await browser.newPage();

  // Hide automation indicators (configurable)
  if (options.hideAutomation !== false) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });
  }

  // Set user agent (configurable)
  const userAgent = options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  await page.setUserAgent(userAgent);

  // Set up resource blocking if enabled
  if (options.blockResources && options.blockResources !== "none") {
    const { setupResourceBlocking } = await import("./browser-features/cookie-detection.js");
    await setupResourceBlocking(page, options.blockResources);
  }

  // Detect and dismiss cookie banners if enabled
  if (options.cookieDetection) {
    const { detectAndDismissCookieBanners } = await import("./browser-features/cookie-detection.js");
    const result = await detectAndDismissCookieBanners(page);
    if (result.dismissed) {
      console.log("[browser] Cookie banner dismissed automatically");
    }
  }

  const sessionId = makeSessionId();
  const session: BrowserSession = {
    browser,
    page,
    launchedAt: new Date().toISOString(),
    headless: options.headless ?? true,
    pageErrors: [],
    networkErrors: [],
  };
  sessions.set(sessionId, session);

  // Error capture for action=get_page_errors / expect(no_page_errors): console errors,
  // uncaught page errors and failed requests are recorded per session (bounded buffers).
  // Attached to the initial page and to every tab the browser opens afterwards.
  attachPageListeners(session, page);
  browser.on("targetcreated", async (target) => {
    const newPage = await target.page().catch(() => null);
    if (newPage) attachPageListeners(session, newPage);
  });

  // Without this, an external crash/close of the browser process fires an unhandled
  // "disconnected"/"error" event on the Puppeteer EventEmitter, which crashes the whole
  // worker (killing every other session too). Clean up just this session instead.
  browser.on("disconnected", () => {
    console.warn(`[browser] Session '${sessionId}' disconnected (browser crashed or was closed externally)`);
    sessions.delete(sessionId);
    activeStreams.delete(sessionId);
    lastFrames.delete(sessionId);
    if (defaultSessionId === sessionId) defaultSessionId = undefined;
  });

  return { sessionId, browserPath: executablePath, targetUrl: session.targetUrl };
}

/**
 * Reuse the shared default session unless the caller explicitly asks for a brand-new
 * browser (same policy as action="launch"). Factored out of the "launch" case so the
 * macro actions (screenshot_url, verify_page) can launch-or-reuse without duplicating
 * this logic.
 */
async function resolveOrLaunchSession(
  input: Record<string, unknown>
): Promise<{ sessionId: string; session: BrowserSession; reused: boolean; browserPath?: string }> {
  const forceNew = input["newSession"] === true || input["newSession"] === "true";
  const requestedHeadless = input["headless"] === undefined ? true : input["headless"] === true || input["headless"] === "true";

  if (!forceNew && defaultSessionId) {
    const existing = sessions.get(defaultSessionId);
    if (existing) {
      if (existing.headless === requestedHeadless) {
        return { sessionId: defaultSessionId, session: existing, reused: true };
      }
      // Puppeteer fixes headless mode at launch - it cannot be toggled on a running
      // browser. If the caller (or a just-changed BROWSER_HEADLESS_MODE setting) now wants
      // a different mode than this session was actually launched with, reusing it would
      // silently ignore that change forever (until the session happens to die on its own).
      // Close it and launch fresh instead.
      console.info(
        `[browser] Default session '${defaultSessionId}' is headless=${existing.headless} but headless=${requestedHeadless} was requested - relaunching`
      );
      await stopStream(defaultSessionId);
      try {
        await existing.browser.close();
      } catch {
        // Already gone - fine, we're replacing it anyway.
      }
      sessions.delete(defaultSessionId);
      defaultSessionId = undefined;
    } else {
      // Default session died without going through "close" - fall through to relaunch.
      defaultSessionId = undefined;
    }
  }

  const viewport = parseViewports(input["viewport"]);
  const { sessionId, browserPath } = await createSession({
    headless: requestedHeadless,
    viewport,
    executablePath: typeof input["executablePath"] === "string" ? input["executablePath"] : undefined,
    userAgent: typeof input["userAgent"] === "string" ? input["userAgent"] : undefined,
    disableImages: input["disableImages"] === true || input["disableImages"] === "true",
    blockResources: (input["blockResources"] as "none" | "tracking" | "ads" | "all") || "none",
    hideAutomation: input["hideAutomation"] !== false && input["hideAutomation"] !== "false",
    cookieDetection: input["cookieDetection"] === true || input["cookieDetection"] === "true",
    proxyUrl: typeof input["proxyUrl"] === "string" ? input["proxyUrl"] : undefined,
  });
  defaultSessionId = sessionId;
  const session = await getSession(sessionId);
  if (!session) throw new Error("Failed to create browser session");
  return { sessionId, session, reused: false, browserPath };
}

async function ensureSession(input: Record<string, unknown>): Promise<{ sessionId: string; session: BrowserSession }> {
  const requestedSessionId = String(input["sessionId"] ?? "").trim();

  // No sessionId given at all (common for a fresh agent run that doesn't know one yet) -
  // fall back to the shared default session instead of failing outright.
  if (!requestedSessionId && defaultSessionId) {
    const defaultSession = sessions.get(defaultSessionId);
    if (defaultSession) {
      return { sessionId: defaultSessionId, session: defaultSession };
    }
  }

  if (!requestedSessionId) throw new Error("sessionId is required");

  const session = await getSession(requestedSessionId);
  if (session) {
    return { sessionId: requestedSessionId, session };
  }

  // Fallback: If requested session not found, use the most recent/first active session
  const availableIds = Array.from(sessions.keys());
  console.warn(`[browser] Requested session '${requestedSessionId}' not found. Available sessions: ${availableIds.join(", ")}`);

  if (availableIds.length > 0) {
    const fallbackSessionId = availableIds[0] as string;
    const fallbackSession = sessions.get(fallbackSessionId);
    if (fallbackSession) {
      console.info(`[browser] Using fallback session: ${fallbackSessionId}`);
      return { sessionId: fallbackSessionId, session: fallbackSession };
    }
  }

  throw new Error(`Browser session '${requestedSessionId}' not found (no fallback sessions available)`);
}

// ---------------------------------------------------------------------------
// Interaction & testing helpers
// ---------------------------------------------------------------------------

/** Pages we already wired error-capture listeners onto (WeakSet so GC can drop pages). */
const wiredPages = new WeakSet<object>();

/**
 * Captures console errors, uncaught page errors and failed network requests into the
 * session (bounded buffers, readable via action=get_page_errors). Attached to the initial
 * page, to every tab the browser opens afterwards, and to pages switched to via switch_tab.
 */
function attachPageListeners(session: BrowserSession, page: import("puppeteer-core").Page): void {
  if (wiredPages.has(page)) return;
  wiredPages.add(page);
  const push = <T,>(arr: T[], item: T) => {
    arr.push(item);
    if (arr.length > 200) arr.splice(0, arr.length - 200);
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      push(session.pageErrors, {
        type: msg.type(),
        text: msg.text().slice(0, 300),
        url: (msg.location()?.url ?? page.url()).slice(0, 300),
        timestamp: new Date().toISOString(),
      });
    }
  });
  page.on("pageerror", (err) => {
    push(session.pageErrors, {
      type: "pageerror",
      text: String(err instanceof Error ? err.message : err).slice(0, 300),
      url: page.url().slice(0, 300),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (req) => {
    push(session.networkErrors, {
      url: req.url().slice(0, 400),
      method: req.method(),
      error: (req.failure()?.errorText ?? "failed").slice(0, 200),
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Runs inside the page (browser context). Collects visible interactive elements with an
 * accessible-ish name and a deterministic CSS selector. With `match` set, returns the
 * selector of the first element whose role/name matches, or null. Fully self-contained:
 * no outer-scope references, so it can be passed straight to page.evaluate.
 */
function collectInteractiveElements(opts: {
  maxNodes: number;
  match?: { text?: string; role?: string; exact?: boolean };
}): unknown {
  const buildSelector = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts: string[] = [];
    let current: Element | null = el;
    // Walk up the tree collecting a deterministic path (html > body > main > button:nth-of-type(2)).
    while (current && current.nodeType === 1 && current !== document.documentElement && current.parentElement) {
      const parentEl: Element = current.parentElement;
      let part = current.tagName.toLowerCase();
      // Same-tag sibling index via an indexed loop (a closure over the loop variable trips
      // TS's circular-inference detection in this function).
      let sameTagCount = 0;
      let sameTagIndex = 0;
      for (let i = 0; i < parentEl.children.length; i += 1) {
        const child = parentEl.children[i] as Element;
        if (child.tagName === current.tagName) {
          sameTagCount += 1;
          if (child === current) sameTagIndex = sameTagCount;
        }
      }
      if (sameTagCount > 1) part += `:nth-of-type(${sameTagIndex})`;
      parts.unshift(part);
      current = parentEl;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return true;
  };
  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    return "";
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const label = el.labels?.[0]?.textContent;
      if (label) return label.replace(/\s+/g, " ").trim();
      if (el.placeholder) return el.placeholder;
    }
    if (el instanceof HTMLSelectElement) {
      const label = el.labels?.[0]?.textContent;
      if (label) return label.replace(/\s+/g, " ").trim();
    }
    if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.tagName.toLowerCase() === "summary") {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 120);
    }
    const alt = (el as HTMLImageElement).alt;
    if (alt) return alt;
    const title = el.getAttribute("title");
    if (title) return title;
    const input = el as HTMLInputElement;
    if (el instanceof HTMLInputElement && input.value && (input.type === "button" || input.type === "submit")) {
      return input.value.slice(0, 120);
    }
    return "";
  };
  const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
  const match = opts.match
    ? { text: normalize(opts.match.text ?? ""), role: (opts.match.role ?? "").toLowerCase(), exact: opts.match.exact === true }
    : null;
  const els = Array.from(
    document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [role], [tabindex], [contenteditable], [onclick]"
    )
  );
  const out: Array<Record<string, unknown>> = [];
  for (const el of els) {
    if (!isVisible(el)) continue;
    const role = (el.getAttribute("role") || implicitRole(el)).toLowerCase();
    const name = nameOf(el);
    if (!name && !role) continue;
    if (match) {
      const nameMatches = match.text ? (match.exact ? normalize(name) === match.text : normalize(name).includes(match.text)) : true;
      const roleMatches = match.role ? role === match.role : true;
      if (nameMatches && roleMatches) return buildSelector(el);
      continue;
    }
    const record: Record<string, unknown> = { tag: el.tagName.toLowerCase(), role: role || "unknown" };
    if (name) record.name = name.slice(0, 120);
    record.selector = buildSelector(el);
    if (el instanceof HTMLInputElement) {
      if (el.value && (el.type === "button" || el.type === "submit")) record.value = el.value.slice(0, 60);
      if (el.disabled) record.disabled = true;
      if (el.checked !== undefined) record.checked = el.checked;
      if (el.type === "checkbox" || el.type === "radio") record.inputType = el.type;
    } else if (el instanceof HTMLSelectElement) {
      if (el.disabled) record.disabled = true;
    }
    if (el instanceof HTMLAnchorElement && el.href) record.href = el.href.slice(0, 200);
    if (el.getAttribute("aria-expanded")) record.expanded = el.getAttribute("aria-expanded");
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") record.disabled = true;
    out.push(record);
    if (out.length >= opts.maxNodes) break;
  }
  return match ? null : out;
}

/**
 * Resolves a target for click/type/hover/etc.: a CSS `selector` wins, otherwise the element
 * is found by accessible name (`text` for click/hover, `target` for type/select/upload)
 * optionally constrained by `role`. Returns the resolved selector (a deterministic CSS
 * path generated in-page) so every action can use the same waitForSelector+click flow.
 */
async function resolveSelector(
  ctx: import("puppeteer-core").Page | import("puppeteer-core").Frame,
  input: Record<string, unknown>,
  opts: { nameKey?: "text" | "target" } = {}
): Promise<string> {
  const selector = String(input["selector"] ?? "").trim();
  if (selector) return selector;
  // `type`/`select`/`upload` carry the CONTENT in `text`, so their target name lives in
  // `target` (nameKey="target"); click/hover/expect use `text` as the target name.
  const nameKey = opts.nameKey ?? "text";
  const name = String(input[nameKey] ?? input["target"] ?? "").trim();
  const role = String(input["role"] ?? "").trim();
  const exact = input["exact"] === true || input["exact"] === "true";
  if (!name && !role) {
    throw new Error("selector is required (or pass text/target + optional role to find the element by its accessible name)");
  }
  const found = await ctx.evaluate(collectInteractiveElements, {
    maxNodes: 300,
    match: { text: name, role: role || undefined, exact },
  });
  if (!found) {
    throw new Error(`Element not found ${role ? `(role "${role}")` : ""} ${name ? `with name "${name}"` : ""} - use action=snapshot to see what's on the page`);
  }
  return String(found);
}

/**
 * Optional `frame` param: a CSS selector for an <iframe>. When given, actions run inside
 * that frame instead of the top-level document (same-origin frames; cross-origin iframes
 * are reported as an error with a hint, because Puppeteer can't reach their DOM).
 */
async function targetContext(
  session: BrowserSession,
  input: Record<string, unknown>
): Promise<{ ctx: import("puppeteer-core").Page | import("puppeteer-core").Frame; label: string }> {
  const frameSelector = String(input["frame"] ?? "").trim();
  if (!frameSelector) return { ctx: session.page, label: "page" };
  const handle = await session.page.$(frameSelector);
  if (!handle) throw new Error(`iframe "${frameSelector}" not found on the page`);
  const frame = await handle.contentFrame();
  if (!frame) {
    throw new Error(`iframe "${frameSelector}" has no accessible content frame (cross-origin or not yet loaded)`);
  }
  return { ctx: frame, label: frameSelector };
}

export const browserTool: ToolExecutor = {
  name: "browser",
  description:
    "Detect browser availability and control browser sessions using Puppeteer. HOW TO USE: " +
    "launch (optionally with url) or goto, then snapshot to list interactive elements " +
    "(role/name/selector - prefer this over guessing CSS selectors), then interact " +
    "text-based: click {text}, type {target, text}, select {option}, hover {text}; verify " +
    "with expect (text_visible, no_page_errors, ...) and get_page_errors. Example: " +
    "click {text:'Speichern'} then expect {condition:'text_visible', text:'Gespeichert'}.",
  definition: {
    name: "browser",
    description:
      "Browser automation and detection via Puppeteer. snapshot lists interactive elements " +
      "(role/name/selector); click/hover by text, type by target, select by option label; " +
      "verify with expect; check get_page_errors. Example: snapshot -> click {text:'Speichern'} " +
      "-> expect {condition:'text_visible', text:'Gespeichert'} -> get_page_errors.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Which browser operation to run. Session: detect, launch, list_sessions, " +
            "list_pages, close. Navigation: goto, screenshot_url. Reading: screenshot " +
            "(vision), get_content, snapshot, evaluate, verify_page. Interaction: click/hover " +
            "(selector OR text+role), type (selector OR target; text=content), press, wait, " +
            "form_fill, login, select (value/option label), upload (filePaths), drag_drop, " +
            "switch_tab. Testing: expect (element_visible, element_hidden, text_visible, " +
            "text_absent, url_contains, title_contains, no_page_errors), get_page_errors. " +
            "Cookies: cookies_get/set/clear. Extras: pdf, download, stream_start/stop. Use " +
            "snapshot for real element names instead of guessing CSS selectors.",
          enum: [
            "detect",
            "launch",
            "list_pages",
            "list_sessions",
            "goto",
            "click",
            "type",
            "press",
            "wait",
            "screenshot",
            "get_content",
            "evaluate",
            "cookies_get",
            "cookies_set",
            "cookies_clear",
            "form_fill",
            "login",
            "pdf",
            "download",
            "close",
            "screenshot_url",
            "verify_page",
            "stream_start",
            "stream_stop",
            "snapshot",
            "get_page_errors",
            "expect",
            "hover",
            "drag_drop",
            "select",
            "upload",
            "switch_tab",
          ],
        },
        sessionId: { type: "string", description: "Browser session id" },
        newSession: { type: "boolean", description: "For action=launch: force a brand-new browser instead of reusing the shared default session", default: false },
        url: { type: "string", description: "URL to open or navigate to" },
        selector: { type: "string", description: "CSS selector for click/type/wait/hover/select/upload. Example: '#submit-btn' or 'main button:nth-of-type(2)'" },
        // Text-based targeting: click/hover accept `text` (accessible name), type/select/
        // upload accept `target` (because `text` is the content to type). `role` narrows the
        // match (button, link, textbox, combobox, checkbox, ...). See action=snapshot.
        text: { type: "string", description: "Text to type (type) OR the accessible name of the element to target (click/hover/expect text_visible). Example: text: 'Speichern'" },
        target: { type: "string", description: "Accessible name of the element to target for type/select/upload (alternative to selector). Example: target: 'Benutzername'" },
        role: { type: "string", description: "ARIA role to narrow text/target-based lookup, e.g. button, link, textbox, combobox, checkbox. Example: role: 'button', text: 'Anmelden'" },
        exact: { type: "boolean", description: "Match the accessible name exactly (default: substring match)" },
        frame: { type: "string", description: "Optional CSS selector of an <iframe> to run the action inside (same-origin frames only)" },
        key: { type: "string", description: "Keyboard key or shortcut" },
        timeout: { type: "number", description: "Timeout in ms", default: 10000 },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"] },
        headless: { type: "boolean", description: "Launch browser in headless mode" },
        viewport: { type: "object", description: "Viewport size", properties: { width: { type: "number" }, height: { type: "number" } } },
        executablePath: { type: "string", description: "Optional browser executable path" },
        proxyUrl: { type: "string", description: "Optional proxy server for action=launch, e.g. http://proxy:8080" },
        filePath: { type: "string", description: "Screenshot file path" },
        screenshotFormat: { type: "string", enum: ["jpeg", "png", "webp"], description: "Screenshot image format (jpeg is the safest default for local vision models)", default: "jpeg" },
        screenshotQuality: { type: "number", description: "Screenshot compression quality 1-100 (ignored for png)", default: 85 },
        script: { type: "string", description: "JavaScript executed in page context" },
        count: { type: "number", description: "Limit for list_pages" },
        cookies: { type: "array", description: "Cookie definitions for cookies_set" },
        cookieNames: { type: "array", description: "Cookie names to clear. Empty clears all cookies for current URL." },
        fields: { type: "object", description: "Map of selector to value for form_fill." },
        clearFirst: { type: "boolean", description: "Clear fields before typing in form_fill/login", default: true },
        username: { type: "string", description: "Username for login action" },
        password: { type: "string", description: "Password for login action" },
        usernameSelector: { type: "string", description: "Username input selector for login" },
        passwordSelector: { type: "string", description: "Password input selector for login" },
        submitSelector: { type: "string", description: "Submit button selector for login" },
        waitForNavigation: { type: "boolean", description: "Wait for navigation after login submit", default: true },
        format: { type: "string", description: "PDF page format (e.g. A4, Letter)", default: "A4" },
        landscape: { type: "boolean", description: "PDF landscape mode", default: false },
        printBackground: { type: "boolean", description: "Include background graphics in PDF", default: true },
        saveDir: { type: "string", description: "Directory for downloaded file" },
        timeoutMs: { type: "number", description: "Timeout in ms for download/login/navigation waits" },
        waitMs: { type: "number", description: "For action=screenshot_url without a selector: fixed delay (ms) after navigation before capturing, e.g. to let animations settle", default: 0 },
        close: { type: "boolean", description: "For action=screenshot_url: close the session immediately after capturing (use when you only need one snapshot, not further interaction)", default: false },
        extractText: { type: "boolean", description: "For action=verify_page: include up to 5000 chars of the page's visible text in the result", default: true },
        preferLive: { type: "boolean", description: "For action=screenshot: if this session is live-streaming (see stream_start) and has a frame from the last 1.5s, return it instantly instead of capturing a fresh full-page screenshot. Faster, but viewport-only (not full scroll height).", default: false },
        maxWidth: { type: "number", description: "For action=stream_start: max frame width in px", default: 960 },
        maxHeight: { type: "number", description: "For action=stream_start: max frame height in px", default: 720 },
        // snapshot
        maxNodes: { type: "number", description: "For action=snapshot: max interactive elements to return", default: 120 },
        // get_page_errors
        clear: { type: "boolean", description: "For action=get_page_errors: clear the captured errors after reading", default: false },
        // expect
        condition: { type: "string", enum: ["element_visible", "element_hidden", "text_visible", "text_absent", "url_contains", "title_contains", "no_page_errors"], description: "Assertion to check (polls until it passes or the timeout expires). Examples: expect {condition:'text_visible', text:'Gespeichert'}; expect {condition:'no_page_errors'}" },
        urlPart: { type: "string", description: "For action=expect condition=url_contains: substring expected in the page URL" },
        // drag_drop
        source: { type: "string", description: "For action=drag_drop: CSS selector of the draggable element" },
        sourceText: { type: "string", description: "For action=drag_drop: accessible name of the draggable element (alternative to source)" },
        sourceRole: { type: "string", description: "For action=drag_drop: role narrowing sourceText lookup" },
        html5: { type: "boolean", description: "For action=drag_drop: dispatch HTML5 DragEvents instead of mouse-based dragging", default: false },
        // select / upload
        value: { type: "string", description: "For action=select: option value to choose" },
        option: { type: "string", description: "For action=select: visible label of the option to choose (alternative to value)" },
        filePaths: { type: "array", items: { type: "string" }, description: "For action=upload: file path(s) to upload (or a comma-separated string)" },
        // switch_tab
        index: { type: "number", description: "For action=switch_tab: 0-based tab index to switch to" },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input["action"] ?? "").trim().toLowerCase() as BrowserAction;
    try {
      if (action === "detect") {
        const browserPath = resolveBrowserPath();
        return ok({
          puppeteerInstalled: true,
          browserAvailable: Boolean(browserPath),
          browserPath: browserPath ?? null,
          workerIsolated: true,
          workerRunning: workerRunning(),
        });
      }

      const result = await callWorker(input);

      // Track sessions in main process
      if (action === "launch" && result.success) {
        const data = result.data as Record<string, unknown> | undefined;
        const sessionId = data?.sessionId as string | undefined;
        if (sessionId) {
          mainProcessSessions.set(sessionId, {
            launchedAt: new Date().toISOString(),
            url: data?.currentUrl as string | undefined,
          });
          console.info(`[browser-main] Tracked session: ${sessionId}`);
        }
      }

      return result;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Worker-side dispatch. Exported so tests can exercise the full action logic in-process
 * (vitest can't fork() the TS source module the way the production worker does).
 */
export async function executeInWorker(input: Record<string, unknown>): Promise<ToolResult> {
  const action = String(input["action"] ?? "").trim().toLowerCase() as BrowserAction;
  try {
    switch (action) {
      case "detect": {
        const browserPath = resolveBrowserPath();
        return ok({
          puppeteerInstalled: true,
          browserAvailable: Boolean(browserPath),
          browserPath: browserPath ?? null,
          sessions: sessions.size,
        });
      }
      case "launch": {
        // Reuse the shared default session unless the caller explicitly asks for a
        // brand-new browser - this is what stops every agent run from spawning its own
        // browser instance instead of collaborating on one.
        const { sessionId, session, reused, browserPath } = await resolveOrLaunchSession(input);
        if (!reused && browserPath) {
          console.info(`[browser] launching ${browserSelectionLabel(browserPath)} at ${browserPath}`);
        }
        console.info(`[browser] Session ${reused ? "reused" : "created"}: ${sessionId}`);
        // launch accepts `url` directly - collapses the documented launch-then-goto
        // two-step into one call, which also means a caller never needs to guess/repeat
        // a sessionId for the navigation: it's the same session, same call.
        if (input["url"]) {
          await session.page.goto(String(input["url"]), { waitUntil: "domcontentloaded" });
          session.targetUrl = session.page.url();
        }
        const result = {
          sessionId,
          reused,
          browserPath: browserPath ?? null,
          browserName: browserPath ? browserSelectionLabel(browserPath) : null,
          currentUrl: session.page.url(),
          launchedAt: session.launchedAt,
        };
        console.info(`[browser] Returning launch result:`, JSON.stringify(result));
        return ok(result);
      }
      case "list_pages": {
        const { sessionId, session } = await ensureSession(input);
        const pages = await session.browser.pages();
        const count = Math.max(1, Number(input["count"] ?? 20));
        const result = await Promise.all(
          pages.slice(0, count).map(async (page, index) => ({
            index,
            url: page.url(),
            title: await page.title().catch(() => ""),
          }))
        );
        return ok({ sessionId, pages: result });
      }
      case "list_sessions": {
        const list = await Promise.all(
          Array.from(sessions.entries()).map(async ([sessionId, session]) => ({
            sessionId,
            url: session.page.url(),
            title: await session.page.title().catch(() => ""),
            launchedAt: session.launchedAt,
            isDefault: sessionId === defaultSessionId,
          }))
        );
        return ok({ sessions: list, defaultSessionId: defaultSessionId ?? null });
      }
      case "get_content": {
        const { sessionId, session } = await ensureSession(input);
        const html = await session.page.content();
        return ok({ sessionId, html, length: html.length, url: session.page.url() });
      }
      case "goto": {
        const { sessionId, session } = await ensureSession(input);
        const url = String(input["url"] ?? "").trim();
        if (!url) return fail("url is required");
        const timeout = Number(input["timeout"] ?? 10000);
        const waitUntil = String(input["waitUntil"] ?? "domcontentloaded") as "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
        await session.page.goto(url, { waitUntil, timeout });
        session.targetUrl = session.page.url();
        return ok({ sessionId, url: session.page.url(), title: await session.page.title() });
      }
      case "click": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const selector = await resolveSelector(ctx, input);
        const timeout = Number(input["timeout"] ?? 10000);
        await ctx.waitForSelector(selector, { timeout, visible: true });
        await ctx.click(selector);
        return ok({ sessionId, clicked: selector, url: session.page.url() });
      }
      case "type": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const text = String(input["text"] ?? "");
        const timeout = Number(input["timeout"] ?? 10000);
        // type uses `target`/`role` for text-based targeting because `text` is the content
        // to type (mirroring the existing no-selector flow: type into the focused element).
        const selectorRaw = String(input["selector"] ?? "").trim();
        const targetName = String(input["target"] ?? "").trim();
        const role = String(input["role"] ?? "").trim();
        if (!selectorRaw && !targetName && !role) {
          // No selector given: type into the currently-focused element. Models routinely
          // call `type` with just `text` right after a click/focus (mirroring Puppeteer's
          // page.keyboard.type semantics). Falling back here - instead of failing with
          // "selector is required" - makes that natural flow work. `text` is still required
          // because typing nothing is always a mistake.
          if (!text) return fail("type requires 'text' (optionally with 'selector' or 'target')");
          await session.page.keyboard.type(text);
          return ok({ sessionId, typed: text.length, selector: null, viaFocusedElement: true });
        }
        const selector = await resolveSelector(ctx, input, { nameKey: "target" });
        await ctx.waitForSelector(selector, { visible: true, timeout });
        await ctx.click(selector);
        await ctx.type(selector, text);
        return ok({ sessionId, typed: text.length, selector });
      }
      case "hover": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const selector = await resolveSelector(ctx, input);
        const timeout = Number(input["timeout"] ?? 10000);
        await ctx.waitForSelector(selector, { timeout, visible: true });
        await ctx.hover(selector);
        return ok({ sessionId, hovered: selector, url: session.page.url() });
      }
      case "snapshot": {
        const { sessionId, session } = await ensureSession(input);
        const maxNodes = Math.max(1, Math.min(200, Number(input["maxNodes"] ?? 120) || 120));
        const elements = (await session.page.evaluate(collectInteractiveElements, { maxNodes })) as Array<Record<string, unknown>>;
        return ok({
          sessionId,
          url: session.page.url(),
          title: await session.page.title().catch(() => ""),
          count: elements.length,
          // Use the elements directly (no stringification) - ToolResult passes objects through.
          elements,
        });
      }
      case "get_page_errors": {
        const { sessionId, session } = await ensureSession(input);
        const clear = input["clear"] === true || input["clear"] === "true";
        const pageErrors = session.pageErrors.slice();
        const networkErrors = session.networkErrors.slice();
        if (clear) {
          session.pageErrors = [];
          session.networkErrors = [];
        }
        return ok({
          sessionId,
          pageErrors,
          networkErrors,
          pageErrorCount: pageErrors.length,
          networkErrorCount: networkErrors.length,
          url: session.page.url(),
        });
      }
      case "expect": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const condition = String(input["condition"] ?? "").trim();
        const timeout = Math.max(200, Number(input["timeout"] ?? 5000) || 5000);
        const deadline = Date.now() + timeout;
        const url = session.page.url();
        const text = String(input["text"] ?? "").trim();
        const urlPart = String(input["urlPart"] ?? "").trim();
        const check = async (): Promise<{ pass: boolean; info?: string }> => {
          switch (condition) {
            case "element_visible": {
              try {
                const sel = await resolveSelector(ctx, input);
                await ctx.waitForSelector(sel, { timeout: 400, visible: true });
                return { pass: true };
              } catch {
                return { pass: false, info: `element not visible (selector/text/role: ${String(input["selector"] ?? input["text"] ?? input["target"] ?? "")})` };
              }
            }
            case "element_hidden": {
              // Not found by name at all counts as hidden/absent (e.g. a loading spinner that
              // should be gone, or an element that must not exist).
              let sel: string;
              try {
                sel = await resolveSelector(ctx, input);
              } catch {
                return { pass: true };
              }
              try {
                await ctx.waitForSelector(sel, { timeout: 400, hidden: true });
                return { pass: true };
              } catch {
                return { pass: false, info: `element still visible (selector/text/role: ${String(input["selector"] ?? input["text"] ?? input["target"] ?? "")})` };
              }
            }
            case "text_visible":
            case "text_absent": {
              if (!text) return { pass: false, info: "text is required for text_visible/text_absent" };
              const body = (await ctx.evaluate(() => document.body?.innerText ?? "")) as string;
              const found = body.includes(text);
              const pass = condition === "text_visible" ? found : !found;
              return { pass, info: pass ? undefined : `text "${text.slice(0, 80)}" ${condition === "text_visible" ? "not found" : "still present"} on page` };
            }
            case "url_contains": {
              const part = urlPart || text;
              if (!part) return { pass: false, info: "urlPart (or text) is required for url_contains" };
              return { pass: session.page.url().includes(part) };
            }
            case "title_contains": {
              if (!text) return { pass: false, info: "text is required for title_contains" };
              const title = await session.page.title().catch(() => "");
              return { pass: title.includes(text) };
            }
            case "no_page_errors": {
              const errs = [...session.pageErrors, ...session.networkErrors];
              return errs.length === 0
                ? { pass: true }
                : { pass: false, info: `${errs.length} page/network error(s) captured; first: ${(errs[0] as { text?: string; error?: string }).text ?? (errs[0] as { error?: string }).error ?? JSON.stringify(errs[0]).slice(0, 120)}` };
            }
            default:
              return { pass: false, info: `unknown condition "${condition}" (valid: element_visible, element_hidden, text_visible, text_absent, url_contains, title_contains, no_page_errors)` };
          }
        };
        let lastInfo = "";
        while (Date.now() < deadline) {
          const r = await check();
          if (r.pass) return ok({ sessionId, condition, passed: true, timeout, url });
          lastInfo = r.info ?? "";
          if (condition === "no_page_errors" || condition === "text_absent") break; // negative checks don't improve by waiting
          await new Promise((res) => setTimeout(res, 200));
        }
        return ok({ sessionId, condition, passed: false, reason: lastInfo || `condition "${condition}" not met within ${timeout}ms`, timeout, url });
      }
      case "drag_drop": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const source = await resolveSelector(ctx, {
          selector: input["source"],
          text: input["sourceText"],
          role: input["sourceRole"],
          exact: input["exact"],
        });
        const target = String(input["target"] ?? "").trim();
        if (!target) return fail("drag_drop: target (CSS selector of the drop zone) is required");
        if (input["html5"] === true || input["html5"] === "true") {
          await ctx.evaluate(
            ({ src, dst }) => {
              const s = document.querySelector(src) as HTMLElement | null;
              const t = document.querySelector(dst) as HTMLElement | null;
              if (!s || !t) throw new Error("drag_drop: source or target not found");
              const dt = new DataTransfer();
              s.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
              t.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
              t.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
              s.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
            },
            { src: source, dst: target }
          );
          return ok({ sessionId, dragged: source, droppedOn: target, mode: "html5" });
        }
        // Mouse-based drag (HTML5 dnd handlers that listen on dragstart often need html5:true).
        const srcEl = await ctx.$(source);
        const dstEl = await ctx.$(target);
        if (!srcEl || !dstEl) return fail("drag_drop: source or target not found");
        const sb = await srcEl.boundingBox();
        const db = await dstEl.boundingBox();
        if (!sb || !db) return fail("drag_drop: source/target has no bounding box (hidden?)");
        await session.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await session.page.mouse.down();
        await session.page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 12 });
        await session.page.mouse.up();
        return ok({ sessionId, dragged: source, droppedOn: target, mode: "mouse" });
      }
      case "select": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const selector = await resolveSelector(ctx, input, { nameKey: "target" });
        const timeout = Number(input["timeout"] ?? 10000);
        await ctx.waitForSelector(selector, { timeout, visible: true });
        const value = input["value"] !== undefined && input["value"] !== null && String(input["value"]).trim() !== "" ? String(input["value"]) : undefined;
        const option = String(input["option"] ?? "").trim();
        let selected: string[];
        if (option) {
          // Select by the option's visible label instead of its value attribute.
          const val = (await ctx.evaluate(
            ({ sel, label }) => {
              const el = document.querySelector(sel) as HTMLSelectElement | null;
              if (!el) return null;
              const opt = Array.from(el.options).find((o) => (o.textContent || "").trim() === label || (o.textContent || "").trim().includes(label));
              return opt ? opt.value : null;
            },
            { sel: selector, label: option }
          )) as string | null;
          if (val === null) return fail(`select: option "${option}" not found in ${selector} (use action=snapshot to list options)`);
          selected = await ctx.select(selector, val);
        } else if (value !== undefined) {
          selected = await ctx.select(selector, value);
        } else {
          return fail("select: 'value' or 'option' (visible label) is required");
        }
        return ok({ sessionId, selector, selected, url: session.page.url() });
      }
      case "upload": {
        const { sessionId, session } = await ensureSession(input);
        const { ctx } = await targetContext(session, input);
        const selector = await resolveSelector(ctx, input, { nameKey: "target" });
        const paths = Array.isArray(input["filePaths"])
          ? input["filePaths"].map(String).filter(Boolean)
          : String(input["filePaths"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (paths.length === 0) return fail("upload: filePaths (string or array) is required");
        await ctx.waitForSelector(selector, { timeout: Number(input["timeout"] ?? 10000), visible: true });
        const el = await ctx.$(selector);
        if (!el) return fail(`upload: element not found: ${selector}`);
        await (el as import("puppeteer-core").ElementHandle<HTMLInputElement>).uploadFile(...paths);
        return ok({ sessionId, selector, files: paths });
      }
      case "switch_tab": {
        const { sessionId, session } = await ensureSession(input);
        const pages = await session.browser.pages();
        let target: import("puppeteer-core").Page | undefined;
        const index = Number(input["index"]);
        if (Number.isInteger(index) && index >= 0 && index < pages.length) target = pages[index]!;
        const urlPart = String(input["urlPart"] ?? "").trim();
        if (!target && urlPart) target = pages.find((p) => p.url().includes(urlPart));
        if (!target) {
          const open = (await Promise.all(
            pages.map(async (p) => `${p.url()}${await p.title().catch(() => "") ? ` (${await p.title().catch(() => "")})` : ""}`)
          )).join(", ");
          return fail(`switch_tab: no tab matches index ${String(input["index"] ?? "")} or urlPart "${urlPart}". Open tabs: ${open}`);
        }
        await target.bringToFront();
        session.page = target;
        attachPageListeners(session, target);
        return ok({ sessionId, index: pages.indexOf(target), url: target.url(), title: await target.title().catch(() => "") });
      }
      case "press": {
        const { sessionId, session } = await ensureSession(input);
        const key = String(input["key"] ?? "").trim();
        if (!key) return fail("key is required");
        await session.page.keyboard.press(key as import("puppeteer-core").KeyInput);
        return ok({ sessionId, pressed: key });
      }
      case "wait": {
        const { sessionId, session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        const timeout = Number(input["timeout"] ?? 10000);
        if (selector) {
          await session.page.waitForSelector(selector, { timeout, visible: true });
          return ok({ sessionId, waitedFor: selector });
        }
        await new Promise((resolve) => setTimeout(resolve, timeout));
        return ok({ sessionId, waitedMs: timeout });
      }
      case "screenshot": {
        const { sessionId, session } = await ensureSession(input);

        // preferLive: if this session is live-streaming (action=stream_start) and has a
        // recent frame buffered, return that instantly instead of paying for a fresh
        // page.screenshot() capture. Opt-in (default false) because a screencast frame is
        // the VIEWPORT as currently rendered, not a fullPage capture - existing callers that
        // expect the full scrollable page keep getting exactly that unless they ask for speed
        // over completeness.
        if (input["preferLive"] === true || input["preferLive"] === "true") {
          const live = getFreshLiveFrame(sessionId);
          if (live) {
            return ok({
              sessionId,
              savedTo: null,
              bytes: Buffer.byteLength(live.data, "base64"),
              url: session.page.url(),
              screenshot: live.data,
              live: true,
              metadata: {
                format: live.format,
                width: live.width,
                height: live.height,
                timestamp: new Date(live.timestampMs).toISOString(),
                sizeKb: Math.round(Buffer.byteLength(live.data, "base64") / 1024),
              },
            });
          }
        }

        const filePath = String(input["filePath"] ?? "").trim();
        const path = filePath || undefined;
        // Default to jpeg: many local vision model backends (llama.cpp/GGUF loaders via
        // stb_image, used by most self-hosted Qwen-VL/Llava setups) can't decode webp at
        // all, which is why screenshots were "invisible" to those models. jpeg/png are
        // universally supported; webp/png remain available via BROWSER_SCREENSHOT_FORMAT
        // for setups that don't feed screenshots to a local vision model.
        const format = (String(input["screenshotFormat"] ?? "jpeg").trim().toLowerCase() || "jpeg") as "jpeg" | "png" | "webp";
        const quality = format === "png" ? undefined : Math.max(1, Math.min(100, Number(input["screenshotQuality"] ?? 85)));
        const buffer = await session.page.screenshot({
          path: path as string | undefined,
          fullPage: true,
          type: format,
          ...(quality !== undefined ? { quality } : {}),
        });

        // Get viewport dimensions
        const viewport = session.page.viewport() || { width: 1440, height: 1024 };

        return ok({
          sessionId,
          savedTo: path ?? null,
          bytes: buffer.byteLength,
          url: session.page.url(),
          // Base64 so it survives the fork's IPC (JSON) transport intact - the caller is
          // responsible for keeping this out of the LLM-facing tool result (it's for
          // rendering the preview to the user, not for the model to read as text).
          screenshot: Buffer.from(buffer).toString("base64"),
          live: false,
          // Metadata for screenshot tracking
          metadata: {
            format,
            width: viewport.width,
            height: viewport.height,
            timestamp: new Date().toISOString(),
            sizeKb: Math.round(buffer.byteLength / 1024),
          },
        });
      }
      case "stream_start": {
        // Live preview: starts a CDP screencast for this session. Every rendered frame is
        // pushed to the main process (browserFrameEvents, forwarded to the UI over socket.io)
        // AND buffered here so action=screenshot with preferLive:true can return it instantly.
        const { sessionId, session } = await ensureSession(input);
        const existing = activeStreams.get(sessionId);
        if (existing) return ok({ sessionId, streaming: true, alreadyStreaming: true });

        const client = await session.page.target().createCDPSession();
        const format = (String(input["screenshotFormat"] ?? "jpeg").trim().toLowerCase() === "png" ? "png" : "jpeg") as "jpeg" | "png";
        const quality = format === "png" ? undefined : Math.max(1, Math.min(100, Number(input["screenshotQuality"] ?? 60)));
        const maxWidth = Math.max(1, Number(input["maxWidth"] ?? 960));
        const maxHeight = Math.max(1, Number(input["maxHeight"] ?? 720));

        const onFrame = (event: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
          lastFrames.set(sessionId, {
            data: event.data,
            format,
            width: event.metadata?.deviceWidth ?? maxWidth,
            height: event.metadata?.deviceHeight ?? maxHeight,
            timestampMs: Date.now(),
          });
          if (typeof process.send === "function") {
            process.send({
              kind: "frame",
              sessionId,
              data: event.data,
              format,
              timestamp: new Date().toISOString(),
            } satisfies BrowserWorkerFrame);
          }
          // CDP pauses the screencast after each frame until acknowledged - without this
          // the stream sends exactly one frame and then stalls forever.
          client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        };
        client.on("Page.screencastFrame", onFrame as (...args: unknown[]) => void);

        await client.send("Page.startScreencast", {
          format,
          ...(quality !== undefined ? { quality } : {}),
          maxWidth,
          maxHeight,
        });

        activeStreams.set(sessionId, { client, onFrame: onFrame as (...args: unknown[]) => void });
        console.info(`[browser] Live stream started: ${sessionId}`);
        return ok({ sessionId, streaming: true, format, maxWidth, maxHeight });
      }
      case "stream_stop": {
        const { sessionId } = await ensureSession(input);
        const stopped = await stopStream(sessionId);
        return ok({ sessionId, streaming: false, wasStreaming: stopped });
      }
      case "screenshot_url": {
        // Macro: launch/reuse -> goto -> optional wait -> screenshot -> optional close, in
        // ONE call. Replaces the documented 3-4 step sequence for the single most common
        // browser workflow ("show me this page"), removing every intermediate round-trip
        // where a weak/local model could drop the real sessionId or stop after one step.
        const url = String(input["url"] ?? "").trim();
        if (!url) return fail("url is required");

        const { sessionId, session } = await resolveOrLaunchSession(input);

        const waitUntil = String(input["waitUntil"] ?? "domcontentloaded") as "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
        const navTimeout = Number(input["timeout"] ?? 15000);
        await session.page.goto(url, { waitUntil, timeout: navTimeout });
        session.targetUrl = session.page.url();

        const selector = String(input["selector"] ?? "").trim();
        if (selector) {
          await session.page.waitForSelector(selector, { timeout: Number(input["timeout"] ?? 10000), visible: true });
        } else {
          const waitMs = Number(input["waitMs"] ?? 0);
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        const format = (String(input["screenshotFormat"] ?? "jpeg").trim().toLowerCase() || "jpeg") as "jpeg" | "png" | "webp";
        const quality = format === "png" ? undefined : Math.max(1, Math.min(100, Number(input["screenshotQuality"] ?? 85)));
        const buffer = await session.page.screenshot({
          fullPage: true,
          type: format,
          ...(quality !== undefined ? { quality } : {}),
        });
        const viewport = session.page.viewport() || { width: 1440, height: 1024 };
        const title = await session.page.title().catch(() => "");

        const shouldClose = input["close"] === true || input["close"] === "true";
        if (shouldClose) {
          await stopStream(sessionId);
          await session.browser.close();
          sessions.delete(sessionId);
          if (defaultSessionId === sessionId) defaultSessionId = undefined;
        }

        return ok({
          sessionId: shouldClose ? null : sessionId,
          url: session.page.url(),
          title,
          closed: shouldClose,
          bytes: buffer.byteLength,
          screenshot: Buffer.from(buffer).toString("base64"),
          metadata: {
            format,
            width: viewport.width,
            height: viewport.height,
            timestamp: new Date().toISOString(),
            sizeKb: Math.round(buffer.byteLength / 1024),
          },
        });
      }
      case "evaluate": {
        const { sessionId, session } = await ensureSession(input);
        const script = String(input["script"] ?? "").trim();
        if (!script) return fail("script is required");
        const result = await session.page.evaluate(script);
        return ok({ sessionId, result });
      }
      case "verify_page": {
        // Macro for "does this page actually work": optional navigate -> optional wait for
        // a selector -> optional check script -> title/URL/text excerpt, in ONE call. Built
        // for testing/verification after writing a page (e.g. after the filesystem tool
        // wrote index.html) instead of chaining goto+wait+evaluate+get_content separately.
        const { sessionId, session } = await ensureSession(input);
        const url = String(input["url"] ?? "").trim();
        if (url) {
          const waitUntil = String(input["waitUntil"] ?? "domcontentloaded") as "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
          await session.page.goto(url, { waitUntil, timeout: Number(input["timeout"] ?? 15000) });
          session.targetUrl = session.page.url();
        }

        const selector = String(input["selector"] ?? "").trim();
        let selectorFound: boolean | null = null;
        if (selector) {
          try {
            await session.page.waitForSelector(selector, { timeout: Number(input["timeout"] ?? 10000), visible: true });
            selectorFound = true;
          } catch {
            selectorFound = false;
          }
        }

        const script = String(input["script"] ?? "").trim();
        let evaluated: unknown;
        let evaluateError: string | undefined;
        if (script) {
          try {
            evaluated = await session.page.evaluate(script);
          } catch (error) {
            evaluateError = error instanceof Error ? error.message : String(error);
          }
        }

        const title = await session.page.title().catch(() => "");
        const bodyText = input["extractText"] !== false
          ? await session.page.evaluate(() => document.body?.innerText?.slice(0, 5000) ?? "").catch(() => "")
          : undefined;

        return ok({
          sessionId,
          url: session.page.url(),
          title,
          selector: selector || null,
          selectorFound,
          script: script || null,
          evaluated: script ? evaluated ?? null : undefined,
          evaluateError: evaluateError ?? null,
          bodyText,
          // A quick pass/fail summary: no selector/script given means nothing was actually
          // checked, so that alone is never reported as a "pass".
          passed: (selector || script) ? selectorFound !== false && !evaluateError : null,
        });
      }
      case "cookies_get": {
        const { sessionId, session } = await ensureSession(input);
        const url = String(input["url"] ?? "").trim() || session.page.url();
        const client = await session.page.target().createCDPSession();
        const result = await client.send("Network.getCookies", url ? { urls: [url] } : {});
        const cookies = result?.cookies ?? [];
        return ok({ sessionId, cookies, count: cookies.length, url: url || null });
      }
      case "cookies_set": {
        const { sessionId, session } = await ensureSession(input);
        const raw = input["cookies"];
        if (!Array.isArray(raw) || raw.length === 0) return fail("cookies must be a non-empty array");

        const url = String(input["url"] ?? "").trim() || session.page.url();
        const client = await session.page.target().createCDPSession();

        let setCount = 0;
        for (const item of raw) {
          if (!item || typeof item !== "object") continue;
          const entry = item as Record<string, unknown>;
          const name = String(entry["name"] ?? "").trim();
          if (!name) continue;
          const value = String(entry["value"] ?? "");
          const cookieUrl = String(entry["url"] ?? "").trim() || url;
          const sameSiteInput = String(entry["sameSite"] ?? "").toLowerCase();
          const sameSite =
            sameSiteInput === "strict"
              ? "Strict"
              : sameSiteInput === "none"
                ? "None"
                : sameSiteInput === "lax"
                  ? "Lax"
                  : undefined;
          await client.send("Network.setCookie", {
            name,
            value,
            url: cookieUrl,
            domain: entry["domain"] ? String(entry["domain"]) : undefined,
            path: entry["path"] ? String(entry["path"]) : undefined,
            secure: entry["secure"] === true,
            httpOnly: entry["httpOnly"] === true,
            sameSite,
            expires: Number.isFinite(Number(entry["expires"])) ? Number(entry["expires"]) : undefined,
          });
          setCount += 1;
        }

        if (setCount === 0) return fail("No valid cookies to set");
        return ok({ sessionId, set: setCount, url: url || null });
      }
      case "cookies_clear": {
        const { sessionId, session } = await ensureSession(input);
        const url = String(input["url"] ?? "").trim() || session.page.url();
        const names = Array.isArray(input["cookieNames"])
          ? input["cookieNames"].map((v) => String(v ?? "").trim()).filter(Boolean)
          : [];

        const client = await session.page.target().createCDPSession();
        const result = await client.send("Network.getCookies", url ? { urls: [url] } : {});
        const current = result?.cookies ?? [];
        const toDelete = names.length > 0 ? current.filter((cookie) => names.includes(cookie.name)) : current;
        if (toDelete.length === 0) return ok({ sessionId, cleared: 0, url: url || null });

        for (const cookie of toDelete) {
          await client.send("Network.deleteCookies", {
            name: String(cookie.name ?? ""),
            domain: cookie.domain ? String(cookie.domain) : undefined,
            path: cookie.path ? String(cookie.path) : undefined,
            url,
          });
        }
        return ok({ sessionId, cleared: toDelete.length, url: url || null });
      }
      case "form_fill": {
        const { sessionId, session } = await ensureSession(input);
        const fields = input["fields"] as Record<string, unknown> | undefined;
        if (!fields || typeof fields !== "object") return fail("fields object is required");
        const clearFirst = input["clearFirst"] !== false;
        const timeout = Number(input["timeout"] ?? input["timeoutMs"] ?? 10000);

        const selectors = Object.keys(fields);
        if (selectors.length === 0) return fail("fields object is empty");

        for (const selector of selectors) {
          const value = String(fields[selector] ?? "");
          await session.page.waitForSelector(selector, { visible: true, timeout });
          await session.page.click(selector);
          if (clearFirst) {
            await session.page.click(selector, { count: 3 });
            await session.page.keyboard.press("Backspace");
          }
          await session.page.type(selector, value);
        }

        return ok({ sessionId, filled: selectors.length, selectors });
      }
      case "login": {
        const { sessionId, session } = await ensureSession(input);
        const username = String(input["username"] ?? "");
        const password = String(input["password"] ?? "");
        const usernameSelector = String(input["usernameSelector"] ?? "").trim();
        const passwordSelector = String(input["passwordSelector"] ?? "").trim();
        const submitSelector = String(input["submitSelector"] ?? "").trim();
        const timeout = Number(input["timeout"] ?? input["timeoutMs"] ?? 15000);
        const clearFirst = input["clearFirst"] !== false;
        const shouldWaitForNavigation = input["waitForNavigation"] !== false;

        if (!usernameSelector || !passwordSelector || !submitSelector) {
          return fail("usernameSelector, passwordSelector, and submitSelector are required");
        }
        if (!username || !password) return fail("username and password are required");

        const targetUrl = String(input["url"] ?? "").trim();
        if (targetUrl) {
          await session.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout });
        }

        await session.page.waitForSelector(usernameSelector, { visible: true, timeout });
        await session.page.waitForSelector(passwordSelector, { visible: true, timeout });

        await session.page.click(usernameSelector);
        if (clearFirst) {
          await session.page.click(usernameSelector, { count: 3 });
          await session.page.keyboard.press("Backspace");
        }
        await session.page.type(usernameSelector, username);

        await session.page.click(passwordSelector);
        if (clearFirst) {
          await session.page.click(passwordSelector, { count: 3 });
          await session.page.keyboard.press("Backspace");
        }
        await session.page.type(passwordSelector, password);

        if (shouldWaitForNavigation) {
          await Promise.all([
            session.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }),
            session.page.click(submitSelector),
          ]);
        } else {
          await session.page.click(submitSelector);
        }

        session.targetUrl = session.page.url();
        return ok({
          sessionId,
          loggedIn: true,
          currentUrl: session.page.url(),
          title: await session.page.title().catch(() => ""),
        });
      }
      case "pdf": {
        const { sessionId, session } = await ensureSession(input);
        const filePath = String(input["filePath"] ?? "").trim();
        if (!filePath) return fail("filePath is required");
        const format = String(input["format"] ?? "A4");
        const landscape = input["landscape"] === true;
        const printBackground = input["printBackground"] !== false;
        const buffer = await session.page.pdf({
          path: filePath,
          format: format as import("puppeteer-core").PaperFormat,
          landscape,
          printBackground,
        });
        return ok({ sessionId, savedTo: filePath, bytes: buffer.byteLength, format, landscape });
      }
      case "download": {
        const { sessionId, session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        if (!selector) return fail("selector is required");
        const timeout = Number(input["timeout"] ?? input["timeoutMs"] ?? 20000);
        const saveDir = String(input["saveDir"] ?? "").trim();

        if (saveDir) {
          const client = await session.page.target().createCDPSession();
          await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: saveDir });
        }

        await session.page.waitForSelector(selector, { visible: true, timeout });
        await session.page.click(selector);
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeout, 1500)));
        return ok({
          sessionId,
          downloaded: true,
          saveDir: saveDir || null,
          note: "Click executed; verify saved file in saveDir.",
        });
      }
      case "close": {
        const sessionId = String(input["sessionId"] ?? "").trim();
        if (!sessionId) return fail("sessionId is required");
        const session = sessions.get(sessionId);
        if (!session) return fail(`Browser session '${sessionId}' not found`);
        await stopStream(sessionId);
        await session.browser.close();
        sessions.delete(sessionId);
        if (defaultSessionId === sessionId) defaultSessionId = undefined;
        return ok({ closed: true, sessionId });
      }
      default:
        return fail(`Unknown browser action: ${action}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function startWorkerLoop(): void {
  process.on("message", async (payload: unknown) => {
    const message = payload as BrowserWorkerRequest;
    if (!message?.id || !message?.input) return;
    const result = await executeInWorker(message.input);
    if (typeof process.send === "function") {
      process.send({ id: message.id, result } satisfies BrowserWorkerResponse);
    }
  });
}

if (isWorkerMode()) {
  // Safety net: without these, any uncaught exception or unhandled rejection anywhere in
  // Puppeteer's internals (e.g. a page/browser crash, dropped CDP connection) crashes this
  // entire worker process with exit code 1, taking down every active session at once.
  process.on("uncaughtException", (error) => {
    console.error("[browser-worker] Uncaught exception (worker kept alive):", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[browser-worker] Unhandled rejection (worker kept alive):", reason);
  });
  startWorkerLoop();
}
