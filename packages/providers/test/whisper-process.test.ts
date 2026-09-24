import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runWhisperProcess } from "../src/whisper-process.js";

let directory: string;
let modulePath: string;
beforeEach(async () => {
  // Keep the executable fixture in the workspace; sandboxed Node cannot resolve
  // module ancestors in the Windows user-profile temp directory.
  directory = await mkdtemp(join(process.cwd(), ".ducki-whisper-test-"));
  modulePath = join(directory, "fake-whisper.cjs");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("isolates simultaneous whisper cwd changes from the server and from each other", async () => {
  await writeFile(modulePath, `exports.nodewhisper = async (_, options) => {
    process.chdir(options.modelRootPath);
    await new Promise(resolve => setTimeout(resolve, 50));
    return process.cwd();
  };`);
  const first = join(directory, "first"), second = join(directory, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const cwd = process.cwd();
  const jobs = [first, second].map((modelRootPath) => runWhisperProcess(modulePath, "unused", { modelName: "base", modelRootPath }, 10000));
  expect(process.cwd()).toBe(cwd);
  expect(await Promise.all(jobs)).toEqual([first, second]);
  expect(process.cwd()).toBe(cwd);
}, 15000);

it("reports library failures without changing cwd or crashing the parent", async () => {
  await writeFile(modulePath, `exports.nodewhisper = async () => { process.chdir(__dirname); throw new Error('whisper failed'); };`);
  const cwd = process.cwd();
  await expect(runWhisperProcess(modulePath, "unused", { modelName: "base" }, 10000)).rejects.toThrow("whisper failed");
  expect(process.cwd()).toBe(cwd);
});

it("terminates a hung child before rejecting a timeout", async () => {
  await writeFile(modulePath, `exports.nodewhisper = () => new Promise(() => setInterval(() => {}, 100));`);
  await expect(runWhisperProcess(modulePath, "unused", { modelName: "base" }, 150)).rejects.toThrow("timed out after 150ms");
}, 10000);

it("rejects invalid timeout settings", async () => {
  await expect(runWhisperProcess(modulePath, "unused", { modelName: "base" }, NaN)).rejects.toThrow("Invalid");
});
