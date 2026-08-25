// Best-effort cleanup when the plugin page is closed or navigated away from. Browser streams
// and local media pseudo-sessions have different lifecycles and must not be mixed.
window.addEventListener("pagehide", () => {
  if (!currentSession) return;
  const sessionId = currentSession;
  currentSession = "";
  const isLocalSource = sessionId === "camera:local" || sessionId === "video:local";

  if (!isLocalSource) {
    try {
      // Parent origin can differ in Tauri/remote mode. The host validates this iframe's exact
      // origin plus event.source, so wildcard delivery does not widen the privileged bridge.
      parent.postMessage({
        type: "ducki:browser:unsubscribe",
        requestId: crypto.randomUUID(),
        sessionId,
      }, "*");
    } catch {}
  }

  // keepalive lets Chromium finish this small request while tearing down the iframe. Local
  // sources only clear ephemeral analysis state; browser sources stop their tool-owned stream.
  void fetch("/api/plugins/vision-analyzer/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: "vision_analyzer",
      input: {
        action: isLocalSource ? "local_source_stop" : "stop",
        sessionId,
      },
    }),
    keepalive: true,
  }).catch(() => {});
});
