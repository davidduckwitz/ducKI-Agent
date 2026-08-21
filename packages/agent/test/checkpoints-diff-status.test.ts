import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, diffCheckpoint } from "../src/coding/checkpoints.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "ducki-cp-diff-status-"));
  dirs.push(dir);
  return dir;
}

describe("diffCheckpoint file status", () => {
  it("reports A for new, M for modified and D for deleted files", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "keep.txt"), "unchanged\n");
    writeFileSync(join(dir, "edit.txt"), "v1\n");
    writeFileSync(join(dir, "gone.txt"), "will be deleted\n");
    const cp = await createCheckpoint(dir, "before changes");
    expect(cp).toBeDefined();

    // The run that follows: edits one file, adds a new one, deletes another.
    appendFileSync(join(dir, "edit.txt"), "v2\n");
    writeFileSync(join(dir, "new.txt"), "brand new\n");
    unlinkSync(join(dir, "gone.txt"));

    const diff = await diffCheckpoint(dir, cp!.sha);
    expect(diff).toBeDefined();

    const byPath = new Map((diff!.files ?? []).map((f) => [f.path, f]));
    expect(byPath.get("keep.txt")).toBeUndefined(); // untouched files are not listed
    expect(byPath.get("edit.txt")?.status).toBe("M");
    expect(byPath.get("edit.txt")?.added).toBe(1);
    expect(byPath.get("new.txt")?.status).toBe("A");
    expect(byPath.get("new.txt")?.added).toBe(1);
    expect(byPath.get("gone.txt")?.status).toBe("D");
    expect(byPath.get("gone.txt")?.removed).toBe(1);
  });
});
