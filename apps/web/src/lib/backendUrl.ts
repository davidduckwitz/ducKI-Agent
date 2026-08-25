/**
 * Single source of truth for "where is the backend".
 *
 * There used to be two implementations of this - `getBaseUrl()` in api.ts and
 * `getBackendUrl()` in useBackendConfig.ts - which could disagree: the Settings
 * "test connection" button probed one URL while the app talked to the other. Worse,
 * neither of them was consulted for the WebSocket, so a browser client configured for
 * a remote backend sent its HTTP requests to the remote host but kept the socket on
 * its own origin.
 */

export interface BackendConfig {
  type: "local" | "remote";
  url?: string;
  port?: number;
}

export const BACKEND_CONFIG_KEY = "backend-config";
export const DEFAULT_BACKEND_CONFIG: BackendConfig = { type: "local", port: 3001 };
const DEFAULT_PORT = 3001;

/**
 * Tauri v2 always injects `__TAURI_INTERNALS__`, regardless of the `withGlobalTauri`
 * config (which only controls `window.__TAURI__`). Detecting via that works both in
 * `tauri dev` and in packaged builds.
 */
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  const isTauri = "__TAURI_INTERNALS__" in window;
  const isElectron = Boolean((window as unknown as { electron?: unknown }).electron);
  return isTauri || isElectron;
}

/** Read synchronously - a value read in an effect arrives one render too late. */
export function readBackendConfig(): BackendConfig {
  if (typeof window === "undefined") return DEFAULT_BACKEND_CONFIG;
  try {
    const raw = window.localStorage.getItem(BACKEND_CONFIG_KEY);
    if (!raw) return DEFAULT_BACKEND_CONFIG;
    const parsed = JSON.parse(raw) as Partial<BackendConfig> | null;
    if (!parsed || (parsed.type !== "local" && parsed.type !== "remote")) return DEFAULT_BACKEND_CONFIG;
    return {
      type: parsed.type,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      port: Number.isFinite(Number(parsed.port)) ? Number(parsed.port) : DEFAULT_PORT,
    };
  } catch {
    return DEFAULT_BACKEND_CONFIG;
  }
}

export function writeBackendConfig(config: BackendConfig): void {
  window.localStorage.setItem(BACKEND_CONFIG_KEY, JSON.stringify(config));
}

function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  // A URL without a scheme ("127.0.0.1:3001") is parsed by the browser as
  // "scheme:path", which breaks fetch and socket.io. Default to http:// so a
  // host:port entry Just Works. (Enter an explicit https:// for TLS backends.)
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u = `http://${u}`;
  }
  return u;
}

/**
 * Base URL for REST calls. Recomputed on every call (not cached) so a change made in
 * the Settings UI takes effect immediately, even within the same tab.
 *
 * Browser + local returns the relative "/api" so the Vite/reverse proxy handles it;
 * everything else needs an absolute origin.
 */
export function getApiBaseUrl(config: BackendConfig = readBackendConfig()): string {
  if (config.type === "remote" && config.url) {
    return `${normalizeRemote(config.url)}/api`;
  }
  if (isDesktopApp()) {
    return `http://localhost:${config.port ?? DEFAULT_PORT}/api`;
  }
  return "/api";
}

/**
 * Absolute (or same-origin) URL for a plugin's embedded UI page. Must be built from the
 * resolved API base, not a hardcoded "/api/…": in the desktop app a relative "/api/…" iframe
 * src resolves against the Tauri app origin (tauri://localhost) and loads the bundled SPA
 * instead of the plugin page — the iframe then shows the whole app, recursively. Going through
 * getApiBaseUrl() yields the agent origin (e.g. http://localhost:3001/api) in that case, and a
 * proxied "/api/…" in the browser.
 *
 * Page URLs intentionally end with a slash. Plugin pages commonly reference sibling assets
 * relatively (e.g. <script src="app.js">). Without the trailing slash a browser resolves such
 * assets one level too high (/ui/app.js instead of /ui/frontend/app.js).
 */
export function pluginUiUrl(name: string, kind: "settings" | "widget" | "frontend" | "overlay", widgetId?: string): string {
  if (kind === "widget" && widgetId) {
    return `${getApiBaseUrl()}/plugins/${encodeURIComponent(name)}/ui/widgets/${encodeURIComponent(widgetId)}/`;
  }
  return `${getApiBaseUrl()}/plugins/${encodeURIComponent(name)}/ui/${kind}/`;
}

/**
 * Origin for the Socket.IO connection. `undefined` means "use the current page origin",
 * which is what socket.io does when passed no URL.
 */
export function getSocketUrl(config: BackendConfig = readBackendConfig()): string | undefined {
  // Remote applies in the browser too - that is the bug this function fixes.
  if (config.type === "remote" && config.url) {
    return normalizeRemote(config.url);
  }
  if (isDesktopApp()) {
    return `http://localhost:${config.port ?? DEFAULT_PORT}`;
  }
  if (import.meta.env.DEV) {
    // Fall back to the current page origin (undefined) rather than localhost:3001, so
    // the socket rides the Vite proxy's /socket.io (ws:true) route. This keeps it working
    // when the dev server is reached from another device (e.g. over Tailscale), where
    // "localhost" would resolve to that device instead of the server.
    return import.meta.env["VITE_SOCKET_URL"] as string | undefined;
  }
  return undefined;
}

/**
 * Health probe URL. Goes through the API base rather than the bare origin: in the
 * browser the dev proxy only forwards "/api", so a plain "/health" would hit Vite and
 * come back as index.html instead of the server. The server exposes the handler under
 * both paths.
 */
export function getHealthUrl(config: BackendConfig = readBackendConfig()): string {
  return `${getApiBaseUrl(config)}/health`;
}
