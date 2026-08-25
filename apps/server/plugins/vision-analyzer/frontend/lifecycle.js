// Best-effort cleanup when the plugin page is closed or navigated away from.
// Like the Calendar plugin, lifecycle calls go directly through the plugin invoke API and do
// not depend on the React host, postMessage or Socket.IO rooms.
window.addEventListener("pagehide", () => {
  if (!currentSession) return;
  const sessionId = currentSession;
  currentSession = "";
  const isLocalSource = sessionId === "camera:local" || sessionId === "video:local";

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
