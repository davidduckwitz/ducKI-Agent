import { describe, it, expect } from "vitest";
import { MCPRegistry } from "./registry.js";

describe("MCPRegistry", () => {
  it("returns not found when no server has tool", async () => {
    const registry = new MCPRegistry();
    const result = await registry.callTool("missing-tool", {});
    expect(result.success).toBe(false);
    expect(String(result.error ?? "")).toMatch(/not found/i);
    await registry.shutdown();
  });

  it("accepts disabled server config", async () => {
    const registry = new MCPRegistry();
    await registry.registerServer({
      id: "disabled",
      name: "Disabled",
      url: "http://127.0.0.1:65535",
      enabled: false,
    });
    const status = registry.getServerStatus();
    expect(status.length).toBe(1);
    expect(status[0]?.enabled).toBe(false);
    expect(status[0]?.connected).toBe(false);
    await registry.shutdown();
  });
});
