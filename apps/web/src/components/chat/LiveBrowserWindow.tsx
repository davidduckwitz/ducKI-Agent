import { useCallback, useEffect, useRef } from "react";
import { X, Loader2, Radio } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { useLiveBrowserStore, type LiveBrowserWindowState } from "../../lib/liveBrowserStore";

function mimeTypeForFormat(format: string | undefined): string {
  if (format === "png") return "image/png";
  return "image/jpeg";
}

/**
 * One floating, draggable, resizable window showing a live CDP screencast of a browser
 * session (action=stream_start). Frames arrive over the "browser:frame" socket event into
 * liveBrowserStore, keyed by sessionId - this component just joins that session's room on
 * mount and renders whatever frame is currently buffered for it.
 */
function LiveBrowserWindow({ win }: { win: LiveBrowserWindowState }) {
  const socket = useAppStore((s) => s.socket);
  const controlBrowserSession = useAppStore((s) => s.controlBrowserSession);
  const closeWindow = useLiveBrowserStore((s) => s.closeWindow);
  const moveWindow = useLiveBrowserStore((s) => s.moveWindow);
  const resizeWindow = useLiveBrowserStore((s) => s.resizeWindow);
  const bringToFront = useLiveBrowserStore((s) => s.bringToFront);
  const order = useLiveBrowserStore((s) => s.order);
  const zIndex = 1000 + Math.max(0, order.indexOf(win.sessionId));

  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);

  // Join the session's stream room and (re)start the CDP screencast on mount; leave/stop on
  // unmount. A brand-new browser session takes a moment to accept CDP commands, so
  // stream_start is fired immediately but its own failure is non-fatal - the window just
  // stays in "connecting" state, which is an accurate reflection of reality.
  useEffect(() => {
    socket?.emit("browser:stream:join", { sessionId: win.sessionId });
    void controlBrowserSession(win.sessionId, "stream_start", {});
    return () => {
      socket?.emit("browser:stream:leave", { sessionId: win.sessionId });
      void controlBrowserSession(win.sessionId, "stream_stop", {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.sessionId]);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      bringToFront(win.sessionId);
      dragRef.current = { startX: e.clientX, startY: e.clientY, originX: win.x, originY: win.y };
      const onMove = (moveEvent: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = moveEvent.clientX - dragRef.current.startX;
        const dy = moveEvent.clientY - dragRef.current.startY;
        moveWindow(win.sessionId, Math.max(0, dragRef.current.originX + dx), Math.max(0, dragRef.current.originY + dy));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [win.sessionId, win.x, win.y, bringToFront, moveWindow]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      resizeRef.current = { startX: e.clientX, startY: e.clientY, startWidth: win.width, startHeight: win.height };
      const onMove = (moveEvent: MouseEvent) => {
        if (!resizeRef.current) return;
        const dx = moveEvent.clientX - resizeRef.current.startX;
        const dy = moveEvent.clientY - resizeRef.current.startY;
        resizeWindow(win.sessionId, resizeRef.current.startWidth + dx, resizeRef.current.startHeight + dy);
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [win.sessionId, win.width, win.height, resizeWindow]
  );

  const frameSrc = win.frame ? `data:${mimeTypeForFormat(win.frame.format)};base64,${win.frame.data}` : undefined;

  return (
    <div
      className="fixed flex flex-col overflow-hidden rounded-lg border border-cyan-500/40 bg-black shadow-2xl"
      style={{ left: win.x, top: win.y, width: win.width, height: win.height, zIndex }}
      onMouseDown={() => bringToFront(win.sessionId)}
    >
      <div
        className="flex shrink-0 cursor-move select-none items-center justify-between gap-2 bg-cyan-500/10 px-2 py-1.5 border-b border-cyan-500/20"
        onMouseDown={handleHeaderMouseDown}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Radio className={`h-3 w-3 shrink-0 ${win.connected ? "text-cyan-400 animate-pulse" : "text-muted-foreground"}`} />
          <span className="truncate text-xs font-medium text-cyan-200">{win.title}</span>
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => closeWindow(win.sessionId)}
          className="shrink-0 rounded p-0.5 text-cyan-300 hover:bg-cyan-500/20"
          title="Live-Ansicht schliessen"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-black/60">
        {frameSrc ? (
          <img src={frameSrc} alt="Live browser" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <div className="flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Verbinde...
            </div>
          </div>
        )}
      </div>

      <div
        className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
        onMouseDown={handleResizeMouseDown}
        title="Groesse aendern"
      >
        <div className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 border-b-2 border-r-2 border-cyan-400/60" />
      </div>
    </div>
  );
}

/** Mounted once, globally (see App.tsx) - renders every currently-open live browser window. */
export function LiveBrowserWindowsLayer() {
  const windows = useLiveBrowserStore((s) => s.windows);
  const order = useLiveBrowserStore((s) => s.order);

  if (order.length === 0) return null;

  return (
    <>
      {order.map((sessionId) => {
        const win = windows[sessionId];
        if (!win) return null;
        return <LiveBrowserWindow key={sessionId} win={win} />;
      })}
    </>
  );
}
