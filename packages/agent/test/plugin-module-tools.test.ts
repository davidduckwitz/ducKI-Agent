import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "../src/plugins/index.ts";
import { setPluginSetting, closeAllPluginDbs } from "@ducki/database";

let root: string;

function writePlugin(name: string, manifest: object, files: Record<string, string>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ducki-modtools-"));
  process.env.DUCKI_PLUGINS_DIR = root;
  delete process.env.DUCKI_SECRET_KEY;
});
afterAll(() => {
  closeAllPluginDbs();
  delete process.env.DUCKI_PLUGINS_DIR;
});

describe("plugin module tools (trust: node)", () => {
  it("loads a module tool that receives injected secrets and a guarded fetch", async () => {
    writePlugin(
      "mod-test",
      {
        name: "mod-test",
        version: "1.0.0",
        description: "module tool test plugin",
        trust: "node",
        allowedHosts: ["api.example.com"],
        provides: {
          moduleTools: ["tool.js"],
          settings: [{ key: "api_token", type: "secret" }],
        },
      },
      {
        "tool.js": `
          export const definition = {
            name: "echo_secret",
            description: "returns the injected secret and whether fetch is host-guarded",
            parameters: { type: "object", properties: {} },
          };
          export async function execute(_input, ctx) {
            let blocked = false;
            try { await ctx.fetch("https://evil.example.org/"); }
            catch { blocked = true; }
            return { token: ctx.secrets.api_token ?? null, fetchBlocked: blocked };
          }
        `,
      },
    );

    // Store the secret BEFORE loading, so the runtime context is built with it.
    await setPluginSetting("mod-test", "api_token", "tok-123", [{ key: "api_token", type: "secret" }]);

    const loaded = await loadPlugins(root);
    const info = loaded.plugins.find((p) => p.name === "mod-test");
    expect(info?.error).toBeUndefined();

    const tool = loaded.tools.find((t) => t.name === "echo_secret");
    expect(tool).toBeDefined();

    const res = await tool!.execute({});
    expect(res.success).toBe(true);
    const data = (res.data as { result: { token: string; fetchBlocked: boolean } }).result;
    expect(data.token).toBe("tok-123");
    expect(data.fetchBlocked).toBe(true); // evil.example.org is not in allowedHosts
  });

  it("refuses module tools on a sandboxed (default trust) plugin", async () => {
    writePlugin(
      "sandbox-mod",
      {
        name: "sandbox-mod",
        version: "1.0.0",
        description: "should be rejected",
        provides: { moduleTools: ["tool.js"] },
      },
      { "tool.js": `export const name = "x"; export function execute() { return 1; }` },
    );

    const loaded = await loadPlugins(root);
    const info = loaded.plugins.find((p) => p.name === "sandbox-mod");
    expect(info?.error).toMatch(/trust/i);
    expect(loaded.tools.some((t) => t.name === "x")).toBe(false);
  });
});
