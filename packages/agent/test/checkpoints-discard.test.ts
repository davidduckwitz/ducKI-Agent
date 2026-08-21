import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, listCheckpoints, discardNoopCheckpoint } from "../src/coding/checkpoints.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "ducki-cp-discard-"));
  dirs.push(dir);
  return dir;
}

describe("discardNoopCheckpoint", () => {
  it("removes a checkpoint when the run changed nothing", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "hello");
    const cp = await createCheckpoint(dir, "no-op run");
    expect(cp).toBeDefined();

    // The run did nothing: status stays clean -> checkpoint must vanish.
    expect(await discardNoopCheckpoint(dir, cp!.sha)).toBe(true);
    expect(await listCheckpoints(dir)).toHaveLength(0);
  });

  it("keeps the checkpoint when a tracked file changed", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "hello");
    const cp = await createCheckpoint(dir, "run that edits");
    expect(cp).toBeDefined();

    appendFileSync(join(dir, "a.txt"), " changed by the run");
    expect(await discardNoopCheckpoint(dir, cp!.sha)).toBe(false);
    expect(await listCheckpoints(dir)).toHaveLength(1);
  });

  it("keeps the checkpoint when the run created a new (untracked) file", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "hello");
    const cp = await createCheckpoint(dir, "run that adds a file");
    expect(cp).toBeDefined();

    writeFileSync(join(dir, "new.txt"), "brand new");
    // A brand-new file is untracked - `git status --porcelain` must catch it, because
    // `git diff <sha>` alone would not.
    expect(await discardNoopCheckpoint(dir, cp!.sha)).toBe(false);
    expect(await listCheckpoints(dir)).toHaveLength(1);
  });

  it("keeps the checkpoint when it is not HEAD (never touches foreign entries)", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "v1");
    const first = await createCheckpoint(dir, "first");
    writeFileSync(join(dir, "a.txt"), "v2");
    const second = await createCheckpoint(dir, "second");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The older checkpoint is not HEAD -> must not be removed even though the worktree
    // currently matches the NEWER checkpoint.
    expect(await discardNoopCheckpoint(dir, first!.sha)).toBe(false);
    expect(await listCheckpoints(dir)).toHaveLength(2);
  });

  it("handles the first-ever no-op checkpoint (no parent commit)", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "hello");
    const cp = await createCheckpoint(dir, "first no-op");
    expect(cp).toBeDefined();

    expect(await discardNoopCheckpoint(dir, cp!.sha)).toBe(true);
    expect(await listCheckpoints(dir)).toHaveLength(0);

    // The shadow repo must remain usable: the next checkpoint becomes the root commit again.
    const next = await createCheckpoint(dir, "second run");
    expect(next).toBeDefined();
    expect(await listCheckpoints(dir)).toHaveLength(1);
  });
});
