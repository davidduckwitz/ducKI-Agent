import { describe, it, expect, vi } from "vitest";
import {
  registerCodingRun,
  unregisterCodingRun,
  stopCodingRun,
  acquireCodingRunLock,
  releaseCodingRunLock,
  isCodingRunBusy,
  isCodingRunStreaming,
  streamingCodingRunIds,
  markChatRun,
  unmarkChatRun,
  isChatRunActive,
} from "./coding-run-registry";

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

  it("isCodingRunBusy covers the lock phase and the running phase", () => {
    expect(isCodingRunBusy(10)).toBe(false);
    expect(acquireCodingRunLock(10)).toBe(true);
    try {
      expect(isCodingRunBusy(10)).toBe(true);
      // Locked but not started yet: validation may still fail without a closing chat event.
      expect(isCodingRunStreaming(10)).toBe(false);
      registerCodingRun(10, fakeCodingAgent(), { streamsToChat: true });
      expect(isCodingRunStreaming(10)).toBe(true);
      expect(streamingCodingRunIds()).toContain(10);
    } finally {
      unregisterCodingRun(10);
      releaseCodingRunLock(10);
    }
    expect(isCodingRunBusy(10)).toBe(false);
    expect(isCodingRunStreaming(10)).toBe(false);
    expect(streamingCodingRunIds()).not.toContain(10);
  });

  it("plugin-style runs (no streamsToChat) are busy but never reported as streaming", () => {
    registerCodingRun(11, fakeCodingAgent());
    try {
      expect(isCodingRunBusy(11)).toBe(true);
      expect(isCodingRunStreaming(11)).toBe(false);
      expect(streamingCodingRunIds()).not.toContain(11);
    } finally {
      unregisterCodingRun(11);
    }
  });

  it("tracks WebSocket chat runs per conversation", () => {
    expect(isChatRunActive(12)).toBe(false);
    markChatRun(12);
    expect(isChatRunActive(12)).toBe(true);
    expect(isChatRunActive(13)).toBe(false);
    unmarkChatRun(12);
    expect(isChatRunActive(12)).toBe(false);
  });
});
