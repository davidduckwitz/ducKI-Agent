import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The suite runs in vitest's node environment (no jsdom in this repo), so provide the
// two browser globals backendUrl actually touches rather than pulling in a DOM package.
const memoryStorage = (() => {
  let data: Record<string, string> = {};
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    clear: () => {
      data = {};
    },
  };
})();

(globalThis as Record<string, unknown>)["window"] = { localStorage: memoryStorage };

const { BACKEND_CONFIG_KEY, getApiBaseUrl, getHealthUrl, getSocketUrl, readBackendConfig } = await import(
  "./backendUrl"
);
type BackendConfig = import("./backendUrl").BackendConfig;

/**
 * There used to be two copies of this logic (api.ts and useBackendConfig.ts) and neither
 * was consulted for the socket, so "remote" worked for HTTP but silently kept the
 * WebSocket on the local origin.
 */
describe("backendUrl", () => {
  const setDesktop = (on: boolean) => {
    if (on) (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    else delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  };

  const store = (config: BackendConfig) =>
    window.localStorage.setItem(BACKEND_CONFIG_KEY, JSON.stringify(config));

  beforeEach(() => {
    window.localStorage.clear();
    setDesktop(false);
  });

  afterEach(() => {
    setDesktop(false);
  });

  it("falls back to the proxied /api in a browser without config", () => {
    expect(getApiBaseUrl()).toBe("/api");
  });

  it("uses an absolute localhost origin on desktop", () => {
    setDesktop(true);
    store({ type: "local", port: 4123 });
    expect(getApiBaseUrl()).toBe("http://localhost:4123");
    expect(getSocketUrl()).toBe("http://localhost:4123");
  });

  it("routes HTTP and socket to the same remote host", () => {
    store({ type: "remote", url: "https://agent.example.com/" });
    // Trailing slash normalised, /api appended for REST, bare origin for the socket.
    expect(getApiBaseUrl()).toBe("https://agent.example.com/api");
    expect(getSocketUrl()).toBe("https://agent.example.com");
  });

  it("applies the remote host in the browser too", () => {
    setDesktop(false);
    store({ type: "remote", url: "http://192.168.1.50:3001" });
    // The regression this guards: the socket used to stay on the page origin here.
    expect(getSocketUrl()).toBe("http://192.168.1.50:3001");
  });

  it("prepends http:// when the remote url has no scheme", () => {
    store({ type: "remote", url: "127.0.0.1:3001" });
    expect(getApiBaseUrl()).toBe("http://127.0.0.1:3001/api");
    expect(getSocketUrl()).toBe("http://127.0.0.1:3001");
  });

  it("probes health through the API base so the dev proxy forwards it", () => {
    expect(getHealthUrl()).toBe("/api/health");
    store({ type: "remote", url: "https://agent.example.com" });
    expect(getHealthUrl()).toBe("https://agent.example.com/api/health");
  });

  it("ignores a corrupt stored config instead of throwing", () => {
    window.localStorage.setItem(BACKEND_CONFIG_KEY, "{not json");
    expect(readBackendConfig()).toEqual({ type: "local", port: 3001 });
    expect(getApiBaseUrl()).toBe("/api");
  });
});
