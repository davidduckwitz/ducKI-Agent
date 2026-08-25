const sessions = new Map();

function stateFor(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { sessionId, running: false, latestFrame: null, analysis: null, qrCodes: [], updatedAt: null, unsubscribe: null, timer: null };
    sessions.set(sessionId, state);
  }
  return state;
}

function publicState(state) {
  return {
    sessionId: state.sessionId,
    running: state.running,
    latestFrameAt: state.latestFrame?.timestamp ?? null,
    analysis: state.analysis,
    qrCodes: state.qrCodes,
    updatedAt: state.updatedAt,
  };
}

function parseJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { return { description: String(text ?? ""), raw: String(text ?? "") }; }
}

async function analyzeFrame(context, state, question) {
  if (!context.agent) throw new Error("Agent capabilities are unavailable");
  const frame = state.latestFrame ?? await context.agent.browser?.getFrame(state.sessionId);
  if (!frame) throw new Error("No browser frame available");
  state.latestFrame = frame;
  const prompt = question || `Analyze this browser frame. Return ONLY compact JSON with keys: scene {label,confidence}, people [{confidence,bbox}], objects [{type,confidence,bbox}], text [{text,confidence,bbox}], qrCodes [{value,bbox}], description. bbox values should be normalized [x,y,width,height] when possible. Do not invent unreadable text or QR values.`;
  const response = await context.agent.analyzeImage([{ base64: frame.data, mimeType: `image/${frame.format === "png" ? "png" : "jpeg"}` }], prompt);
  state.analysis = parseJson(response);
  if (Array.isArray(state.analysis?.qrCodes)) state.qrCodes = state.analysis.qrCodes;
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

async function start(context, sessionId) {
  if (!context.agent?.browser) throw new Error("Browser capability unavailable");
  const state = stateFor(sessionId);
  if (state.running) return publicState(state);
  const resolved = await context.agent.browser.startStream(sessionId);
  state.sessionId = resolved;
  state.running = true;
  state.unsubscribe = context.agent.browser.subscribeFrames(resolved, (frame) => { state.latestFrame = frame; });

  const auto = context.settings?.VISION_AUTO_ANALYZE === true;
  const interval = Math.max(2000, Number(context.settings?.VISION_ANALYZE_INTERVAL_MS ?? 5000));
  if (auto) {
    state.timer = setInterval(() => { if (state.latestFrame) void analyzeFrame(context, state).catch(() => {}); }, interval);
  }
  return publicState(state);
}

async function stop(context, sessionId) {
  const state = stateFor(sessionId);
  if (state.unsubscribe) state.unsubscribe();
  if (state.timer) clearInterval(state.timer);
  state.unsubscribe = null;
  state.timer = null;
  state.running = false;
  if (context.agent?.browser) await context.agent.browser.stopStream(sessionId).catch(() => {});
  return publicState(state);
}

export const definition = {
  name: "vision_analyzer",
  description: "Observe DucKI browser sessions, inspect current visual state, scan frames, and ask visual questions.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["sessions", "start", "stop", "state", "scan", "query", "report_observation"] },
      sessionId: { type: "string" },
      question: { type: "string" },
      qrCodes: { type: "array", items: { type: "object" } }
    },
    required: ["action"]
  }
};

export async function execute(input, context) {
  const action = String(input.action ?? "");
  if (!context.agent?.browser && action !== "state" && action !== "report_observation") throw new Error("DucKI browser capability unavailable");
  if (action === "sessions") return { sessions: await context.agent.browser.listSessions() };

  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  if (action === "start") return start(context, sessionId);
  if (action === "stop") return stop(context, sessionId);
  if (action === "state") return publicState(stateFor(sessionId));
  if (action === "scan") {
    const state = stateFor(sessionId);
    state.latestFrame = await context.agent.browser.getFrame(sessionId);
    return analyzeFrame(context, state);
  }
  if (action === "query") {
    const state = stateFor(sessionId);
    state.latestFrame = await context.agent.browser.getFrame(sessionId);
    return analyzeFrame(context, state, String(input.question ?? "Describe what is happening in this frame."));
  }
  if (action === "report_observation") {
    const state = stateFor(sessionId);
    if (Array.isArray(input.qrCodes)) state.qrCodes = input.qrCodes.slice(0, 32);
    state.updatedAt = new Date().toISOString();
    return publicState(state);
  }
  throw new Error(`Unknown action: ${action}`);
}
