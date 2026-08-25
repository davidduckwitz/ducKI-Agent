import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { pluginUiUrl } from "../../lib/backendUrl";
import { usePlugins } from "../../lib/usePlugins";
import { useAppStore } from "../../lib/store";

/** Full-page host for a plugin mini-app plus a narrow postMessage bridge for trusted Node plugins. */
export function PluginFrontendView() {
  const { name = "" } = useParams();
  const { data: plugins } = usePlugins();
  const plugin = plugins?.find((p) => p.name === name);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const subscribedSession = useRef<string>();
  const socket = useAppStore((s) => s.socket);
  const browserSessions = useAppStore((s) => s.browserSessions);
  const refreshBrowserSessions = useAppStore((s) => s.refreshBrowserSessions);
  const controlBrowserSession = useAppStore((s) => s.controlBrowserSession);

  useEffect(() => {
    if (!socket || plugin?.trust !== "node") return;

    const send = (message: unknown) => iframeRef.current?.contentWindow?.postMessage(message, window.location.origin);
    const unsubscribe = async () => {
      const sessionId = subscribedSession.current;
      if (!sessionId) return;
      subscribedSession.current = undefined;
      socket.emit("browser:stream:leave", { sessionId });
      await controlBrowserSession(sessionId, "stream_stop");
    };

    const onFrame = (frame: { sessionId: string; data: string; format: string; timestamp?: string; width?: number; height?: number }) => {
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
          send({ type: "ducki:browser:response", requestId: msg.requestId, ok: true, payload: useAppStore.getState().browserSessions });
          return;
        }
        if (msg.type === "ducki:browser:subscribe") {
          const sessionId = String(msg.sessionId ?? "");
          await refreshBrowserSessions();
          const known = useAppStore.getState().browserSessions.some((entry) => entry.tabId === sessionId);
          if (!known) throw new Error("Unknown browser session");
          await unsubscribe();
          subscribedSession.current = sessionId;
          socket.emit("browser:stream:join", { sessionId });
          await controlBrowserSession(sessionId, "stream_start");
          send({ type: "ducki:browser:response", requestId: msg.requestId, ok: true, payload: { sessionId } });
          return;
        }
        if (msg.type === "ducki:browser:unsubscribe") {
          await unsubscribe();
          send({ type: "ducki:browser:response", requestId: msg.requestId, ok: true });
        }
      } catch (error) {
        send({ type: "ducki:browser:response", requestId: msg.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("browser:frame", onFrame);
    window.addEventListener("message", onMessage);
    return () => {
      socket.off("browser:frame", onFrame);
      window.removeEventListener("message", onMessage);
      void unsubscribe();
    };
  }, [socket, plugin?.trust, refreshBrowserSessions, controlBrowserSession, browserSessions]);

  if (plugin && (!plugin.frontendPage || !plugin.enabled)) {
    return <div className="page"><p className="text-sm text-muted-foreground">Dieses Plugin hat keine aktive Frontend-Seite.</p></div>;
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
