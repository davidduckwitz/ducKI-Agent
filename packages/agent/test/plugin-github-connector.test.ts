import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugins, parseOAuthConfig } from "../src/plugins/index.ts";
import { setPluginSetting, closeAllPluginDbs } from "@ducki/database";

const CONNECTOR_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/server/plugins/github-connector");
let root: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // Copy the real connector into a temp plugins dir so the test never writes into the repo.
  root = mkdtempSync(join(tmpdir(), "ducki-gh-"));
  // Skip data/ so a secret encrypted under the server's key doesn't come along into the
  // test's fresh-key sandbox.
  cpSync(CONNECTOR_SRC, join(root, "github-connector"), {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes("data"),
  });
  process.env.DUCKI_PLUGINS_DIR = root;
  delete process.env.DUCKI_SECRET_KEY;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  closeAllPluginDbs();
  delete process.env.DUCKI_PLUGINS_DIR;
});

describe("github-connector example plugin", () => {
  it("loads with its oauth config, settings page, trust and tool", async () => {
    const loaded = await loadPlugins(root);
    const info = loaded.plugins.find((p) => p.name === "github-connector");
    expect(info).toBeDefined();
    expect(info?.error).toBeUndefined();
    expect(info?.trust).toBe("node");
    expect(info?.settingsPage).toBe("settings/index.html");
    expect(info?.oauth[0]?.id).toBe("github");
    expect(info?.oauth[0]?.tokenUrl).toContain("github.com/login/oauth/access_token");
    expect(loaded.tools.some((t) => t.name === "github")).toBe(true);
  });

  it("errors clearly when no token is configured", async () => {
    const loaded = await loadPlugins(root);
    const tool = loaded.tools.find((t) => t.name === "github")!;
    const res = await tool.execute({ action: "whoami" });
    expect(res.success).toBe(true);
    expect((res.data as { result: { error?: string } }).result.error).toMatch(/token/i);
  });

  it("injects the stored secret and calls the API through the guarded fetch", async () => {
    await setPluginSetting("github-connector", "access_token", "gho_test_token", [
      { key: "access_token", type: "secret" },
    ]);

    let sawAuth: string | undefined;
    let sawUrl: string | undefined;
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      sawUrl = String(url);
      sawAuth = init?.headers?.Authorization;
      return new Response(JSON.stringify({ login: "octocat", name: "The Octocat", public_repos: 8, followers: 99 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const loaded = await loadPlugins(root); // reload so ctx.secrets picks up the token
    const tool = loaded.tools.find((t) => t.name === "github")!;
    const res = await tool.execute({ action: "whoami" });

    expect(res.success).toBe(true);
    const data = (res.data as { result: { login?: string; error?: string } }).result;
    expect(data.error).toBeUndefined();
    expect(data.login).toBe("octocat");
    expect(sawUrl).toBe("https://api.github.com/user");
    expect(sawAuth).toBe("Bearer gho_test_token");
  });

  it("rejects a malformed oauth config", () => {
    expect(parseOAuthConfig("{ not json").ok).toBe(false);
    expect(parseOAuthConfig(JSON.stringify({ id: "x" })).ok).toBe(false); // missing required fields
  });
});
