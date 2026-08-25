// Best-effort cleanup when the plugin page is closed or navigated away from. The iframe host
// only owns Socket.IO room membership; the vision tool owns the actual browser stream and its
// Worker timers, so the plugin asks the tool to stop its own session explicitly.
window.addEventListener("pagehide", () => {
  if (!currentSession) return;
  const sessionId = currentSession;
  currentSession = "";

  try {
    // Parent origin can differ in Tauri/remote mode. The host validates this iframe's exact
    // origin plus event.source, so wildcard delivery does not widen the privileged bridge.
    parent.postMessage({
      type: "ducki:browser:unsubscribe",
      requestId: crypto.randomUUID(),
      sessionId,
    }, "*");
  } catch {}

  // keepalive lets Chromium finish this small request while tearing down the iframe. Failure is
  // non-fatal; a later explicit stop or server restart still releases the in-memory state.
  void fetch("/api/plugins/vision-analyzer/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "vision_analyzer",
      input: { action: "stop", sessionId },
    }),
    keepalive: true,
  }).catch(() => {});
});
