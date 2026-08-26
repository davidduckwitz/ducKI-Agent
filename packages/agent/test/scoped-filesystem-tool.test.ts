import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemTool } from "@ducki/tools";
import { createScopedFilesystemTool, normalizeScopedPath } from "../src/coding/scoped-filesystem-tool";

/**
 * Regression test: filesystemTool.definition (what the model actually reads to decide how to
 * call the tool) hardcodes "scoped to shared-workspace" framing and a "/shared-workspace/..."
 * path example. The scoped wrapper used to leave that nested schema text untouched (only the
 * top-level description string got a "(scoped to ...)" suffix), so a sandboxed CodingAgent kept
 * seeing shared-workspace-shaped guidance even though it was confined to a different sandbox.
 */
describe("createScopedFilesystemTool definition text", () => {
  it("the unscoped tool still mentions shared-workspace (sanity check the fixture assumption holds)", () => {
    const raw = JSON.stringify(filesystemTool.definition);
    expect(raw.toLowerCase()).toContain("shared-workspace");
  });

  it("the scoped definition drops the misleading affirmative shared-workspace framing", () => {
    const scoped = createScopedFilesystemTool("/sandbox/my-plugin");
    const raw = JSON.stringify(scoped.definition).toLowerCase();
    // A "never use shared-workspace" WARNING is fine (and expected) - what must be gone is
    // language telling the model paths ARE scoped there, or the misleading example path.
    expect(raw).not.toContain("scoped to shared-workspace");
    expect(raw).not.toContain("/shared-workspace/config.json");
    expect(raw).toContain("never prefix with shared-workspace");
  });

  it("the scoped path parameter description references the sandbox root instead", () => {
    const scoped = createScopedFilesystemTool("/sandbox/my-plugin");
    const properties = (scoped.definition.parameters as { properties?: Record<string, { description?: string }> })
      .properties;
    expect(properties?.["path"]?.description).toContain("/sandbox/my-plugin");
  });

  it("leaves the action enum and other parameters untouched", () => {
    const scoped = createScopedFilesystemTool("/sandbox/my-plugin");
    const originalProps = (filesystemTool.definition.parameters as { properties?: Record<string, unknown> }).properties;
    const scopedProps = (scoped.definition.parameters as { properties?: Record<string, { enum?: unknown }> }).properties;
    expect(scopedProps?.["action"]?.enum).toEqual((originalProps?.["action"] as { enum?: unknown })?.enum);
  });
});

/**
 * Regression: every coding sandbox lives at exactly ONE path segment deep
 * (CODING_WORKSPACE_ROOT/<project-slug>), so a model that repeats its own project slug as a
 * leading path segment (extremely common - it just saw that slug in its own prompt) used to
 * get silently written one directory level too deep, because the de-duplication only
 * stripped a repeated prefix of 2+ segments. A same-session read at the path the model
 * actually believes is correct ("index.html") then failed with "File not found" - write and
 * read silently disagreeing about where the file lives.
 */
describe("normalizeScopedPath single-segment sandbox slug", () => {
  it("strips a leading path segment that repeats the (single-segment) sandbox slug", () => {
    expect(normalizeScopedPath("my-project/index.html", "/shared-workspace/coding/my-project")).toBe("index.html");
  });

  it("leaves a genuinely relative path untouched", () => {
    expect(normalizeScopedPath("src/app.js", "/shared-workspace/coding/my-project")).toBe("src/app.js");
  });

  it("still strips a multi-segment repeated prefix (unchanged prior behavior)", () => {
    expect(
      normalizeScopedPath("shared-workspace/coding/my-project/index.html", "/shared-workspace/coding/my-project")
    ).toBe("index.html");
  });
});

/**
 * Regression: a model that ignores the "NEVER include 'shared-workspace' or 'coding' in your
 * file paths" instruction sometimes writes a bare "coding/STATUS.md" - no project slug, so the
 * suffix-match above never fires - which used to land as a genuine unwanted "coding" subfolder
 * inside the sandbox instead of at the project root the model actually meant.
 */
describe("normalizeScopedPath bare reserved-name prefix", () => {
  it("strips a leading 'coding/' with no project slug following it", () => {
    expect(normalizeScopedPath("coding/STATUS.md", "/shared-workspace/coding/my-project")).toBe("STATUS.md");
  });

  it("strips a leading 'shared-workspace/' with no project slug following it", () => {
    expect(normalizeScopedPath("shared-workspace/STATUS.md", "/shared-workspace/coding/my-project")).toBe("STATUS.md");
  });

  it("strips both in sequence", () => {
    expect(normalizeScopedPath("shared-workspace/coding/STATUS.md", "/shared-workspace/coding/my-project")).toBe("STATUS.md");
  });

  it("leaves a path that merely starts with those words as a substring untouched", () => {
    expect(normalizeScopedPath("coding-notes/STATUS.md", "/shared-workspace/coding/my-project")).toBe("coding-notes/STATUS.md");
  });
});

describe("scoped filesystem tool write/read round-trip", () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
    sandboxes.length = 0;
  });

  it("a write that repeats the project slug lands where a same-session read expects it", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-scoped-fs-"));
    sandboxes.push(sandbox);
    const slug = sandbox.split(/[\\/]/).pop()!;
    const tool = createScopedFilesystemTool(sandbox);

    const writeResult = await tool.execute({ action: "write", path: `${slug}/index.html`, content: "<h1>hi</h1>" });
    expect(writeResult.success).toBe(true);
    expect(existsSync(join(sandbox, "index.html"))).toBe(true);
    expect(existsSync(join(sandbox, slug, "index.html"))).toBe(false);

    const readResult = await tool.execute({ action: "read", path: "index.html" });
    expect(readResult.success).toBe(true);
  });

  it("rejects an empty path instead of silently resolving to the sandbox root", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-scoped-fs-empty-"));
    sandboxes.push(sandbox);
    const tool = createScopedFilesystemTool(sandbox);

    const result = await tool.execute({ action: "write", path: "", content: "oops" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path is required/i);
  });
});
