import { parseMarkdownToPlan } from "./parseMarkdownToPlan";

describe("parseMarkdownToPlan", () => {
  const validMarkdown = `## Plan: Website Redesign Project

**Komplexität:** Mittel

1. **Design Phase**
   Create wireframes and design system components
   _Benötigte Tools: figma, design_

2. **Frontend Development**
   Build React components and integrate designs
   _Benötigte Tools: coding, frontend_

3. **Backend API**
   Create REST endpoints for new features
   _Benötigte Tools: coding, backend_`;

  test("parses valid markdown correctly", () => {
    const result = parseMarkdownToPlan(validMarkdown);

    expect(result).not.toBeNull();
    expect(result?.goal).toBe("Website Redesign Project");
    expect(result?.title).toBe("Plan: Website Redesign Project");
    expect(result?.complexity).toBe(3); // Mittel
    expect(result?.steps).toHaveLength(3);
    expect(result?.markdown).toBe(validMarkdown);
  });

  test("extracts steps with tools correctly", () => {
    const result = parseMarkdownToPlan(validMarkdown);

    expect(result?.steps?.[0]?.title).toBe("Design Phase");
    expect(result?.steps?.[0]?.description).toContain("wireframes");
    expect(result?.steps?.[0]?.tools).toEqual(["figma", "design"]);

    expect(result?.steps?.[1]?.title).toBe("Frontend Development");
    expect(result?.steps?.[1]?.tools).toEqual(["coding", "frontend"]);
  });

  test("handles Hoch complexity", () => {
    const markdown = `## Plan: Complex Project
**Komplexität:** Hoch
1. **Step**
   Description`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.complexity).toBe(5);
  });

  test("handles Niedrig complexity", () => {
    const markdown = `## Plan: Simple Project
**Komplexität:** Niedrig
1. **Step**
   Description`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.complexity).toBe(1);
  });

  test("defaults to Mittel if no complexity specified", () => {
    const markdown = `## Plan: Default Project
1. **Step**
   Description`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.complexity).toBe(3);
  });

  test("returns null for missing goal", () => {
    const markdown = `1. **Step**
   Description`;

    const result = parseMarkdownToPlan(markdown);
    expect(result).toBeNull();
  });

  test("returns null for missing steps", () => {
    const markdown = `## Plan: No Steps`;

    const result = parseMarkdownToPlan(markdown);
    expect(result).toBeNull();
  });

  test("handles empty string", () => {
    expect(parseMarkdownToPlan("")).toBeNull();
  });

  // formatPlanAsMarkdown (packages/agent) renders ASCII umlauts - the parser has to
  // accept that exact shape, not only the pretty-printed fixture above.
  test("parses the ASCII-umlaut markdown the plan renderer actually emits", () => {
    const markdown = `## Plan: Login reparieren

**Geschaetzte Komplexitaet:** Hoch

1. **Fehler reproduzieren**
   Login-Flow lokal nachstellen
   _Benoetigte Tools: shell, filesystem_`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.complexity).toBe(5);
    expect(result?.steps?.[0]?.tools).toEqual(["shell", "filesystem"]);
    expect(result?.steps?.[0]?.description).toBe("Login-Flow lokal nachstellen");
  });

  test("ignores complexity words that only appear in step text", () => {
    const markdown = `## Plan: Upload Feature
**Komplexität:** Niedrig
1. **Datei hochladen**
   Datei per Formular hochladen`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.complexity).toBe(1);
  });

  test("handles steps without tools", () => {
    const markdown = `## Plan: Simple
1. **Step One**
   Just description here`;

    const result = parseMarkdownToPlan(markdown);
    expect(result?.steps?.[0]?.tools).toBeUndefined();
  });
});
