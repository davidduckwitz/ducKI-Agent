import { existsSync } from "node:fs";
import { execSync, fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const sessions = new Map();
const pending = new Map();
let workerProcess = null;
function ok(data) {
    return { success: true, data };
}
function fail(error) {
    return { success: false, data: null, error };
}
function isWorkerMode() {
    return process.argv.includes("--browser-worker");
}
function workerRunning() {
    return Boolean(workerProcess && workerProcess.connected && !workerProcess.killed);
}
function teardownWorker(message) {
    for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(message));
        pending.delete(id);
    }
    workerProcess = null;
}
function ensureWorker() {
    if (workerRunning() && workerProcess)
        return workerProcess;
    const modulePath = fileURLToPath(import.meta.url);
    const child = fork(modulePath, ["--browser-worker"], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.on("message", (payload) => {
        const message = payload;
        if (!message?.id)
            return;
        const entry = pending.get(message.id);
        if (!entry)
            return;
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
async function callWorker(input) {
    const worker = ensureWorker();
    const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Browser worker timed out"));
        }, Number(input["timeout"] ?? 30000) + 3000);
        pending.set(id, { resolve, reject, timeout });
        const request = { id, input };
        worker.send(request, (error) => {
            if (!error)
                return;
            const entry = pending.get(id);
            if (!entry)
                return;
            clearTimeout(entry.timeout);
            pending.delete(id);
            reject(new Error(`Failed to send request to browser worker: ${error.message}`));
        });
    });
}
function getPuppeteer() {
    return import("puppeteer-core");
}
function makeSessionId() {
    return `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function parseViewports(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    const width = Number(record["width"] ?? 0);
    const height = Number(record["height"] ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return undefined;
    return { width, height };
}
function windowsKnownBrowserPaths() {
    const roots = [
        process.env["PROGRAMFILES"],
        process.env["PROGRAMFILES(X86)"],
        process.env["LOCALAPPDATA"],
    ].filter((value) => Boolean(value && value.trim()));
    const candidates = [];
    for (const root of roots) {
        candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
        candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
        candidates.push(join(root, "Chromium", "Application", "chrome.exe"));
    }
    return candidates;
}
function resolveBrowserPath() {
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
    const explicit = candidates.filter((value) => Boolean(value && value.trim()));
    for (const candidate of explicit) {
        if (existsSync(candidate))
            return candidate;
    }
    if (process.platform === "win32") {
        for (const candidate of windowsKnownBrowserPaths()) {
            if (existsSync(candidate))
                return candidate;
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
            if (first && existsSync(first))
                return first;
        }
        catch {
            // Ignore lookup failures and continue to next candidate.
        }
    }
    return undefined;
}
function browserSelectionLabel(executablePath) {
    const normalized = executablePath.toLowerCase();
    if (normalized.includes("msedge"))
        return "Microsoft Edge";
    if (normalized.includes("chrome"))
        return "Google Chrome";
    if (normalized.includes("chromium"))
        return "Chromium";
    return "browser";
}
async function getSession(sessionId) {
    return sessions.get(sessionId);
}
async function createSession(options) {
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
    const session = {
        browser,
        page,
        launchedAt: new Date().toISOString(),
    };
    sessions.set(sessionId, session);
    return { sessionId, browserPath: executablePath, targetUrl: session.targetUrl };
}
async function ensureSession(input) {
    const sessionId = String(input["sessionId"] ?? "").trim();
    if (!sessionId)
        throw new Error("sessionId is required");
    const session = await getSession(sessionId);
    if (!session)
        throw new Error(`Browser session '${sessionId}' not found`);
    return { sessionId, session };
}
export const browserTool = {
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
    async execute(input) {
        const action = String(input["action"] ?? "").trim().toLowerCase();
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
        }
        catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    },
};
async function executeInWorker(input) {
    const action = String(input["action"] ?? "").trim().toLowerCase();
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
                const result = await Promise.all(pages.slice(0, count).map(async (page, index) => ({
                    index,
                    url: page.url(),
                    title: await page.title().catch(() => ""),
                })));
                return ok({ pages: result });
            }
            case "goto": {
                const { session } = await ensureSession(input);
                const url = String(input["url"] ?? "").trim();
                if (!url)
                    return fail("url is required");
                const timeout = Number(input["timeout"] ?? 10000);
                const waitUntil = String(input["waitUntil"] ?? "domcontentloaded");
                await session.page.goto(url, { waitUntil, timeout });
                session.targetUrl = session.page.url();
                return ok({ url: session.page.url(), title: await session.page.title(), sessionId: String(input["sessionId"] ?? "") });
            }
            case "click": {
                const { session } = await ensureSession(input);
                const selector = String(input["selector"] ?? "").trim();
                if (!selector)
                    return fail("selector is required");
                const timeout = Number(input["timeout"] ?? 10000);
                await session.page.waitForSelector(selector, { timeout, visible: true });
                await session.page.click(selector);
                return ok({ clicked: selector, url: session.page.url() });
            }
            case "type": {
                const { session } = await ensureSession(input);
                const selector = String(input["selector"] ?? "").trim();
                const text = String(input["text"] ?? "");
                if (!selector)
                    return fail("selector is required");
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
                if (!key)
                    return fail("key is required");
                await session.page.keyboard.press(key);
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
                const buffer = await session.page.screenshot({ path: path, fullPage: true });
                return ok({
                    savedTo: path ?? null,
                    bytes: buffer.byteLength,
                    url: session.page.url(),
                });
            }
            case "evaluate": {
                const { session } = await ensureSession(input);
                const script = String(input["script"] ?? "").trim();
                if (!script)
                    return fail("script is required");
                const result = await session.page.evaluate(script);
                return ok({ result });
            }
            case "cookies_get": {
                const { session } = await ensureSession(input);
                const url = String(input["url"] ?? "").trim() || session.page.url();
                const client = await session.page.target().createCDPSession();
                const result = await client.send("Network.getCookies", url ? { urls: [url] } : {});
                const cookies = result?.cookies ?? [];
                return ok({ cookies, count: cookies.length, url: url || null });
            }
            case "cookies_set": {
                const { session } = await ensureSession(input);
                const raw = input["cookies"];
                if (!Array.isArray(raw) || raw.length === 0)
                    return fail("cookies must be a non-empty array");
                const url = String(input["url"] ?? "").trim() || session.page.url();
                const client = await session.page.target().createCDPSession();
                let setCount = 0;
                for (const item of raw) {
                    if (!item || typeof item !== "object")
                        continue;
                    const entry = item;
                    const name = String(entry["name"] ?? "").trim();
                    if (!name)
                        continue;
                    const value = String(entry["value"] ?? "");
                    const cookieUrl = String(entry["url"] ?? "").trim() || url;
                    const sameSiteInput = String(entry["sameSite"] ?? "").toLowerCase();
                    const sameSite = sameSiteInput === "strict"
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
                if (setCount === 0)
                    return fail("No valid cookies to set");
                return ok({ set: setCount, url: url || null });
            }
            case "cookies_clear": {
                const { session } = await ensureSession(input);
                const url = String(input["url"] ?? "").trim() || session.page.url();
                const names = Array.isArray(input["cookieNames"])
                    ? input["cookieNames"].map((v) => String(v ?? "").trim()).filter(Boolean)
                    : [];
                const client = await session.page.target().createCDPSession();
                const result = await client.send("Network.getCookies", url ? { urls: [url] } : {});
                const current = result?.cookies ?? [];
                const toDelete = names.length > 0 ? current.filter((cookie) => names.includes(cookie.name)) : current;
                if (toDelete.length === 0)
                    return ok({ cleared: 0, url: url || null });
                for (const cookie of toDelete) {
                    await client.send("Network.deleteCookies", {
                        name: String(cookie.name ?? ""),
                        domain: cookie.domain ? String(cookie.domain) : undefined,
                        path: cookie.path ? String(cookie.path) : undefined,
                        url,
                    });
                }
                return ok({ cleared: toDelete.length, url: url || null });
            }
            case "form_fill": {
                const { session } = await ensureSession(input);
                const fields = input["fields"];
                if (!fields || typeof fields !== "object")
                    return fail("fields object is required");
                const clearFirst = input["clearFirst"] !== false;
                const timeout = Number(input["timeout"] ?? input["timeoutMs"] ?? 10000);
                const selectors = Object.keys(fields);
                if (selectors.length === 0)
                    return fail("fields object is empty");
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
                return ok({ filled: selectors.length, selectors });
            }
            case "login": {
                const { session } = await ensureSession(input);
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
                if (!username || !password)
                    return fail("username and password are required");
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
                }
                else {
                    await session.page.click(submitSelector);
                }
                session.targetUrl = session.page.url();
                return ok({
                    loggedIn: true,
                    currentUrl: session.page.url(),
                    title: await session.page.title().catch(() => ""),
                });
            }
            case "pdf": {
                const { session } = await ensureSession(input);
                const filePath = String(input["filePath"] ?? "").trim();
                if (!filePath)
                    return fail("filePath is required");
                const format = String(input["format"] ?? "A4");
                const landscape = input["landscape"] === true;
                const printBackground = input["printBackground"] !== false;
                const buffer = await session.page.pdf({
                    path: filePath,
                    format: format,
                    landscape,
                    printBackground,
                });
                return ok({ savedTo: filePath, bytes: buffer.byteLength, format, landscape });
            }
            case "download": {
                const { session } = await ensureSession(input);
                const selector = String(input["selector"] ?? "").trim();
                if (!selector)
                    return fail("selector is required");
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
                    downloaded: true,
                    saveDir: saveDir || null,
                    note: "Click executed; verify saved file in saveDir.",
                });
            }
            case "close": {
                const sessionId = String(input["sessionId"] ?? "").trim();
                if (!sessionId)
                    return fail("sessionId is required");
                const session = sessions.get(sessionId);
                if (!session)
                    return fail(`Browser session '${sessionId}' not found`);
                await session.browser.close();
                sessions.delete(sessionId);
                return ok({ closed: true, sessionId });
            }
            default:
                return fail(`Unknown browser action: ${action}`);
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
function startWorkerLoop() {
    process.on("message", async (payload) => {
        const message = payload;
        if (!message?.id || !message?.input)
            return;
        const result = await executeInWorker(message.input);
        if (typeof process.send === "function") {
            process.send({ id: message.id, result });
        }
    });
}
if (isWorkerMode()) {
    startWorkerLoop();
}
//# sourceMappingURL=browser.js.map