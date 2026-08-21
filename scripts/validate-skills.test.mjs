import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateAllSkills } from "./validate-skills.mjs";

/** Loose stand-in for @ducki/agent's validateSkillDirectory: valid iff SKILL.md exists. */
function fakeValidateSkillDirectory(dir) {
  return existsSync(join(dir, "SKILL.md"))
    ? { valid: true, errors: [], warnings: [] }
    : { valid: false, errors: [{ field: "SKILL.md", message: "missing SKILL.md" }], warnings: [] };
}

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const tempRoots = [];

function makeLayout({ core = {}, plugins = {} }) {
  const root = mkdtempSync(join(tmpdir(), "validate-skills-test-"));
  tempRoots.push(root);
  const skillsDir = join(root, "skills");
  const pluginsDir = join(root, "plugins");
  for (const [slug, content] of Object.entries(core)) {
    write(join(skillsDir, slug, "SKILL.md"), content ?? "---\nname: x\ndescription: x\n---\n# x\n");
  }
  for (const [pluginName, files] of Object.entries(plugins)) {
    for (const [relPath, content] of Object.entries(files)) {
      write(join(pluginsDir, pluginName, relPath), content);
    }
  }
  return { skillsDir, pluginsDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("validateAllSkills", () => {
  it("akzeptiert valide Core- und Plugin-Skills", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: { "core-a": undefined },
      plugins: {
        "discord-connector": {
          "plugin.json": JSON.stringify({ name: "discord-connector", provides: { skills: ["skills/discord"] } }),
          "skills/discord/SKILL.md": "---\nname: discord\ndescription: x\n---\n# discord\n",
        },
      },
    });

    const { entries, coreCount, pluginCount, failed, warned } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(failed).toBe(0);
    expect(warned).toBe(0);
    expect(coreCount).toBe(1);
    expect(pluginCount).toBe(1);
    expect(entries.map((e) => e.label)).toEqual(["core-a", "discord-connector/discord"]);
  });

  it("meldet eine kaputte provides.skills-Referenz (kein SKILL.md) als Fehler", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: {},
      plugins: {
        "broken-plugin": {
          "plugin.json": JSON.stringify({ name: "broken-plugin", provides: { skills: ["skills/gibt-es-nicht"] } }),
        },
      },
    });

    const { entries, failed, pluginCount } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(failed).toBe(1);
    expect(pluginCount).toBe(1);
    const entry = entries[0];
    expect(entry.label).toBe("broken-plugin/skills/gibt-es-nicht");
    expect(entry.result.valid).toBe(false);
    expect(entry.result.errors[0].field).toBe("provides.skills");
    expect(entry.result.errors[0].message).toContain("has no SKILL.md");
  });

  it("warnt bei Slug-Clash zwischen Plugin- und Core-Skill", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: { discord: undefined },
      plugins: {
        "discord-connector": {
          "plugin.json": JSON.stringify({ name: "discord-connector", provides: { skills: ["skills/discord"] } }),
          "skills/discord/SKILL.md": "---\nname: discord\ndescription: x\n---\n# discord\n",
        },
      },
    });

    const { entries, failed, warned } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(failed).toBe(0);
    expect(warned).toBe(1);
    const clash = entries.find((e) => e.label === "discord (clash)");
    expect(clash).toBeDefined();
    expect(clash.result.valid).toBe(true);
    expect(clash.result.warnings[0].field).toBe("slug");
    expect(clash.result.warnings[0].message).toContain("core wins at runtime");
    expect(clash.result.warnings[0].message).toContain("shadowed");
  });

  it("meldet unparsebares plugin.json als Fehler", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: {},
      plugins: {
        "kaputt": { "plugin.json": "{ kein json" },
      },
    });

    const { entries, failed } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(failed).toBe(1);
    expect(entries[0].label).toBe("kaputt (plugin.json)");
    expect(entries[0].result.errors[0].field).toBe("plugin.json");
  });

  it("meldet nicht-Array provides.skills als Fehler", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: {},
      plugins: {
        "falsch": {
          "plugin.json": JSON.stringify({ name: "falsch", provides: { skills: "skills/discord" } }),
        },
      },
    });

    const { entries, failed } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(failed).toBe(1);
    expect(entries[0].label).toBe("falsch (provides.skills)");
    expect(entries[0].result.errors[0].field).toBe("provides.skills");
    expect(entries[0].result.errors[0].message).toContain("array");
  });

  it("ignoriert Verzeichnisse ohne plugin.json (kein Plugin)", () => {
    const { skillsDir, pluginsDir } = makeLayout({
      core: { "core-a": undefined },
      plugins: {
        "kein-manifest": { "irgendwas.txt": "egal" },
      },
    });

    const { coreCount, pluginCount, failed, warned } = validateAllSkills({
      skillsDir,
      pluginsDir,
      validateSkillDirectory: fakeValidateSkillDirectory,
    });

    expect(coreCount).toBe(1);
    expect(pluginCount).toBe(0);
    expect(failed).toBe(0);
    expect(warned).toBe(0);
  });
});
