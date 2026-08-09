import { describe, it, expect } from "vitest";
import { parseFrontmatter, normalizeSkillContent, normalizeFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses simple scalar keys", () => {
    const { data, found } = parseFrontmatter(
      ["---", "name: discord", "description: Send messages", "---", "", "# Body"].join("\n")
    );
    expect(found).toBe(true);
    expect(data.name).toBe("discord");
    expect(data.description).toBe("Send messages");
  });

  it("strips a leading UTF-8 BOM (historical bug)", () => {
    const content = "﻿---\nname: discord\ndescription: x\n---\nbody";
    const { data, found } = parseFrontmatter(content);
    expect(found).toBe(true);
    expect(data.name).toBe("discord");
  });

  it("does not leak \\r from CRLF line endings (historical bug)", () => {
    const content = '---\r\nname: "Auto Plan"\r\ndescription: "Plans"\r\n---\r\nbody';
    const { data } = parseFrontmatter(content);
    expect(data.name).toBe("Auto Plan");
    expect(data.description).toBe("Plans");
  });

  it("strips surrounding single and double quotes", () => {
    const { data } = parseFrontmatter(`---\nname: 'a'\ndescription: "b"\n---\n`);
    expect(data.name).toBe("a");
    expect(data.description).toBe("b");
  });

  it("parses inline arrays", () => {
    const { data } = parseFrontmatter(`---\ntags: [a, "b", c]\n---\n`);
    expect(data.tags).toEqual(["a", "b", "c"]);
  });

  it("parses block arrays", () => {
    const { data } = parseFrontmatter(
      ["---", "related_skills:", "  - one", "  - two", "name: x", "---", ""].join("\n")
    );
    expect(data.related_skills).toEqual(["one", "two"]);
    expect(data.name).toBe("x");
  });

  it("parses one-level metadata maps", () => {
    const { data } = parseFrontmatter(
      ["---", "name: x", "metadata:", "  version: \"1.2\"", "  author: dd", "---", ""].join("\n")
    );
    expect(data.metadata).toEqual({ version: "1.2", author: "dd" });
  });

  it("returns found:false and full body when no frontmatter", () => {
    const content = "# Skill: Git\n\nno frontmatter here";
    const { found, data, body } = parseFrontmatter(content);
    expect(found).toBe(false);
    expect(data).toEqual({});
    expect(body).toBe(content);
  });

  it("returns found:false when opening --- is not closed", () => {
    const { found } = parseFrontmatter("---\nname: x\nno closing");
    expect(found).toBe(false);
  });

  it("exposes the markdown body after the closing delimiter", () => {
    const { body } = parseFrontmatter(`---\nname: x\n---\n# Title\ncontent`);
    expect(body).toBe("# Title\ncontent");
  });

  it("resumes correctly after a nested block", () => {
    const { data } = parseFrontmatter(
      ["---", "tags:", "  - a", "  - b", "priority: high", "---", ""].join("\n")
    );
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.priority).toBe("high");
  });
});

describe("normalizeFrontmatter", () => {
  it("reads legacy top-level fields", () => {
    const { data } = parseFrontmatter(
      ["---", "name: discord", "related_skills: [a, b]", "priority: high", "---", ""].join("\n")
    );
    const fm = normalizeFrontmatter(data);
    expect(fm.name).toBe("discord");
    expect(fm.relatedSkills).toEqual(["a", "b"]);
    expect(fm.priority).toBe("high");
  });

  it("reads fields from metadata map (spec-conformant)", () => {
    const { data } = parseFrontmatter(
      [
        "---",
        "name: discord",
        "metadata:",
        "  version: \"1.2.0\"",
        "  category: Integration",
        "  tags: discord, messaging",
        "  related_skills: cronjobs, workflow-orchestrator",
        "---",
        "",
      ].join("\n")
    );
    const fm = normalizeFrontmatter(data);
    expect(fm.version).toBe("1.2.0");
    expect(fm.category).toBe("Integration");
    expect(fm.tags).toEqual(["discord", "messaging"]);
    expect(fm.relatedSkills).toEqual(["cronjobs", "workflow-orchestrator"]);
    expect(fm.metadata.version).toBe("1.2.0");
  });

  it("prefers top-level over metadata for the same key", () => {
    const { data } = parseFrontmatter(
      ["---", "name: x", "category: Top", "metadata:", "  category: Meta", "---", ""].join("\n")
    );
    expect(normalizeFrontmatter(data).category).toBe("Top");
  });

  it("parses spec allowed-tools as space-separated list", () => {
    const { data } = parseFrontmatter(`---\nname: x\nallowed-tools: Bash(git:*) Read\n---\n`);
    expect(normalizeFrontmatter(data).allowedTools).toEqual(["Bash(git:*)", "Read"]);
  });

  it("carries license and compatibility", () => {
    const { data } = parseFrontmatter(
      ["---", "name: x", "license: Apache-2.0", "compatibility: Requires git", "---", ""].join("\n")
    );
    const fm = normalizeFrontmatter(data);
    expect(fm.license).toBe("Apache-2.0");
    expect(fm.compatibility).toBe("Requires git");
  });

  it("always returns a metadata object", () => {
    const { data } = parseFrontmatter(`---\nname: x\n---\n`);
    expect(normalizeFrontmatter(data).metadata).toEqual({});
  });
});

describe("normalizeSkillContent", () => {
  it("strips BOM and converts CRLF to LF", () => {
    expect(normalizeSkillContent("﻿a\r\nb\rc")).toBe("a\nb\nc");
  });
});
