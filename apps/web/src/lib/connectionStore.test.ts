import { beforeEach, describe, expect, it } from "vitest";
import { isConnectionReady, useConnectionStore } from "./connectionStore";

/**
 * The handshake is what gates every recurring request, so its state machine gets its
 * own test: a socket that merely opened must not count as ready.
 */
describe("connectionStore", () => {
  beforeEach(() => {
    useConnectionStore.setState({ status: "connecting", attempt: 0, lastError: undefined });
  });

  const s = () => useConnectionStore.getState();

  it("starts out not ready", () => {
    expect(s().status).toBe("connecting");
    expect(isConnectionReady()).toBe(false);
  });

  it("becomes ready only on the server's hello", () => {
    s().markReady(1);
    expect(s().status).toBe("ready");
    expect(s().serverProtocolVersion).toBe(1);
    expect(isConnectionReady()).toBe(true);
  });

  it("counts consecutive failures and clears the count on success", () => {
    s().markLost("ECONNREFUSED");
    s().markLost("ECONNREFUSED");
    expect(s().attempt).toBe(2);
    expect(s().lastError).toBe("ECONNREFUSED");

    s().markReady(1);
    expect(s().attempt).toBe(0);
    expect(s().lastError).toBeUndefined();
  });

  it("keeps the last error while retrying without a new reason", () => {
    s().markLost("timeout");
    s().markLost();
    expect(s().lastError).toBe("timeout");
    expect(s().attempt).toBe(2);
  });

  it("survives a full lose-and-recover cycle", () => {
    s().markReady(1);
    s().markLost("transport close");
    expect(isConnectionReady()).toBe(false);
    s().markConnecting();
    expect(s().status).toBe("connecting");
    s().markReady(1);
    expect(isConnectionReady()).toBe(true);
  });
});
