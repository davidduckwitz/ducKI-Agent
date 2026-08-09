import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { resolveSkillSource, installFromTarball } from "./skill-install";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "skill-install-test-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Build a tar.gz from a source directory, returning the archive path. */
async function makeBundle(srcDir: string, name = "bundle.tar.gz"): Promise<string> {
  const file = join(work, name);
  await tar.c({ file, cwd: srcDir, gzip: true }, ["."]);
  return file;
}

const validSkill = [
  "---",
  "name: my-skill",
  "description: A test skill that does something useful. Use when testing the installer.",
  "---",
  "",
  "# My Skill",
].join("\n");

describe("resolveSkillSource", () => {
  it("resolves catalog:<id>", () => {
    const r = resolveSkillSource("catalog:code-review");
    expect(r.kind).toBe("catalog");
    expect(r.url).toContain("action=download&id=code-review");
    expect(r.slugHint).toBe("code-review");
  });

  it("resolves owner/repo to a GitHub tarball", () => {
    const r = resolveSkillSource("vercel-labs/find-skills");
    expect(r.kind).toBe("github");
    expect(r.url).toContain("api.github.com/repos/vercel-labs/find-skills/tarball/");
  });

  it("resolves a direct https tarball URL", () => {
    const r = resolveSkillSource("https://example.com/x.tar.gz");
    expect(r.kind).toBe("bundle-url");
  });

  it("rejects unknown sources", () => {
    expect(() => resolveSkillSource("not a source!!")).toThrow();
  });
});

describe("installFromTarball", () => {
  it("installs a valid skill bundle (SKILL.md at root)", async () => {
    const src = join(work, "src");
    await mkdir(join(src, "scripts"), { recursive: true });
    await writeFile(join(src, "SKILL.md"), validSkill);
    await writeFile(join(src, "scripts", "run.sh"), "echo hi\n");

    const bundle = await makeBundle(src);
    const skillsRoot = join(work, "skills");
    await mkdir(skillsRoot, { recursive: true });

    const result = await installFromTarball(bundle, { skillsRoot, slug: "my-skill" });
    expect(result.slug).toBe("my-skill");
    expect(result.files).toContain("SKILL.md");
    expect(result.files).toContain("scripts");

    const installed = await readFile(join(skillsRoot, "my-skill", "SKILL.md"), "utf8");
    expect(installed).toContain("name: my-skill");
    const scripts = await readdir(join(skillsRoot, "my-skill", "scripts"));
    expect(scripts).toContain("run.sh");
  });

  it("finds SKILL.md nested under a wrapper dir (GitHub-style)", async () => {
    const src = join(work, "src");
    await mkdir(join(src, "repo-abc123", "my-skill"), { recursive: true });
    await writeFile(join(src, "repo-abc123", "my-skill", "SKILL.md"), validSkill);

    const bundle = await makeBundle(src);
    const skillsRoot = join(work, "skills");
    await mkdir(skillsRoot, { recursive: true });

    const result = await installFromTarball(bundle, { skillsRoot, slug: "my-skill" });
    expect(result.slug).toBe("my-skill");
  });

  it("rejects a spec-non-conformant skill (name != slug)", async () => {
    const src = join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), validSkill); // name: my-skill
    const bundle = await makeBundle(src);
    const skillsRoot = join(work, "skills");
    await mkdir(skillsRoot, { recursive: true });

    await expect(installFromTarball(bundle, { skillsRoot, slug: "different-slug" })).rejects.toThrow(
      /spec-conformant/i
    );
    // Nothing should have been installed.
    await expect(readdir(join(skillsRoot, "different-slug"))).rejects.toBeTruthy();
  });

  it("does not extract entries outside the whitelist", async () => {
    const src = join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), validSkill);
    await writeFile(join(src, "evil.sh"), "rm -rf /\n"); // not whitelisted
    const bundle = await makeBundle(src);
    const skillsRoot = join(work, "skills");
    await mkdir(skillsRoot, { recursive: true });

    const result = await installFromTarball(bundle, { skillsRoot, slug: "my-skill" });
    expect(result.files).not.toContain("evil.sh");
    const installed = await readdir(join(skillsRoot, "my-skill"));
    expect(installed).not.toContain("evil.sh");
  });

  it("refuses to overwrite an existing skill unless overwrite=true", async () => {
    const src = join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), validSkill);
    const bundle = await makeBundle(src);
    const skillsRoot = join(work, "skills");
    await mkdir(join(skillsRoot, "my-skill"), { recursive: true });
    await writeFile(join(skillsRoot, "my-skill", "SKILL.md"), "old");

    await expect(installFromTarball(bundle, { skillsRoot, slug: "my-skill" })).rejects.toThrow(
      /already exists/i
    );
    const result = await installFromTarball(bundle, { skillsRoot, slug: "my-skill", overwrite: true });
    expect(result.slug).toBe("my-skill");
  });
});
