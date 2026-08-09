import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManager } from "./plugin-manager";
import { agentRegistry } from "./agent-registry";
import { closeAllPluginDbs } from "@ducki/database";

// Point at the repo's real plugins/ so loadPlugins finds the reference plugins.
process.env.DUCKI_PLUGINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../plugins");

afterEach(() => {
  closeAllPluginDbs();
});

describe("PluginManager idle-gated hot reload", () => {
  it("applies immediately when no agent is active", () => {
    const mgr = new PluginManager();
    expect(agentRegistry.snapshot().runningCount).toBe(0);
    const res = mgr.requestReload();
    expect(res).toEqual({ applied: true, deferred: false });
    expect(mgr.isReloadPending()).toBe(false);
  });

  it("defers while an agent is active, then applies when it finishes", () => {
    const mgr = new PluginManager();
    const runId = agentRegistry.register({ source: "chat_ws" });
    try {
      const res = mgr.requestReload();
      expect(res).toEqual({ applied: false, deferred: true });
      expect(mgr.isReloadPending()).toBe(true);
    } finally {
      agentRegistry.unregister(runId); // last agent finishes -> subscription applies the reload
    }
    expect(mgr.isReloadPending()).toBe(false);
  });

  it("exposes the loaded plugin tools", () => {
    const mgr = new PluginManager();
    const names = mgr.getTools().map((t) => t.name);
    expect(names).toContain("exchange_rates");
    expect(names).toContain("notes");
  });
});
