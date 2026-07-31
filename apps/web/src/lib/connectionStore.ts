import { create } from "zustand";

/**
 * Connection lifecycle, kept separate from the socket itself.
 *
 * "connected" used to mean nothing more than "the WebSocket opened", which is not the
 * same as "the server is usable" - so every query fired the moment the page mounted and
 * kept firing while the backend was gone. `ready` is set only after the server answered
 * the handshake, and it is the single gate every recurring request checks.
 */
export type ConnectionStatus = "connecting" | "ready" | "lost";

interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed connection attempts; reset on a successful handshake. */
  attempt: number;
  lastError?: string;
  /** Protocol version reported by the server in server:hello. */
  serverProtocolVersion?: number;
  readyAt?: string;

  markConnecting: () => void;
  markReady: (serverProtocolVersion?: number) => void;
  markLost: (reason?: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "connecting",
  attempt: 0,

  markConnecting: () =>
    set((s) => (s.status === "connecting" ? s : { status: "connecting", lastError: undefined })),

  markReady: (serverProtocolVersion) =>
    set({
      status: "ready",
      attempt: 0,
      lastError: undefined,
      serverProtocolVersion,
      readyAt: new Date().toISOString(),
    }),

  markLost: (reason) =>
    set((s) => ({
      status: "lost",
      attempt: s.attempt + 1,
      lastError: reason ?? s.lastError,
    })),
}));

/** Non-reactive read for code outside React (query wrappers, socket callbacks). */
export function isConnectionReady(): boolean {
  return useConnectionStore.getState().status === "ready";
}
