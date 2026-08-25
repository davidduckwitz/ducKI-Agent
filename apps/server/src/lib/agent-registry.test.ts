import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "./agent-registry.js";

describe("AgentRegistry stop controls", () => {
  it("stops a registered HTTP agent and removes the handler on unregister", () => {
    const registry = new AgentRegistry();
    const stop = vi.fn();
    const id = registry.register({ source: "chat_http", label: "Erpel:test" }, { stop });

    expect(registry.stop(id)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();

    registry.unregister(id);
    expect(registry.stop(id)).toBe(false);
  });

  it("does not claim that a run without a stop control was stopped", () => {
    const registry = new AgentRegistry();
    const id = registry.register({ source: "task_run" });
    expect(registry.stop(id)).toBe(false);
  });
});
