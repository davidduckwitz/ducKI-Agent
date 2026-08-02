import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getSessionManager } from "../lib/session-manager.js";
import { getScreenshotStorageManager } from "../lib/screenshot-storage.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

interface BrowserSessionData {
  // TODO: Store browser instance here when Puppeteer/Playwright is implemented
  url?: string;
  lastScreenshot?: string;
}

export function createBrowserControlMcpTool(): ToolExecutor {
  const sessionManager = getSessionManager();

  return {
    name: "browser-control",
    description: "Control browser automation with vision support - navigate, click, type, screenshot (session-based, vision-enabled for LLM models)",
    definition: {
      name: "browser-control",
      description: "Browser automation control with vision capabilities - enables screenshots for LLM vision models",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "session_create",
              "session_close",
              "session_list",
              "navigate",
              "click",
              "type",
              "screenshot",
              "wait",
              "evaluate",
              "close",
            ],
            description: "Action to perform",
          },
          sessionId: {
            type: "string",
            description: "Session ID (auto-created from agentId if not provided)",
          },
          agentId: {
            type: "string",
            description: "Agent ID for implicit session management",
          },
          url: {
            type: "string",
            description: "URL to navigate to (for navigate action)",
          },
          selector: {
            type: "string",
            description: "CSS selector for click/type actions",
          },
          text: {
            type: "string",
            description: "Text to type (for type action)",
          },
          code: {
            type: "string",
            description: "JavaScript code to evaluate (for evaluate action)",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (for wait action)",
          },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      const sessionId = input["sessionId"] ? String(input["sessionId"]) : undefined;
      const agentId = input["agentId"] ? String(input["agentId"]) : undefined;

      try {
        // Session management actions
        if (action === "session_create") {
          const session = sessionManager.getOrCreateSession(sessionId, agentId);
          return ok({
            sessionCreated: true,
            sessionId: session.id,
            agentId: session.agentId,
          });
        }

        if (action === "session_close") {
          if (!sessionId && !agentId) {
            return fail("sessionId or agentId required for session_close");
          }
          const id = sessionId || agentId;
          const closed = sessionManager.closeSession(id!);
          return ok({ sessionClosed: closed, sessionId: id });
        }

        if (action === "session_list") {
          const sessions = sessionManager.listSessions();
          return ok({
            sessions: sessions.map((s) => ({
              id: s.id,
              agentId: s.agentId,
              createdAt: new Date(s.createdAt).toISOString(),
              lastAccessedAt: new Date(s.lastAccessedAt).toISOString(),
            })),
          });
        }

        // All other actions require a session
        const actualSessionId = sessionId || agentId;
        if (!actualSessionId) {
          return fail("sessionId or agentId required for this action");
        }

        const session = sessionManager.getOrCreateSession(sessionId, agentId);

        switch (action) {
          case "navigate": {
            const url = String(input["url"] ?? "");
            if (!url) return fail("url is required for navigate action");

            // Store URL in session
            sessionManager.setSessionData<BrowserSessionData>(session.id, "browserData", {
              url,
            });

            // TODO: Implement browser navigation using Puppeteer/Playwright
            // const page = session.data.page || await browser.newPage();
            // await page.goto(url);
            // sessionManager.setSessionData(session.id, "page", page);

            return ok({ navigated: true, url, sessionId: session.id });
          }

          case "click": {
            const selector = String(input["selector"] ?? "");
            if (!selector) return fail("selector is required for click action");

            // TODO: Implement click action
            // const page = sessionManager.getSessionData(session.id, "page");
            // await page.click(selector);

            return ok({ clicked: true, selector, sessionId: session.id });
          }

          case "type": {
            const selector = String(input["selector"] ?? "");
            const text = String(input["text"] ?? "");
            if (!selector || !text) {
              return fail("selector and text are required for type action");
            }

            // TODO: Implement type action
            // const page = sessionManager.getSessionData(session.id, "page");
            // await page.type(selector, text);

            return ok({ typed: true, selector, text, sessionId: session.id });
          }

          case "screenshot": {
            // TODO: Implement screenshot action with Puppeteer/Playwright
            // For now, return mock screenshot data
            // const page = sessionManager.getSessionData(session.id, "page");
            // const buffer = await page.screenshot();
            // const base64 = buffer.toString("base64");

            // Demo: Use screenshot storage manager for large images
            // In production, pass actual buffer from page.screenshot()
            const mockBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

            const screenshotManager = getScreenshotStorageManager();
            const storageResult = await screenshotManager.handleScreenshot(mockBase64, "image/png");

            // Store in session
            sessionManager.setSessionData<BrowserSessionData>(session.id, "browserData", {
              url: String(input["url"] ?? ""),
            });

            // Return either inline base64 or storage URL
            if (!storageResult.isStored) {
              return ok({
                screenshot: storageResult.data,
                screenshotMimeType: storageResult.mimeType,
                sessionId: session.id,
              });
            } else {
              return ok({
                screenshotUrl: storageResult.url,
                screenshotId: storageResult.id,
                screenshotSize: `${Math.round(storageResult.size / 1024)}KB`,
                sessionId: session.id,
                message: "Screenshot stored - use screenshotUrl to retrieve or analyze",
              });
            }
          }

          case "wait": {
            const timeout = Number(input["timeout"] ?? 1000);
            await new Promise((resolve) => setTimeout(resolve, timeout));
            return ok({ waited: true, timeout, sessionId: session.id });
          }

          case "evaluate": {
            const code = String(input["code"] ?? "");
            if (!code) return fail("code is required for evaluate action");

            // TODO: Implement JavaScript evaluation
            // const page = sessionManager.getSessionData(session.id, "page");
            // const result = await page.evaluate(code);

            return ok({ evaluated: true, result: null, sessionId: session.id });
          }

          case "close": {
            // TODO: Implement browser close
            // const page = sessionManager.getSessionData(session.id, "page");
            // await page?.close();

            sessionManager.closeSession(session.id);
            return ok({ closed: true, sessionId: session.id });
          }

          default:
            return fail(`Unknown action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
