import { describe, it, expect } from "vitest";
import { filesystemTool } from "@ducki/tools";
import { createScopedFilesystemTool } from "../src/coding/scoped-filesystem-tool";

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
