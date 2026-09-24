import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLearner } from "../src/skills/skill-learner.js";

let root: string;
const logger = { warn: vi.fn() } as any;
const model = () => ({ generate: vi.fn(async (messages: any[]) => {
  const name = messages[0].content.match(/name: (learned-[a-f0-9]{24})/)?.[1];
  return { content: name ? `---\nname: ${name}\ndescription: Narrow nullable inputs before assignment\n---\n# When to Use\nNullable assignment errors\n# Procedure\nRead and narrow\n# Pitfalls\nDo not assume\n# Verification\nRun typecheck` : "Narrow nullable input; verify using typecheck." };
}) }) as any;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ducki-learning-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const opts = () => ({ sourceRoot: root, candidateRoot: join(root, "pending"), approvedRoot: join(root, "approved") });

describe("skill learning persistence and source evidence", () => {
  it("reads a URL, persists a pending candidate, survives restart, and requires approval for discovery", async () => {
    const provider = model();
    const fetchSource = vi.fn(async () => new Response("Actual fetched source: use a null guard", { status: 200 })) as any;
    const learner = new SkillLearner(provider, {} as any, logger, { ...opts(), fetchSource });
    const result = await learner.learnFromSource("https://example.com/guide");
    expect(result.success).toBe(true);
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.generate.mock.calls)).toContain("Actual fetched source");
    expect(result.status).toBe("pending");
    await expect(readdir(opts().approvedRoot)).rejects.toThrow();
    const restarted = new SkillLearner(provider, {} as any, logger, opts());
    expect(await restarted.listCandidates()).toHaveLength(1);
    await restarted.approve(result.skillSlug!);
    expect(await readFile(join(opts().approvedRoot, result.skillSlug!, "SKILL.md"), "utf8")).toContain("# Verification");
    await expect(restarted.approve(result.skillSlug!)).rejects.toThrow("already exists");
  });
  it("reads scoped files and directories and rejects escape paths", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const evidence = 'verified source';");
    const provider = model();
    const learner = new SkillLearner(provider, {} as any, logger, opts());
    expect((await learner.learnFromSource("./src")).success).toBe(true);
    expect(JSON.stringify(provider.generate.mock.calls)).toContain("verified source");
    expect((await learner.learnFromSource("../")).success).toBe(false);
  });
  it("never reports success if persistence fails", async () => {
    await writeFile(join(root, "blocked"), "not a directory");
    const learner = new SkillLearner(model(), {} as any, logger, { ...opts(), candidateRoot: join(root, "blocked") });
    expect((await learner.learnFromSource("Evidence: typecheck passed after null narrowing")).success).toBe(false);
  });
  it("does not generate a skill from an HTTP error or activate tampered content", async () => {
    const provider = model();
    const learner = new SkillLearner(provider, {} as any, logger, { ...opts(), fetchSource: vi.fn(async () => new Response("missing", { status: 404 })) as any });
    expect((await learner.learnFromSource("https://example.com/missing")).success).toBe(false);
    expect(provider.generate).not.toHaveBeenCalled();
    const result = await learner.learnFromSource("Some factual source text");
    await writeFile(join(opts().candidateRoot, result.skillSlug!, "SKILL.md"), "tampered");
    await expect(learner.approve(result.skillSlug!)).rejects.toThrow("integrity");
  });
  it("rejects oversized and unscoped conversation sources before inference", async () => {
    const provider = model();
    const learner = new SkillLearner(provider, {} as any, logger, opts());
    expect((await learner.learnFromSource("x".repeat(200001))).success).toBe(false);
    expect((await learner.learnFromSource("123")).success).toBe(false);
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("deduplicates exact source/context candidates across restarts", async () => {
    const provider = model();
    const learner = new SkillLearner(provider, {} as any, logger, opts());
    const first = await learner.learnFromSource("Fact: typecheck confirms null narrowing.");
    provider.generate.mockClear();
    const second = await new SkillLearner(provider, {} as any, logger, opts()).learnFromSource("Fact: typecheck confirms null narrowing.");
    expect(second.skillSlug).toBe(first.skillSlug);
    expect(second.success).toBe(true);
    expect(provider.generate).not.toHaveBeenCalled();
  });
});
