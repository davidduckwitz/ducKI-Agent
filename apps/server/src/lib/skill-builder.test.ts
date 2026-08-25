import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { validateSkillDirectory } from "@ducki/agent";
import { SkillBuilderSpecSchema, createValidatedSkill, previewSkill } from "./skill-builder.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const spec = {
  name: "weather-briefing",
  description: "Create a concise weather briefing when a user asks for forecast preparation.",
  instructions: "# Weather briefing\n\nCollect the requested location and time range. Present verified conditions, uncertainty, and practical preparation advice. Read [references/output.md](references/output.md) when formatting the final briefing.",
  resources: [{ path: "references/output.md", content: "# Output\n\nUse short sections for conditions, risks, and preparation." }],
};

describe("skill builder", () => {
  it("previews system-owned SKILL.md with exact frontmatter", () => {
    const preview = previewSkill(spec);
    expect(preview.files[0]).toMatchObject({ path: "SKILL.md", owner: "system" });
    expect(preview.files[0]?.content).toContain("name: weather-briefing");
    expect(preview.files[1]).toMatchObject({ path: "references/output.md", owner: "agent" });
  });

  it("atomically installs a skill accepted by the real loader validator", () => {
    const root = mkdtempSync(join(tmpdir(), "ducki-skill-builder-")); roots.push(root);
    const result = createValidatedSkill(root, spec);
    expect(validateSkillDirectory(result.path).valid).toBe(true);
    expect(readFileSync(join(result.path, "SKILL.md"), "utf8")).toContain("description:");
  });

  it("rejects traversal and agent-owned frontmatter", () => {
    expect(SkillBuilderSpecSchema.safeParse({ ...spec, resources: [{ path: "references/../secret.md", content: "x" }] }).success).toBe(false);
    expect(SkillBuilderSpecSchema.safeParse({ ...spec, instructions: "---\nname: wrong\n---\nA sufficiently long instruction body that should be rejected." }).success).toBe(false);
  });
});
