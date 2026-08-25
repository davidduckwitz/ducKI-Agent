// Calendar-style direct plugin transport for the integrated browser source.
// The Vision UI must keep working even when the React host/postMessage bridge is unavailable,
// late, cross-origin or blocked. Core browser data therefore goes through the same
// /api/plugins/:name/invoke channel used by the working Calendar plugin.

let directBrowserPollTimer = 0;
let directBrowserPollBusy = false;
let directBrowserLastFrameAt = "";

async function invokeVisionBrowser(input) {
  const response = await fetch("/api/plugins/vision-analyzer/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "vision_browser", input }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || json?.error || json?.message || `HTTP ${response.status}`);
  }
  return json?.data?.result ?? json?.data ?? {};
}

// Resolve requests app.js may have queued during its initial synchronous boot before this
// adapter was loaded. Otherwise the obsolete postMessage request would show a Bridge timeout
// several seconds later even though direct browser access is already working.
try {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve([]);
  }
  pending.clear();
} catch {
  // Older/newer app.js versions may not expose a pending map. Direct mode still works.
}

// Replace the old host-bridge request function. Existing app.js, camera.js and media.js can
// keep calling the same helper, but browser session discovery now happens inside the plugin.
request = async function directBrowserRequest(type, extra = {}) {
  if (type === "ducki:browser:list-sessions") {
    const result = await invokeVisionBrowser({ action: "sessions" });
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  // The actual browser stream is owned by vision_analyzer action=start. These two calls used
  // to only manage a Socket.IO room in the parent UI, which direct mode no longer needs.
  if (type === "ducki:browser:subscribe" || type === "ducki:browser:unsubscribe") {
    return { sessionId: String(extra.sessionId || "") };
  }

  throw new Error(`Unsupported browser request '${type}'`);
};

function stopDirectBrowserPolling() {
  if (directBrowserPollTimer) clearInterval(directBrowserPollTimer);
  directBrowserPollTimer = 0;
  directBrowserPollBusy = false;
  directBrowserLastFrameAt = "";
}

function renderDirectBrowserFrame(payload) {
  if (!payload?.data || !currentSession) return;
  if (payload.sessionId && payload.sessionId !== currentSession) return;
  if (payload.timestamp && payload.timestamp === directBrowserLastFrameAt) return;
  directBrowserLastFrameAt = payload.timestamp || "";

  const image = document.getElementById("frame");
  const empty = document.querySelector("#viewer .empty");
  if (empty) empty.hidden = true;
  image.hidden = false;
  image.src = `data:image/${payload.format === "png" ? "png" : "jpeg"};base64,${payload.data}`;

  frameCount += 1;
  document.getElementById("fps").textContent = `Frames: ${frameCount}`;
  document.getElementById("last").textContent = new Date(payload.timestamp || Date.now()).toLocaleTimeString();

  image.onload = () => {
    void detectQr(image);
    detectMotion(image);
    if (lastRenderedState) drawOverlay(lastRenderedState);
  };

  if (frameCount % 8 === 0) void refreshState();
}

async function pollDirectBrowserFrame() {
  if (directBrowserPollBusy || !currentSession) return;
  if (document.getElementById("sourceMode")?.value !== "browser") return;

  directBrowserPollBusy = true;
  try {
    const result = await invokeVisionBrowser({ action: "frame", sessionId: currentSession });
    if (result?.frame) renderDirectBrowserFrame(result.frame);
  } catch (error) {
    // Keep the last image visible on transient browser/screenshot failures. Surface the error,
    // but don't turn off polling so a restarted browser session can recover automatically.
    const target = document.getElementById("error");
    if (target) target.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    directBrowserPollBusy = false;
  }
}

function startDirectBrowserPolling() {
  stopDirectBrowserPolling();
  if (!currentSession) return;
  void pollDirectBrowserFrame();
  directBrowserPollTimer = window.setInterval(() => void pollDirectBrowserFrame(), 300);
}

// Keep app.js's established session lifecycle and analysis state, but replace the frame transport.
const bridgeSubscribe = subscribe;
subscribe = async function directSubscribe(sessionId) {
  stopDirectBrowserPolling();
  await bridgeSubscribe(sessionId);
  if (sessionId && currentSession === sessionId) startDirectBrowserPolling();
};

// app.js attempted its first session request before this adapter existed. Repeat discovery now
// through the direct plugin tool, exactly like Calendar loads its data through /invoke.
void loadSessions().then(() => {
  const select = document.getElementById("sessions");
  if (select && select.options.length <= 1) {
    select.options[0].textContent = "Keine Browser-Session gefunden";
  }
}).catch((error) => {
  const target = document.getElementById("error");
  if (target) target.textContent = error instanceof Error ? error.message : String(error);
});

const sourceSelect = document.getElementById("sourceMode");
sourceSelect?.addEventListener("change", () => {
  if (sourceSelect.value === "browser" && currentSession) startDirectBrowserPolling();
  else stopDirectBrowserPolling();
});

window.addEventListener("pagehide", stopDirectBrowserPolling);
