import { openPluginDb } from "./plugin-storage.js";
import { encryptSecret, decryptSecret } from "./plugin-secrets.js";

/**
 * Per-plugin settings + secrets store. Values live in the plugin's OWN SQLite kv table
 * (plugins/<name>/data/<name>.sqlite) - the same isolated database plugin-storage already
 * manages - so a plugin's config is deleted with the plugin's folder and never bloats the
 * main database. Secrets (type: "secret") are encrypted at rest and are NEVER returned in
 * clear text to the management API; they are only decrypted for the tool runtime context.
 *
 * KV key layout: `setting:<key>` = JSON-encoded value, `secret:<key>` = encrypted blob.
 */

/** Minimal shape of a plugin setting spec (kept local so this file has no schema dependency). */
export interface PluginSettingSpecLike {
  key: string;
  type?: "string" | "number" | "boolean" | "select" | "secret";
  default?: string | number | boolean;
}

/** Decrypted config handed to the tool runtime (settings + secrets separated). */
export interface PluginRuntimeConfig {
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

const SETTING_PREFIX = "setting:";
const SECRET_PREFIX = "secret:";
const SECRET_MASK = "***";

function isSecret(spec: PluginSettingSpecLike): boolean {
  return spec.type === "secret";
}

/** Coerce a raw string setting to the spec's declared type. */
function coerce(spec: PluginSettingSpecLike, raw: string): unknown {
  if (spec.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.type === "boolean") return raw === "true" || raw === "1";
  return raw;
}

/**
 * Masked view for the management UI: real values for plain settings, `"***"` for secrets that
 * are set (never the secret itself), and `null`/default for unset keys. Only keys declared in
 * `specs` are surfaced.
 */
export async function getPluginSettings(
  name: string,
  specs: PluginSettingSpecLike[],
): Promise<Record<string, unknown>> {
  if (specs.length === 0) return {};
  const db = openPluginDb(name);
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    if (isSecret(spec)) {
      const stored = await db.get(`${SECRET_PREFIX}${spec.key}`);
      out[spec.key] = stored ? SECRET_MASK : null;
      continue;
    }
    const stored = await db.get(`${SETTING_PREFIX}${spec.key}`);
    out[spec.key] = stored !== undefined ? coerce(spec, stored) : spec.default ?? null;
  }
  return out;
}

/**
 * Persist one setting. Secret-typed keys are encrypted; a value equal to the mask (`"***"`)
 * is ignored so re-saving the masked UI form never overwrites a stored secret. An empty
 * string clears the key.
 */
export async function setPluginSetting(
  name: string,
  key: string,
  value: unknown,
  specs: PluginSettingSpecLike[],
): Promise<void> {
  const spec = specs.find((s) => s.key === key);
  if (!spec) throw new Error(`Unknown setting '${key}' for plugin '${name}'`);
  const db = openPluginDb(name);

  if (isSecret(spec)) {
    const str = value == null ? "" : String(value);
    if (str === SECRET_MASK) return; // unchanged masked value from the UI
    if (str === "") {
      await db.delete(`${SECRET_PREFIX}${key}`);
      return;
    }
    await db.set(`${SECRET_PREFIX}${key}`, encryptSecret(str));
    return;
  }

  const str = value == null ? "" : String(value);
  await db.set(`${SETTING_PREFIX}${key}`, str);
}

/**
 * Decrypted runtime config for the tool context. Plain settings fall back to the spec default;
 * secrets are decrypted (omitted when unset). Never expose the result through an API.
 */
export async function getPluginRuntimeConfig(
  name: string,
  specs: PluginSettingSpecLike[],
): Promise<PluginRuntimeConfig> {
  const settings: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  if (specs.length === 0) return { settings, secrets };

  const db = openPluginDb(name);
  for (const spec of specs) {
    if (isSecret(spec)) {
      const stored = await db.get(`${SECRET_PREFIX}${spec.key}`);
      if (stored) {
        // A secret encrypted under a different key (moved machine / rotated key) must not brick
        // the whole plugin - treat it as unset so the plugin still loads and can be reconfigured.
        try {
          secrets[spec.key] = decryptSecret(stored);
        } catch {
          // leave unset
        }
      }
      continue;
    }
    const stored = await db.get(`${SETTING_PREFIX}${spec.key}`);
    settings[spec.key] = stored !== undefined ? coerce(spec, stored) : spec.default;
  }
  return { settings, secrets };
}
