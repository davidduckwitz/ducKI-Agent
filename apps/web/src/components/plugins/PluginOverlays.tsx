/**
 * Plugin overlays
 *
 * Mounts every enabled plugin that ships `provides.overlayPage` as a transparent, full-window
 * iframe on top of the whole app - the surface a free-roaming companion, an ambient effect or a
 * HUD lives on. The host owns three bridges so the sandboxed overlay can still feel native:
 *
 *  1. Events IN   - the live app snapshot (agent working / connection state) is posted into each
 *                   overlay so it can react, exactly like the built-in pet reacts to the store.
 *  2. Notify OUT  - an overlay can push text back out ({type:"ducki:notify"}); we surface it as a
 *                   toast. That is the "pet can talk as a notification" channel.
 *  3. Click-through - a full-window iframe would swallow every click. The overlay reports the
 *                   rectangles it wants to be interactive (its pet's hitbox); we keep the iframe
 *                   `pointer-events:none` and flip it to `auto` only while the cursor is over one
 *                   of those rects, so the app underneath stays fully usable.
 *
 * Messages are trusted by source (the posting window must be one of our iframes), not by origin,
 * so it works whether the plugin API is same-origin or proxied.
 */

import { useEffect, useRef } from "react";
import { pluginUiUrl } from "../../lib/backendUrl";
import { usePlugins, overlayPlugins } from "../../lib/usePlugins";
import { useAppStore } from "../../lib/store";
import { toastManager, type ToastType } from "../../lib/toast";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TOAST_LEVELS: ToastType[] = ["success", "error", "info", "warning"];

export function PluginOverlays() {
  const { data: plugins } = usePlugins();
  const overlays = overlayPlugins(plugins);

  const isLoading = useAppStore((s) => s.isLoading);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const connected = useAppStore((s) => s.connected);

  // Live registries keyed by plugin name. Refs (not state) because the pointer loop and the
  // message handler read them every frame and must never trigger re-renders.
  const framesRef = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const hitboxesRef = useRef<Map<string, Rect[]>>(new Map());

  function inAnyHitbox(name: string, x: number, y: number): boolean {
    const rects = hitboxesRef.current.get(name) ?? [];
    return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  function appSnapshot() {
    const s = useAppStore.getState();
    return {
      type: "ducki:overlay:event" as const,
      event: "app" as const,
      isLoading: s.isLoading,
      agentStatus: s.agentStatus,
      connected: s.connected,
    };
  }

  // Broadcast the current app snapshot to every overlay whenever it changes.
  useEffect(() => {
    const snap = appSnapshot();
    for (const frame of framesRef.current.values()) frame.contentWindow?.postMessage(snap, "*");
  }, [isLoading, agentStatus, connected]);

  // Messages coming FROM the overlays.
  useEffect(() => {
    const findName = (src: MessageEventSource | null): string | undefined => {
      for (const [name, frame] of framesRef.current.entries()) {
        if (frame.contentWindow === src) return name;
      }
      return undefined;
    };

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; rects?: Rect[]; x?: number; y?: number; text?: string; level?: string; duration?: number };
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      const name = findName(e.source);
      if (!name) return; // only trust our own overlay iframes
      const frame = framesRef.current.get(name);

      switch (data.type) {
        case "ducki:overlay:ready":
          frame?.contentWindow?.postMessage(appSnapshot(), "*");
          break;
        case "ducki:overlay:hitboxes":
          hitboxesRef.current.set(name, Array.isArray(data.rects) ? data.rects : []);
          break;
        case "ducki:overlay:pointer":
          // The overlay is interactive right now and tells us where the cursor is; once it leaves
          // every hitbox we hand control back to the app by making the iframe click-through again.
          if (frame && typeof data.x === "number" && typeof data.y === "number" && !inAnyHitbox(name, data.x, data.y)) {
            frame.style.pointerEvents = "none";
          }
          break;
        case "ducki:notify": {
          const level = TOAST_LEVELS.includes(data.level as ToastType) ? (data.level as ToastType) : "info";
          if (typeof data.text === "string" && data.text.trim()) {
            toastManager.show(data.text, level, typeof data.duration === "number" ? data.duration : undefined);
          }
          break;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // While an iframe is click-through the host still gets pointermove; the instant the cursor
  // enters the overlay's reported hitbox we flip it interactive so the hover/drag can begin.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      for (const [name, frame] of framesRef.current.entries()) {
        if (frame.style.pointerEvents === "auto") continue;
        if (inAnyHitbox(name, e.clientX, e.clientY)) frame.style.pointerEvents = "auto";
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <>
      {overlays.map((p) => (
        <iframe
          key={p.name}
          title={`${p.name} overlay`}
          src={pluginUiUrl(p.name, "overlay")}
          ref={(el) => {
            if (el) {
              framesRef.current.set(p.name, el);
            } else {
              framesRef.current.delete(p.name);
              hitboxesRef.current.delete(p.name);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            background: "transparent",
            pointerEvents: "none",
            zIndex: 55,
          }}
        />
      ))}
    </>
  );
}

export default PluginOverlays;
