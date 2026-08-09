import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createDataSourceTool,
  getPath,
  interpolate,
  hostAllowed,
  TtlCache,
} from "../src/data-source-tool.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data-source helpers", () => {
  it("getPath reads nested keys and array indices", () => {
    const obj = { results: [{ latitude: 50.5, name: "Fulda" }] };
    expect(getPath(obj, "results.0.latitude")).toBe(50.5);
    expect(getPath(obj, "results.0.name")).toBe("Fulda");
    expect(getPath(obj, "results.1.name")).toBeUndefined();
    expect(getPath(obj, "missing.path")).toBeUndefined();
  });

  it("interpolate replaces placeholders and URL-encodes when asked", () => {
    expect(interpolate("Hello {name}", { name: "World" })).toBe("Hello World");
    expect(interpolate("q={q}", { q: "a b&c" }, true)).toBe("q=a%20b%26c");
    expect(interpolate("lat={geo.0.lat}", { geo: [{ lat: 9.5 }] })).toBe("lat=9.5");
  });

  it("hostAllowed enforces a non-empty allowlist and permits when empty", () => {
    expect(hostAllowed("https://api.example.com/x", ["api.example.com"])).toBe(true);
    expect(hostAllowed("https://evil.com/x", ["api.example.com"])).toBe(false);
    expect(hostAllowed("https://anything.com", [])).toBe(true);
    expect(hostAllowed("https://anything.com", undefined)).toBe(true);
  });

  it("TtlCache returns fresh entries and expires stale ones", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("k", 42);
    expect(cache.get("k")).toBe(42);
    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(cache.get("k")).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("createDataSourceTool", () => {
  it("runs a two-step request, extracts vars, picks + summarizes, and caches", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("geocode")) {
        return { ok: true, json: async () => ({ results: [{ latitude: 50.55, longitude: 9.68 }] }) } as Response;
      }
      return { ok: true, json: async () => ({ current: { temp: 21 } }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDataSourceTool({
      name: "demo_weather",
      description: "demo",
      params: { location: { type: "string", required: true } },
      requests: [
        { urlTemplate: "https://api.example.com/geocode?name={location}", extract: { lat: "results.0.latitude", lon: "results.0.longitude" } },
        { urlTemplate: "https://api.example.com/forecast?lat={lat}&lon={lon}" },
      ],
      response: { pick: "current", summaryTemplate: "Temp in {location}: {temp}°C" },
      allowedHosts: ["api.example.com"],
      cacheTtlMs: 60000,
    });

    const r1 = await tool.execute({ location: "Fulda" });
    expect(r1.success).toBe(true);
    expect((r1.data as { summary: string }).summary).toBe("Temp in Fulda: 21°C");
    expect((r1.data as { result: { temp: number } }).result.temp).toBe(21);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // second geocode URL used the extracted lat/lon
    expect(fetchMock.mock.calls[1]?.[0]).toContain("lat=50.55");

    const r2 = await tool.execute({ location: "Fulda" });
    expect((r2.data as { cached?: boolean }).cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // served from cache, no new fetch
  });

  it("rejects a missing required parameter", async () => {
    const tool = createDataSourceTool({
      name: "demo",
      description: "d",
      params: { q: { type: "string", required: true } },
      requests: [{ urlTemplate: "https://api.example.com/s?q={q}" }],
    });
    const r = await tool.execute({});
    expect(r.success).toBe(false);
    expect(r.error).toContain("Missing required parameter 'q'");
  });

  it("blocks a host outside allowedHosts", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = createDataSourceTool({
      name: "demo",
      description: "d",
      requests: [{ urlTemplate: "https://evil.com/x" }],
      allowedHosts: ["api.example.com"],
    });
    const r = await tool.execute({});
    expect(r.success).toBe(false);
    expect(r.error).toContain("not in allowedHosts");
  });
});
