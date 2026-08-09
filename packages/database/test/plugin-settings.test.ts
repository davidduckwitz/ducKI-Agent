import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPluginSettings,
  setPluginSetting,
  getPluginRuntimeConfig,
  type PluginSettingSpecLike,
} from "../src/plugin-settings.js";
import { closeAllPluginDbs } from "../src/plugin-storage.js";

const specs: PluginSettingSpecLike[] = [
  { key: "region", type: "string", default: "eu" },
  { key: "max_items", type: "number", default: 10 },
  { key: "api_token", type: "secret" },
];

beforeAll(() => {
  process.env.DUCKI_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "ducki-settings-"));
  delete process.env.DUCKI_SECRET_KEY;
});
afterAll(() => {
  closeAllPluginDbs();
  delete process.env.DUCKI_PLUGINS_DIR;
});

describe("plugin settings store", () => {
  const plugin = "settings-test";

  it("returns defaults and null secret before anything is set", async () => {
    const values = await getPluginSettings(plugin, specs);
    expect(values).toEqual({ region: "eu", max_items: 10, api_token: null });
  });

  it("persists plain settings with type coercion", async () => {
    await setPluginSetting(plugin, "region", "us", specs);
    await setPluginSetting(plugin, "max_items", 42, specs);
    const values = await getPluginSettings(plugin, specs);
    expect(values.region).toBe("us");
    expect(values.max_items).toBe(42);
  });

  it("masks a stored secret in the API view but decrypts it for the runtime", async () => {
    await setPluginSetting(plugin, "api_token", "secret-abc", specs);

    const masked = await getPluginSettings(plugin, specs);
    expect(masked.api_token).toBe("***");

    const runtime = await getPluginRuntimeConfig(plugin, specs);
    expect(runtime.secrets.api_token).toBe("secret-abc");
    expect(runtime.settings.region).toBe("us");
    expect(runtime.settings.max_items).toBe(42);
  });

  it("ignores a masked value so it never overwrites a stored secret", async () => {
    await setPluginSetting(plugin, "api_token", "***", specs);
    const runtime = await getPluginRuntimeConfig(plugin, specs);
    expect(runtime.secrets.api_token).toBe("secret-abc");
  });

  it("clears a secret when set to empty string", async () => {
    await setPluginSetting(plugin, "api_token", "", specs);
    const runtime = await getPluginRuntimeConfig(plugin, specs);
    expect(runtime.secrets.api_token).toBeUndefined();
  });

  it("rejects unknown setting keys", async () => {
    await expect(setPluginSetting(plugin, "nope", "x", specs)).rejects.toThrow();
  });
});
