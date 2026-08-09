import { describe, it, expect } from "vitest";
import { validateSkillContent } from "./validate";

const good = [
  "---",
  "name: pdf-processing",
  "description: Extracts text and tables from PDF files. Use when working with PDFs.",
  "---",
  "",
  "# Body",
].join("\n");

describe("validateSkillContent", () => {
  it("accepts a spec-conformant skill", () => {
    const r = validateSkillContent(good, "pdf-processing");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags missing frontmatter and required fields", () => {
    const r = validateSkillContent("# Skill: Git\n\nno frontmatter");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
    expect(r.errors.some((e) => e.field === "description")).toBe(true);
  });

  it("rejects uppercase / bad name", () => {
    const c = good.replace("pdf-processing", "PDF-Processing");
    expect(validateSkillContent(c).valid).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    const c = good.replace("name: pdf-processing", "name: pdf--processing");
    const r = validateSkillContent(c);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects name not matching directory", () => {
    const r = validateSkillContent(good, "something-else");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects description over 1024 chars", () => {
    const c = good.replace(/description: .*/, `description: ${"x".repeat(1100)}`);
    expect(validateSkillContent(c, "pdf-processing").valid).toBe(false);
  });

  it("warns on very short description but stays valid", () => {
    const c = good.replace(/description: .*/, "description: short");
    const r = validateSkillContent(c, "pdf-processing");
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.field === "description")).toBe(true);
  });
});
