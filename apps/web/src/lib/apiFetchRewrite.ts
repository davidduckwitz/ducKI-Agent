/**
 * Global fetch rewrite so that EVERY `/api/...` request follows the configured
 * backend (local or remote), not just the ones that went through `api.ts`.
 *
 * Why a global interceptor instead of touching each call site: dozens of
 * components call `fetch("/api/...")` directly. In the desktop app and in local
 * browser mode that relative path is correct, but when the deployed web UI is
 * pointed at a remote backend those raw calls used to stay on the page origin
 * (the landing domain) and fail. Rewriting in one place fixes them all without
 * changing any existing call site — and it is a no-op whenever the resolved API
 * base is the relative "/api" (local browser mode), so old behaviour is kept.
 */

import { getApiBaseUrl } from "./backendUrl";

/**
 * Pure resolver (unit-testable). Rewrites a same-origin `/api[...]` URL onto
 * `apiBase`; returns null when the URL should be left untouched.
 *
 * @param rawUrl   the request URL (relative like "/api/x" or absolute)
 * @param origin   the page origin (window.location.origin)
 * @param apiBase  result of getApiBaseUrl() — e.g. "/api" or "http://host:3001/api"
 */
export function resolveApiUrl(rawUrl: string, origin: string, apiBase: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, origin);
  } catch {
    return null;
  }
  // Only touch requests aimed at THIS origin's /api path. Absolute URLs to other
  // hosts (including an already-remote backend) pass through unchanged.
  if (parsed.origin !== origin) return null;
  if (parsed.pathname !== "/api" && !parsed.pathname.startsWith("/api/")) return null;

  const rest = parsed.pathname.slice("/api".length); // "" or "/foo/bar"
  const rewritten = `${apiBase}${rest}${parsed.search}${parsed.hash}`;
  // No-op guard: if nothing actually changed, signal "leave as-is".
  return rewritten === rawUrl ? null : rewritten;
}

let installed = false;

/** Install the global fetch rewrite once. Safe to call multiple times. */
export function installApiFetchRewrite(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  const origin = window.location.origin;

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const apiBase = getApiBaseUrl(); // read per-call so config changes apply live

      if (typeof input === "string") {
        const next = resolveApiUrl(input, origin, apiBase);
        return originalFetch(next ?? input, init);
      }
      if (input instanceof URL) {
        const next = resolveApiUrl(input.href, origin, apiBase);
        return originalFetch(next ?? input, init);
      }
      if (input instanceof Request) {
        const next = resolveApiUrl(input.url, origin, apiBase);
        // Preserve method/headers/body by cloning the Request onto the new URL.
        return originalFetch(next ? new Request(next, input) : input, init);
      }
    } catch {
      // fall through to the original call on any unexpected shape
    }
    return originalFetch(input as RequestInfo, init);
  };
}
