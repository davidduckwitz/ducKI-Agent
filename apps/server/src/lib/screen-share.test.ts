import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
vi.mock("./desktop-control.js", async (original) => ({
  ...await original<typeof import("./desktop-control.js")>(),
  runDesktopAction: vi.fn(async () => ({ screenshot: "frame", format: "jpeg" })),
}));
import { validateDesktopAction, runDesktopAction } from "./desktop-control.js";
import { createScreenShareSession, isLocalDesktopClient } from "./screen-share.js";

beforeEach(() => vi.clearAllMocks());
function setup() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const socket = {
    connected: true,
    handshake: { address: "127.0.0.1", headers: { origin: "http://localhost:5173" } },
    on: (name: string, callback: (...args: any[]) => any) => { handlers.set(name, callback); },
    emit: vi.fn(), timeout: () => ({ emitWithAck: async () => ({ screenshot: "frame", format: "jpeg" }) }),
  };
  const session = createScreenShareSession(socket as unknown as Socket);
  const configure = (mode: string, control = false) => handlers.get("screen:configure")!({ mode, control }, vi.fn());
  return { session, handlers, configure };
}
describe("screen sharing capability", () => {
  it("only permits desktop access from loopback and a local origin", () => {
    expect(isLocalDesktopClient("127.0.0.1", "http://localhost:5173")).toBe(true);
    expect(isLocalDesktopClient("192.168.1.5", "http://localhost:5173")).toBe(false);
    expect(isLocalDesktopClient("127.0.0.1", "https://evil.example")).toBe(false);
    expect(isLocalDesktopClient("127.0.0.1", undefined)).toBe(false);
  });
  it("does not expose a tool before sharing and rejects clicks in read-only mode", async () => {
    const test = setup();
    expect(test.session.tool()).toBeNull();
    test.configure("display");
    const tool = test.session.tool()!;
    expect((await tool.execute({ action: "screenshot" })).success).toBe(true);
    expect((await tool.execute({ action: "click", x: 0.5, y: 0.5 })).success).toBe(false);
    expect(runDesktopAction).not.toHaveBeenCalled();
  });
  it.each(["screen:revoke", "disconnect", "chat:stop"])("invalidates previously issued tools on %s", async (event) => {
    const test = setup(); test.configure("display");
    const tool = test.session.tool()!;
    test.handlers.get(event)!();
    expect((await tool.execute({ action: "screenshot" })).success).toBe(false);
  });
  it("does not restore old capabilities when another share starts", async () => {
    const test = setup(); test.configure("display");
    const old = test.session.tool()!;
    test.configure("display");
    expect((await old.execute({ action: "screenshot" })).success).toBe(false);
    expect((await test.session.tool()!.execute({ action: "screenshot" })).success).toBe(true);
  });
  it.runIf(process.platform === "win32")("dispatches input only with the explicit desktop control grant", async () => {
    const test = setup(); test.configure("desktop");
    expect((await test.session.tool()!.execute({ action: "key", key: "TAB" })).success).toBe(false);
    test.configure("desktop", true);
    expect((await test.session.tool()!.execute({ action: "key", key: "TAB" })).success).toBe(true);
    expect(runDesktopAction).toHaveBeenCalledWith(expect.objectContaining({ action: "key", key: "TAB" }), expect.any(AbortSignal));
  });
});
describe("desktop input validation", () => {
  it.each([
    { action: "click", x: -1, y: 0 }, { action: "click", x: NaN, y: 1 },
    { action: "click", x: 0, y: Infinity }, { action: "shell", text: "anything" },
    { action: "key", key: "CTRL+A;calc" }, { action: "scroll", delta: 100 },
    { action: "type", text: "x".repeat(2001) },
  ])("rejects malformed commands %j", (input) => { expect(() => validateDesktopAction(input)).toThrow(); });
  it("preserves literal text and allows bounded coordinates", () => {
    expect(validateDesktopAction({ action: "type", text: "$(Get-Process) ' Ü" }).text).toBe("$(Get-Process) ' Ü");
    expect(validateDesktopAction({ action: "click", x: 0, y: 1 }).x).toBe(0);
    expect(validateDesktopAction({ action: "key", key: "CTRL+A" }).key).toBe("CTRL+A");
  });
});
