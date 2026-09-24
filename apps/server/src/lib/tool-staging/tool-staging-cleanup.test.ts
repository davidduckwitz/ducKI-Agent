import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolStagingManager } from "./tool-staging-manager.js";

let directory: string;
let manager: ToolStagingManager;
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
const cleanup = () => (manager as unknown as { cleanup(): Promise<void> }).cleanup();
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "ducki-staging-cleanup-"));
  manager = new ToolStagingManager(logger as any, relative(process.cwd(), directory), 1);
});
afterEach(async () => {
  manager.stop(); vi.restoreAllMocks(); vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

it("pins relative paths before another library changes cwd", async () => {
  const elsewhere = join(directory, "whisper");
  await fs.mkdir(elsewhere);
  const original = process.cwd();
  try {
    process.chdir(elsewhere);
    const staged = await manager.stageToolResponse("test", "payload", "summary");
    expect(staged.filePath.startsWith(directory)).toBe(true);
    expect(staged.filePath.startsWith(elsewhere)).toBe(false);
    expect((await manager.getStagedResponse(staged.id))?.content).toContain("payload");
  } finally { process.chdir(original); }
});

it("ignores a missing directory and recreates it on the next write", async () => {
  await fs.rmdir(directory);
  await expect(cleanup()).resolves.toBeUndefined();
  const staged = await manager.stageToolResponse("test", "payload", "summary");
  expect(await fs.readFile(staged.filePath, "utf8")).toContain("payload");
});

it("handles a file disappearing during cleanup and still removes other expired files", async () => {
  const first = await manager.stageToolResponse("first", "one", "summary");
  const second = await manager.stageToolResponse("second", "two", "summary");
  await fs.utimes(second.filePath, new Date(0), new Date(0));
  vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
  await expect(cleanup()).resolves.toBeUndefined();
  expect(await manager.listStaged()).toHaveLength(1);
  expect(await fs.readFile(first.filePath, "utf8")).toContain("one");
});

it("catches unexpected interval errors and does not create duplicate timers", async () => {
  vi.useFakeTimers();
  await manager.start(); await manager.start();
  expect(vi.getTimerCount()).toBe(1);
  vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(logger.warn).toHaveBeenCalledWith("Tool staging cleanup failed", expect.objectContaining({ error: "access denied" }));
  manager.stop(); expect(vi.getTimerCount()).toBe(0);
});
