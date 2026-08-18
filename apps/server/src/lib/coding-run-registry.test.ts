import { describe, it, expect, vi } from "vitest";
import { registerCodingRun, unregisterCodingRun, stopCodingRun } from "./coding-run-registry";

function fakeCodingAgent() {
  return { stop: vi.fn() } as any;
}

describe("coding-run-registry", () => {
  it("stopCodingRun returns false and does nothing for an unknown conversation", () => {
    expect(stopCodingRun(999999)).toBe(false);
  });

  it("registers a run, stops it, and reports true", () => {
    const agent = fakeCodingAgent();
    registerCodingRun(1, agent);
    try {
      expect(stopCodingRun(1)).toBe(true);
      expect(agent.stop).toHaveBeenCalledTimes(1);
    } finally {
      unregisterCodingRun(1);
    }
  });

  it("stopCodingRun returns false after unregistering", () => {
    const agent = fakeCodingAgent();
    registerCodingRun(2, agent);
    unregisterCodingRun(2);
    expect(stopCodingRun(2)).toBe(false);
    expect(agent.stop).not.toHaveBeenCalled();
  });
});
