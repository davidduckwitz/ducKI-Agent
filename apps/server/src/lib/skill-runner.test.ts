import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkillCommand, SkillRunnerError, isRunnerEnabled } from "./skill-runner";

let work: string;
let skillsRoot: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "skill-runner-test-"));
  skillsRoot = join(work, "skills");
  await mkdir(join(skillsRoot, "my-skill"), { recursive: true });
  await writeFile(join(skillsRoot, "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: x\n---\n");
  // enable the runner for tests
  vi.stubEnv("ALLOW_EXTERNAL_SKILL_SCRIPTS", "true");
  vi.stubEnv("ALLOWED_SKILL_RUNTIMES", "node bash sh");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

describe("isRunnerEnabled", () => {
  it("reflects the feature flag", () => {
    vi.stubEnv("ALLOW_EXTERNAL_SKILL_SCRIPTS", "false");
    expect(isRunnerEnabled()).toBe(false);
    vi.stubEnv("ALLOW_EXTERNAL_SKILL_SCRIPTS", "true");
    expect(isRunnerEnabled()).toBe(true);
  });
});

describe("runSkillCommand guards", () => {
  it("refuses when the feature flag is off", async () => {
    vi.stubEnv("ALLOW_EXTERNAL_SKILL_SCRIPTS", "false");
    await expect(
      runSkillCommand({ slug: "my-skill", skillsRoot, command: "node", args: ["-e", "1"] })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an executable not on the allowlist", async () => {
    await expect(
      runSkillCommand({ slug: "my-skill", skillsRoot, command: "rm", args: ["-rf", "/"] })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a missing skill", async () => {
    await expect(
      runSkillCommand({ slug: "nope", skillsRoot, command: "node", args: ["-e", "1"] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an empty command", async () => {
    await expect(runSkillCommand({ slug: "my-skill", skillsRoot, command: "" })).rejects.toBeInstanceOf(
      SkillRunnerError
    );
  });
});

describe("runSkillCommand execution", () => {
  it("runs an allowed command and captures stdout", async () => {
    const r = await runSkillCommand({
      slug: "my-skill",
      skillsRoot,
      command: "node",
      args: ["-e", "console.log('hello from skill')"],
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello from skill");
  });

  it("reports a non-zero exit without throwing", async () => {
    const r = await runSkillCommand({
      slug: "my-skill",
      skillsRoot,
      command: "node",
      args: ["-e", "process.exit(3)"],
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it("runs in the skill directory (cwd)", async () => {
    const r = await runSkillCommand({
      slug: "my-skill",
      skillsRoot,
      command: "node",
      args: ["-e", "console.log(require('fs').existsSync('SKILL.md'))"],
    });
    expect(r.stdout.trim()).toBe("true");
  });

  it("kills a command that exceeds the timeout", async () => {
    const r = await runSkillCommand({
      slug: "my-skill",
      skillsRoot,
      command: "node",
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    // killed by signal (or non-zero exit on platforms that report it differently)
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });
});
