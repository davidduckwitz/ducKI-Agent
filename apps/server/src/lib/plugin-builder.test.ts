import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginDir } from "@ducki/agent";
import { createPluginScaffold, describePluginScaffold, validateScaffoldIntegrity, type PluginBuilderSpec } from "./plugin-builder.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ducki-plugin-builder-"));
  roots.push(value);
  return value;
}

function spec(archetype: PluginBuilderSpec["archetype"]): PluginBuilderSpec {
  return {
    name: archetype === "llm-provider" ? "acme-provider" : `acme-${archetype}`,
    displayName: "Acme Plugin",
    description: "A builder integration test plugin.",
    icon: "🧪",
    category: "automation",
    archetype,
    userRequest: "Create a useful Acme integration.",
    targetHint: archetype === "data-source" ? "https://api.example.com/v1/data" : undefined,
    allowedHosts: [],
    api: archetype === "data-source" ? { baseUrl: "https://api.example.com/v1/data", authentication: "none" } : undefined,
    llmProvider: archetype === "llm-provider" ? {
      protocol: "openai-compatible", defaultBaseUrl: "https://llm.example.com/v1", defaultModel: "acme-small",
      apiKeyRequired: true, supportsStreaming: true, supportsTools: true, supportsVision: false,
    } : undefined,
    widgets: archetype === "widget" ? [
      { id: "top", title: "Top Widget", placement: "topbar", align: "center", frame: "borderless", background: "transparent", height: 40, width: "md" },
      { id: "footer", title: "Footer Widget", placement: "footer", align: "right", frame: "card", background: "card", height: 32, width: "sm" },
    ] : undefined,
  };
}

describe("plugin builder scaffold", () => {
  it.each(["data-source", "storage-tool", "llm-provider", "widget"] as const)("creates and validates %s", (archetype) => {
    const stagingRoot = root();
    const input = spec(archetype);
    const pluginRoot = join(stagingRoot, input.name);
    const scaffold = createPluginScaffold(pluginRoot, input);

    expect(validateScaffoldIntegrity(pluginRoot, scaffold)).toEqual([]);
    const validation = validatePluginDir(stagingRoot, input.name, { allowBuilderLLMProvider: archetype === "llm-provider", allowBuilderWidgets: archetype === "widget" });
    expect(validation).toEqual({ ok: true, errors: [] });
    expect(JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")).name).toBe(input.name);
    if (archetype === "llm-provider") {
      const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
      expect(manifest.provides.llmProviders[0].modelSetting).toBe("ACME_MODEL");
    }
  });

  it("rejects modifications to system-owned files and unexpected files", () => {
    const input = spec("llm-provider");
    const pluginRoot = join(root(), input.name);
    const scaffold = createPluginScaffold(pluginRoot, input);
    writeFileSync(join(pluginRoot, "provider.js"), "export function createProvider() {}\n", "utf8");
    writeFileSync(join(pluginRoot, "extra.js"), "unsafe\n", "utf8");

    expect(validateScaffoldIntegrity(pluginRoot, scaffold)).toEqual(expect.arrayContaining([
      "System-owned file was modified: provider.js",
      "Unexpected file created: extra.js",
    ]));
  });

  it("returns a file ownership preview without writing files", () => {
    const preview = describePluginScaffold(spec("llm-provider"));
    expect(preview.files.find((file) => file.path === "plugin.json")?.owner).toBe("system");
    expect(preview.files.find((file) => file.path === "README.md")?.owner).toBe("agent");
    expect(preview.files.find((file) => file.path === "provider.js")?.owner).toBe("system");
  });

  it("rejects an LLM plugin that would shadow a built-in provider id", () => {
    expect(() => describePluginScaffold({ ...spec("llm-provider"), name: "openai-provider" })).toThrow(/reserved/i);
  });
});
