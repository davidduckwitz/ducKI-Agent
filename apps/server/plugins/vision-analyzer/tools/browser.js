export const definition = {
  name: "vision_browser",
  description: "Direct browser-session and frame access for the Vision Analyzer frontend. Uses the plugin's browser.frames capability and does not depend on the WebUI postMessage bridge.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["sessions", "frame"] },
      sessionId: { type: "string" },
    },
    required: ["action"],
  },
};

export async function execute(input, context) {
  if (!context.agent?.browser) {
    throw new Error("DucKI browser capability unavailable. The plugin requires permission 'browser.frames'.");
  }

  const action = String(input.action ?? "");

  if (action === "sessions") {
    return { sessions: await context.agent.browser.listSessions() };
  }

  if (action === "frame") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId is required");
    const frame = await context.agent.browser.getFrame(sessionId);
    if (!frame) return { frame: null };
    return {
      frame: {
        sessionId: frame.sessionId ?? sessionId,
        data: frame.data,
        format: frame.format === "png" ? "png" : "jpeg",
        timestamp: frame.timestamp ?? new Date().toISOString(),
        width: frame.width,
        height: frame.height,
      },
    };
  }

  throw new Error(`Unknown action: ${action}`);
}
