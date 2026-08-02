import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { existsSync } from "node:fs";
import { execSync, fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type BrowserAction =
  | "detect"
  | "launch"
  | "list_pages"
  | "goto"
  | "click"
  | "type"
  | "press"
  | "wait"
  | "screenshot"
  | "evaluate"
  | "cookies_get"
  | "cookies_set"
  | "cookies_clear"
  | "form_fill"
  | "login"
  | "pdf"
  | "download"
  | "close";

interface BrowserSession {
  browser: import("puppeteer-core").Browser;
  page: import("puppeteer-core").Page;
  launchedAt: string;
  targetUrl?: string;
}

interface BrowserWorkerRequest {
  id: string;
  input: Record<string, unknown>;
}

interface BrowserWorkerResponse {
  id: string;
  result: ToolResult;
}

// Sessions map - kept alive in main process so they persist across worker restarts
const mainProcessSessions = new Map<string, { launchedAt: string; url?: string }>();
const sessions = new Map<string, BrowserSession>();
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
    const message = payload as BrowserWorkerResponse;
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
    const timeout = setTimeout(() => {
      const entry = pending.get(id);
      if (entry && !entry.settled) {
        entry.settled = true;
        pending.delete(id);
        reject(new Error("Browser worker timed out"));
      }
    }, Number(input["timeout"] ?? 30000) + 3000);

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
  };
  sessions.set(sessionId, session);
  return { sessionId, browserPath: executablePath, targetUrl: session.targetUrl };
}

async function ensureSession(input: Record<string, unknown>): Promise<{ sessionId: string; session: BrowserSession }> {
  const requestedSessionId = String(input["sessionId"] ?? "").trim();
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

export const browserTool: ToolExecutor = {
  name: "browser",
  description: "Detect browser availability and control browser sessions using Puppeteer",
  definition: {
    name: "browser",
    description: "Browser automation and detection via Puppeteer",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "detect",
            "launch",
            "list_pages",
            "goto",
            "click",
            "type",
            "press",
            "wait",
            "screenshot",
            "evaluate",
            "cookies_get",
            "cookies_set",
            "cookies_clear",
            "form_fill",
            "login",
            "pdf",
            "download",
            "close",
          ],
        },
        sessionId: { type: "string", description: "Browser session id" },
        url: { type: "string", description: "URL to open or navigate to" },
        selector: { type: "string", description: "CSS selector for click/type/wait" },
        text: { type: "string", description: "Text to type" },
        key: { type: "string", description: "Keyboard key or shortcut" },
        timeout: { type: "number", description: "Timeout in ms", default: 10000 },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"] },
        headless: { type: "boolean", description: "Launch browser in headless mode" },
        viewport: { type: "object", description: "Viewport size", properties: { width: { type: "number" }, height: { type: "number" } } },
        executablePath: { type: "string", description: "Optional browser executable path" },
        filePath: { type: "string", description: "Screenshot file path" },
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

async function executeInWorker(input: Record<string, unknown>): Promise<ToolResult> {
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
        const viewport = parseViewports(input["viewport"]);
        const { sessionId, browserPath } = await createSession({
          headless: input["headless"] === true || input["headless"] === "true",
          viewport,
          executablePath: typeof input["executablePath"] === "string" ? input["executablePath"] : undefined,
          userAgent: typeof input["userAgent"] === "string" ? input["userAgent"] : undefined,
          disableImages: input["disableImages"] === true || input["disableImages"] === "true",
          blockResources: (input["blockResources"] as "none" | "tracking" | "ads" | "all") || "none",
          hideAutomation: input["hideAutomation"] !== false && input["hideAutomation"] !== "false",
          cookieDetection: input["cookieDetection"] === true || input["cookieDetection"] === "true",
        });
        const session = await getSession(sessionId);
        if (browserPath) {
          console.info(`[browser] launching ${browserSelectionLabel(browserPath)} at ${browserPath}`);
        }
        console.info(`[browser] Session created: ${sessionId}`);
        if (input["url"] && session) {
          await session.page.goto(String(input["url"]), { waitUntil: "domcontentloaded" });
          session.targetUrl = session.page.url();
        }
        const result = {
          sessionId,
          browserPath: browserPath ?? null,
          browserName: browserPath ? browserSelectionLabel(browserPath) : null,
          currentUrl: session?.page.url() ?? null,
          launchedAt: session?.launchedAt,
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
        const selector = String(input["selector"] ?? "").trim();
        if (!selector) return fail("selector is required");
        const timeout = Number(input["timeout"] ?? 10000);
        await session.page.waitForSelector(selector, { timeout, visible: true });
        await session.page.click(selector);
        return ok({ sessionId, clicked: selector, url: session.page.url() });
      }
      case "type": {
        const { sessionId, session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        const text = String(input["text"] ?? "");
        if (!selector) return fail("selector is required");
        const timeout = Number(input["timeout"] ?? 10000);
        await session.page.waitForSelector(selector, { visible: true, timeout });
        await session.page.click(selector);
        await session.page.type(selector, text);
        return ok({ sessionId, typed: text.length, selector });
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
        const filePath = String(input["filePath"] ?? "").trim();
        const path = filePath || undefined;
        // webp because the chat preview (BrowserPreview.tsx) wraps the returned base64 as
        // `data:image/webp;base64,...` - Puppeteer's default (png) would still render (most
        // browsers sniff the real format), but mislabels the data URI's declared MIME type.
        const buffer = await session.page.screenshot({ path: path as string | undefined, fullPage: true, type: "webp" });

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
          // Metadata for screenshot tracking
          metadata: {
            format: "webp",
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
        await session.browser.close();
        sessions.delete(sessionId);
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
  startWorkerLoop();
}
