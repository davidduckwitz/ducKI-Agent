import { create } from "zustand";

export interface LiveBrowserFrame {
  data: string;
  format: string;
  timestamp: string;
}

export interface LiveBrowserWindowState {
  sessionId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frame?: LiveBrowserFrame;
  /** Set once a frame has arrived at least once, so the window can show "connecting..."
   *  instead of a blank panel before the CDP screencast produces its first frame. */
  connected: boolean;
}

interface LiveBrowserState {
  windows: Record<string, LiveBrowserWindowState>;
  /** Render (z-)order, back to front. */
  order: string[];
  openWindow: (sessionId: string, title?: string) => void;
  closeWindow: (sessionId: string) => void;
  moveWindow: (sessionId: string, x: number, y: number) => void;
  resizeWindow: (sessionId: string, width: number, height: number) => void;
  receiveFrame: (frame: { sessionId: string; data: string; format: string; timestamp: string }) => void;
  bringToFront: (sessionId: string) => void;
}

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 380;

export const useLiveBrowserStore = create<LiveBrowserState>((set, get) => ({
  windows: {},
  order: [],

  openWindow: (sessionId, title) => {
    if (get().windows[sessionId]) {
      get().bringToFront(sessionId);
      return;
    }
    const count = Object.keys(get().windows).length;
    set((s) => ({
      windows: {
        ...s.windows,
        [sessionId]: {
          sessionId,
          title: title ?? "Live Browser",
          // Cascade new windows so they don't stack exactly on top of each other.
          x: 96 + (count % 5) * 32,
          y: 96 + (count % 5) * 32,
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          connected: false,
        },
      },
      order: [...s.order, sessionId],
    }));
  },

  closeWindow: (sessionId) => {
    set((s) => {
      const rest = { ...s.windows };
      delete rest[sessionId];
      return { windows: rest, order: s.order.filter((id) => id !== sessionId) };
    });
  },

  moveWindow: (sessionId, x, y) => {
    set((s) => {
      const win = s.windows[sessionId];
      if (!win) return s;
      return { windows: { ...s.windows, [sessionId]: { ...win, x, y } } };
    });
  },

  resizeWindow: (sessionId, width, height) => {
    set((s) => {
      const win = s.windows[sessionId];
      if (!win) return s;
      return {
        windows: {
          ...s.windows,
          [sessionId]: { ...win, width: Math.max(280, width), height: Math.max(200, height) },
        },
      };
    });
  },

  receiveFrame: (frame) => {
    set((s) => {
      const win = s.windows[frame.sessionId];
      if (!win) return s; // No open window for this session - drop the frame, nothing to show it in.
      return {
        windows: {
          ...s.windows,
          [frame.sessionId]: {
            ...win,
            connected: true,
            frame: { data: frame.data, format: frame.format, timestamp: frame.timestamp },
          },
        },
      };
    });
  },

  bringToFront: (sessionId) => {
    set((s) => {
      if (!s.windows[sessionId]) return s;
      if (s.order[s.order.length - 1] === sessionId) return s;
      return { order: [...s.order.filter((id) => id !== sessionId), sessionId] };
    });
  },
}));
