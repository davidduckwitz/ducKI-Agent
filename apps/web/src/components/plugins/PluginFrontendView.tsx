import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getApiBaseUrl, pluginUiUrl } from "../../lib/backendUrl";
import { usePlugins } from "../../lib/usePlugins";
import { useAppStore } from "../../lib/store";

/**
 * Full-page host for a plugin mini-app. Host bridges are capability-gated: a same-origin iframe
 * is not enough to receive privileged app data. The raw manifest must explicitly request the
 * capability and the plugin must be trust:"node" before browser frames are exposed.
 */
export function PluginFrontendView() {
  const { name = "" } = useParams();
  const { data: plugins } = usePlugins();
  const plugin = plugins?.find((p) => p.name === name);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const subscribedSession = useRef<string>();
  const [browserBridgeAllowed, setBrowserBridgeAllowed] = useState(false);
  const socket = useAppStore((s) => s.socket);
  const refreshBrowserSessions = useAppStore((s) => s.refreshBrowserSessions);

  // Read the plugin detail endpoint because it includes the raw manifest. The public plugin-list
  // type intentionally stays compact; privileged bridge permissions are checked against the
  // manifest itself instead of being inferred from plugin name or merely trust:"node".
  useEffect(() => {
    let cancelled = false;
    setBrowserBridgeAllowed(false);
    if (!name || !plugin?.enabled) return () => { cancelled = true; };

    void (async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/plugins/${encodeURIComponent(name)}`);
        if (!response.ok) return;
        const json = await response.json() as {
          data?: {
            trust?: string;
            manifest?: { permissions?: unknown };
          };
        };
        const permissions = Array.isArray(json.data?.manifest?.permissions)
          ? json.data.manifest.permissions.map(String)
          : [];
        if (!cancelled) {
          setBrowserBridgeAllowed(json.data?.trust === "node" && permissions.includes("browser.frames"));
        }
      } catch {
        // Fail closed: a plugin without a verifiable permission never receives browser frames.
      }
    })();

    return () => { cancelled = true; };
  }, [name, plugin?.enabled]);

  useEffect(() => {
    if (!socket || !browserBridgeAllowed) return;

    const send = (message: unknown) => {
      iframeRef.current?.contentWindow?.postMessage(message, window.location.origin);
    };

    // The bridge only manages Socket.IO room membership. It deliberately does NOT stop the
    // underlying shared CDP stream; stream lifetime belongs to the plugin/browser tool itself.
    const unsubscribe = () => {
      const sessionId = subscribedSession.current;
      if (!sessionId) return;
      subscribedSession.current = undefined;
      socket.emit("browser:stream:leave", { sessionId });
    };

    const onFrame = (frame: {
      sessionId: string;
      data: string;
      format: string;
      timestamp?: string;
      width?: number;
      height?: number;
    }) => {
      if (frame.sessionId !== subscribedSession.current) return;
      send({ type: "ducki:browser:frame", payload: frame });
    };

    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data as { type?: string; requestId?: string; sessionId?: string } | undefined;
      if (!msg?.type?.startsWith("ducki:browser:")) return;

      try {
        if (msg.type === "ducki:browser:list-sessions") {
          await refreshBrowserSessions();
          send({
            type: "ducki:browser:response",
            requestId: msg.requestId,
            ok: true,
            payload: useAppStore.getState().browserSessions,
          });
          return;
        }

        if (msg.type === "ducki:browser:subscribe") {
          const sessionId = String(msg.sessionId ?? "").trim();
          if (!sessionId) throw new Error("sessionId is required");
          await refreshBrowserSessions();
          const known = useAppStore.getState().browserSessions.some((entry) => entry.tabId === sessionId);
          if (!known) throw new Error("Unknown browser session");
          unsubscribe();
          subscribedSession.current = sessionId;
          socket.emit("browser:stream:join", { sessionId });
          send({ type: "ducki:browser:response", requestId: msg.requestId, ok: true, payload: { sessionId } });
          return;
        }

        if (msg.type === "ducki:browser:unsubscribe") {
          unsubscribe();
          send({ type: "ducki:browser:response", requestId: msg.requestId, ok: true });
        }
      } catch (error) {
        send({
          type: "ducki:browser:response",
          requestId: msg.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    socket.on("browser:frame", onFrame);
    window.addEventListener("message", onMessage);
    return () => {
      socket.off("browser:frame", onFrame);
      window.removeEventListener("message", onMessage);
      unsubscribe();
    };
  }, [socket, browserBridgeAllowed, refreshBrowserSessions]);

  if (plugin && (!plugin.frontendPage || !plugin.enabled)) {
    return (
      <div className="page">
        <p className="text-sm text-muted-foreground">Dieses Plugin hat keine aktive Frontend-Seite.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-lg">{plugin?.icon ?? "🧩"}</span>
        <h1 className="text-sm font-semibold">{plugin?.name ?? name}</h1>
      </div>
      <iframe
        ref={iframeRef}
        title={`${name} Frontend`}
        src={pluginUiUrl(name, "frontend")}
        sandbox="allow-scripts allow-forms allow-same-origin"
        className="min-h-0 flex-1 w-full border-0 bg-background"
      />
    </div>
  );
}

export default PluginFrontendView;
