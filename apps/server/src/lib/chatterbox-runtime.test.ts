import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { DatabaseService } from "@ducki/database";
import { autoStartChatterbox, chatterboxStatus, controlChatterbox, localChatterboxUrl } from "./chatterbox-runtime.js";

const database = (values: Record<string, string> = {}) => ({
  getSetting: async (key: string) => values[key],
}) as DatabaseService;
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("Chatterbox lifecycle", () => {
  it("limits managed processes to loopback HTTP URLs", () => {
    expect(localChatterboxUrl("http://localhost:8890").port).toBe("8890");
    for (const url of ["https://localhost:8890", "http://example.com", "http://localhost/path", "http://user@localhost", "http://localhost/?x=1"]) {
      expect(() => localChatterboxUrl(url)).toThrow();
    }
  });
  it("does not autostart when disabled or another provider is selected", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await autoStartChatterbox(database({ CHATTERBOX_AUTO_START: "false" }));
    await autoStartChatterbox(database({ DEFAULT_TEXT_TO_SPEECH_PROVIDER: "openai" }));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("leaves external unloaded servers alone on autostart", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ modelLoaded: false })));
    vi.stubGlobal("fetch", fetcher);
    await autoStartChatterbox(database());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/health");
  });
  it("reports stopped servers without treating them as managed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    expect(await chatterboxStatus(database())).toMatchObject({ reachable: false, managed: false });
  });
  it("does not kill externally started servers", async () => {
    await expect(controlChatterbox(database(), "stop")).rejects.toThrow("extern gestartet");
  });
  it("serializes actions and surfaces model errors", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const task = controlChatterbox(database(), "unload");
    expect(() => controlChatterbox(database(), "load")).toThrow("läuft bereits");
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(new Response("Model busy", { status: 409 }));
    await expect(task).rejects.toThrow("Model busy");
  });
  it("starts V3 and treats an intentional Windows process-tree stop as success", async () => {
    let running = false;
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: vi.fn(() => { queueMicrotask(() => proc.emit("exit", 0)); return true; }),
    });
    proc.on("exit", () => { running = false; });
    vi.mocked(spawn).mockImplementation(() => { running = true; return proc as unknown as ChildProcess; });
    vi.mocked(execFileSync).mockImplementation(() => {
      queueMicrotask(() => proc.emit("exit", 1));
      return Buffer.from("");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ modelLoaded: true }), { status: running ? 200 : 503 })));
    await controlChatterbox(database(), "start");
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      windowsHide: true, env: { CHATTERBOX_MODEL: "v3" },
    });
    await controlChatterbox(database(), "stop");
    expect(await chatterboxStatus(database())).toMatchObject({ managed: false, reachable: false, error: undefined });
    if (process.platform === "win32") {
      expect(execFileSync).toHaveBeenCalledWith("taskkill", ["/PID", "4242", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
    }
  });
});
