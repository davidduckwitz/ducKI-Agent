import type { ToolResult, ToolExecutor } from "@ducki/shared";

/**
 * Config-driven "data source" tools: a declarative way to expose a keyless public API
 * (weather, news, FX, ...) as a first-class agent tool WITHOUT writing per-source code.
 * A plugin ships a JSON config; this generic executor does the fetch(es), extracts values
 * across sequential steps, shapes a result, and caches it. This is the reference pattern
 * for the plugin system's "data-source" tool type - fast and cheap because the model makes
 * ONE tool call instead of chaining raw http requests itself.
 *
 * The low-level helpers (fetchJson, TtlCache, hostAllowed, interpolate, getPath) are also
 * reused by hand-written tools (e.g. the weather tool) so both paths share one, tested base.
 */

// ---------------------------------------------------------------------------
// Shared low-level helpers (also imported by bespoke tools)
// ---------------------------------------------------------------------------

export async function fetchJson(url: string, opts?: { timeoutMs?: number; method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: opts?.method ?? "GET",
      headers: { Accept: "application/json", ...(opts?.headers ?? {}) },
      body: opts?.body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Minimal TTL cache. Kept tiny and dependency-free; entries are pruned lazily on read. */
export class TtlCache<T = unknown> {
  private readonly store = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T): void {
    this.store.set(key, { at: Date.now(), value });
  }
}

/** True when `url`'s host is permitted. An empty/undefined allowlist permits any host. */
export function hostAllowed(url: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.map((h) => h.toLowerCase()).includes(host);
  } catch {
    return false;
  }
}

/** Read a dot-path (with numeric indices) out of a nested object: "results.0.latitude". */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const segment of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(segment);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Replace `{var}` / `{a.b.0}` placeholders from `vars`. `encode` URL-encodes each value. */
export function interpolate(template: string, vars: Record<string, unknown>, encode = false): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, key: string) => {
    const value = getPath(vars, key);
    const str = value == null ? "" : String(value);
    return encode ? encodeURIComponent(str) : str;
  });
}

// ---------------------------------------------------------------------------
// Declarative data-source tool
// ---------------------------------------------------------------------------

export interface DataSourceRequestStep {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** URL with `{param}` placeholders; values are URL-encoded. */
  urlTemplate: string;
  headers?: Record<string, string>;
  /** Body template for write methods; interpolated (not URL-encoded). */
  bodyTemplate?: string;
  /** Extract values from THIS step's JSON response into vars for later steps / the summary. */
  extract?: Record<string, string>;
}

export interface DataSourceParamSpec {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

export interface DataSourceToolConfig {
  name: string;
  description: string;
  params?: Record<string, DataSourceParamSpec>;
  /** Default values for params (used when the caller omits them). */
  defaults?: Record<string, unknown>;
  /** One or more sequential requests. Later steps may use vars extracted by earlier ones. */
  requests: DataSourceRequestStep[];
  /** Shape the final result from the LAST response. */
  response?: { pick?: string; summaryTemplate?: string };
  cacheTtlMs?: number;
  /** Required host allowlist for a plugin data source (enforced when non-empty). */
  allowedHosts?: string[];
  timeoutMs?: number;
}

export function createDataSourceTool(config: DataSourceToolConfig): ToolExecutor {
  const cache = new TtlCache<unknown>(config.cacheTtlMs ?? 600_000);
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(config.params ?? {})) {
    properties[key] = { type: spec.type, description: spec.description };
  }
  const required = Object.entries(config.params ?? {})
    .filter(([, s]) => s.required)
    .map(([k]) => k);

  return {
    name: config.name,
    description: config.description,
    definition: {
      name: config.name,
      description: config.description,
      parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const vars: Record<string, unknown> = { ...(config.defaults ?? {}), ...input };

      for (const key of required) {
        if (vars[key] === undefined || vars[key] === "") {
          return { success: false, data: null, error: `Missing required parameter '${key}' for ${config.name}` };
        }
      }

      const cacheKey = JSON.stringify(Object.fromEntries(Object.keys(config.params ?? {}).map((k) => [k, vars[k]])));
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return { success: true, data: { ...(cached as object), cached: true } };
      }

      try {
        let lastJson: unknown = undefined;
        for (const step of config.requests) {
          const url = interpolate(step.urlTemplate, vars, true);
          if (!hostAllowed(url, config.allowedHosts)) {
            return { success: false, data: null, error: `Host '${new URL(url).hostname}' not in allowedHosts for ${config.name}` };
          }
          const headers = step.headers
            ? Object.fromEntries(Object.entries(step.headers).map(([k, v]) => [k, interpolate(v, vars)]))
            : undefined;
          const body = step.bodyTemplate ? interpolate(step.bodyTemplate, vars) : undefined;
          lastJson = await fetchJson(url, { method: step.method ?? "GET", headers, body, timeoutMs: config.timeoutMs });
          if (step.extract) {
            for (const [name, path] of Object.entries(step.extract)) {
              vars[name] = getPath(lastJson, path);
            }
          }
        }

        const picked = config.response?.pick ? getPath(lastJson, config.response.pick) : lastJson;
        const summaryContext = { ...vars, ...(picked && typeof picked === "object" && !Array.isArray(picked) ? (picked as Record<string, unknown>) : {}) };
        const summary = config.response?.summaryTemplate ? interpolate(config.response.summaryTemplate, summaryContext) : undefined;

        const data = { source: config.name, ...(summary ? { summary } : {}), result: picked };
        cache.set(cacheKey, data);
        return { success: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = /abort/i.test(message) ? " (timeout - the service was slow, try again)" : "";
        return { success: false, data: null, error: `${config.name} lookup failed: ${message}${hint}` };
      }
    },
  };
}
