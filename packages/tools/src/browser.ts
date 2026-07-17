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

const sessions = new Map<string, BrowserSession>();
const pending = new Map<
  string,
  { resolve: (result: ToolResult) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
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
    if (!entry) return;
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
      pending.delete(id);
      reject(new Error("Browser worker timed out"));
    }, Number(input["timeout"] ?? 30000) + 3000);

    pending.set(id, { resolve, reject, timeout });

    const request: BrowserWorkerRequest = { id, input };
    worker.send(request, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry) return;
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

async function createSession(options: { headless?: boolean; viewport?: { width: number; height: number }; executablePath?: string }): Promise<{ sessionId: string; targetUrl?: string; browserPath?: string }> {
  const puppeteer = await getPuppeteer();
  const executablePath = options.executablePath ?? resolveBrowserPath();
  if (!executablePath) {
    throw new Error("No local browser executable found. Set PUPPETEER_EXECUTABLE_PATH, CHROME_BIN, EDGE_BIN, or BROWSER_PATH.");
  }
  const browser = await puppeteer.launch({
    headless: options.headless ?? false,
    executablePath,
    defaultViewport: options.viewport ?? { width: 1440, height: 1024 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
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
  const sessionId = String(input["sessionId"] ?? "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Browser session '${sessionId}' not found`);
  return { sessionId, session };
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
          enum: ["detect", "launch", "list_pages", "goto", "click", "type", "press", "wait", "screenshot", "evaluate", "close"],
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

      return await callWorker(input);
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
          headless: input["headless"] === true,
          viewport,
          executablePath: typeof input["executablePath"] === "string" ? input["executablePath"] : undefined,
        });
        const session = await getSession(sessionId);
        if (browserPath) {
          console.info(`[browser] launching ${browserSelectionLabel(browserPath)} at ${browserPath}`);
        }
        if (input["url"] && session) {
          await session.page.goto(String(input["url"]), { waitUntil: "domcontentloaded" });
          session.targetUrl = session.page.url();
        }
        return ok({
          sessionId,
          browserPath: browserPath ?? null,
          browserName: browserPath ? browserSelectionLabel(browserPath) : null,
          currentUrl: session?.page.url() ?? null,
          launchedAt: session?.launchedAt,
        });
      }
      case "list_pages": {
        const { session } = await ensureSession(input);
        const pages = await session.browser.pages();
        const count = Math.max(1, Number(input["count"] ?? 20));
        const result = await Promise.all(
          pages.slice(0, count).map(async (page, index) => ({
            index,
            url: page.url(),
            title: await page.title().catch(() => ""),
          }))
        );
        return ok({ pages: result });
      }
      case "goto": {
        const { session } = await ensureSession(input);
        const url = String(input["url"] ?? "").trim();
        if (!url) return fail("url is required");
        const timeout = Number(input["timeout"] ?? 10000);
        const waitUntil = String(input["waitUntil"] ?? "domcontentloaded") as "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
        await session.page.goto(url, { waitUntil, timeout });
        session.targetUrl = session.page.url();
        return ok({ url: session.page.url(), title: await session.page.title(), sessionId: String(input["sessionId"] ?? "") });
      }
      case "click": {
        const { session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        if (!selector) return fail("selector is required");
        const timeout = Number(input["timeout"] ?? 10000);
        await session.page.waitForSelector(selector, { timeout, visible: true });
        await session.page.click(selector);
        return ok({ clicked: selector, url: session.page.url() });
      }
      case "type": {
        const { session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        const text = String(input["text"] ?? "");
        if (!selector) return fail("selector is required");
        await session.page.waitForSelector(selector, { visible: true, timeout: Number(input["timeout"] ?? 10000) });
        await session.page.click(selector);
        await session.page.click(selector);
        await session.page.click(selector);
        await session.page.type(selector, text);
        return ok({ typed: text.length, selector });
      }
      case "press": {
        const { session } = await ensureSession(input);
        const key = String(input["key"] ?? "").trim();
        if (!key) return fail("key is required");
        await session.page.keyboard.press(key as import("puppeteer-core").KeyInput);
        return ok({ pressed: key });
      }
      case "wait": {
        const { session } = await ensureSession(input);
        const selector = String(input["selector"] ?? "").trim();
        const timeout = Number(input["timeout"] ?? 10000);
        if (selector) {
          await session.page.waitForSelector(selector, { timeout, visible: true });
          return ok({ waitedFor: selector });
        }
        await new Promise((resolve) => setTimeout(resolve, timeout));
        return ok({ waitedMs: timeout });
      }
      case "screenshot": {
        const { session } = await ensureSession(input);
        const filePath = String(input["filePath"] ?? "").trim();
        const path = filePath || undefined;
        const buffer = await session.page.screenshot({ path: path as string | undefined, fullPage: true });
        return ok({
          savedTo: path ?? null,
          bytes: buffer.byteLength,
          url: session.page.url(),
        });
      }
      case "evaluate": {
        const { session } = await ensureSession(input);
        const script = String(input["script"] ?? "").trim();
        if (!script) return fail("script is required");
        const result = await session.page.evaluate(script);
        return ok({ result });
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
