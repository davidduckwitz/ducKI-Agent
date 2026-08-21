/**
 * Home Assistant connector module tool (trust: "node"). Talks to the HA REST API
 * (base_url + long-lived access token from plugin settings/secrets) and caches the
 * last known entity states in the plugin's own SQLite DB (ctx.storage) so the
 * dashboard has something to show even if HA is briefly unreachable.
 */

const GENERIC_SERVICE_DOMAIN = "homeassistant";

export const definition = {
  name: "homeassistant",
  description:
    "Home Assistant Steuerung. action=list_states (alle oder gefiltert nach domain/q), action=get_state (entity_id), " +
    "action=call_service (domain, service, entity_id, data), action=turn_on/turn_off/toggle (entity_id, funktioniert domänenübergreifend), " +
    "action=ping (Verbindung testen).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["ping", "list_states", "get_state", "call_service", "turn_on", "turn_off", "toggle"],
        description: "Welche Operation ausgeführt wird",
      },
      domain: { type: "string", description: "Entity-Domain-Filter für list_states (z. B. light, switch, sensor) oder Service-Domain für call_service" },
      service: { type: "string", description: "Service-Name für call_service (z. B. turn_on, set_temperature, open_cover)" },
      entity_id: { type: "string", description: "Ziel-Entity, z. B. light.wohnzimmer" },
      q: { type: "string", description: "Freitext-Suche über entity_id/friendly_name für list_states" },
      data: { type: "object", description: "Zusätzliche Service-Daten für call_service, z. B. { brightness_pct: 50 }" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS entities (" +
      "entity_id TEXT PRIMARY KEY, " +
      "domain TEXT NOT NULL, " +
      "friendly_name TEXT, " +
      "state TEXT, " +
      "unit TEXT, " +
      "attributes TEXT, " +
      "last_changed TEXT, " +
      "updated_at TEXT NOT NULL" +
      ")"
  );
}

function domainOf(entityId) {
  return String(entityId || "").split(".")[0] || "";
}

function config(ctx) {
  const baseUrl = String(ctx.settings.base_url || "").trim().replace(/\/+$/, "");
  const token = ctx.secrets.access_token;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function haFetch(ctx, cfg, path, init) {
  const res = await ctx.fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...(init && init.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Home Assistant API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

function toRow(entity) {
  const attrs = entity.attributes || {};
  return {
    entity_id: entity.entity_id,
    domain: domainOf(entity.entity_id),
    friendly_name: attrs.friendly_name || entity.entity_id,
    state: entity.state,
    unit: attrs.unit_of_measurement || null,
    attributes: JSON.stringify(attrs),
    last_changed: entity.last_changed || null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertEntities(storage, rows) {
  for (const row of rows) {
    await storage.exec(
      "INSERT INTO entities (entity_id, domain, friendly_name, state, unit, attributes, last_changed, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(entity_id) DO UPDATE SET domain=excluded.domain, friendly_name=excluded.friendly_name, " +
        "state=excluded.state, unit=excluded.unit, attributes=excluded.attributes, last_changed=excluded.last_changed, updated_at=excluded.updated_at",
      [row.entity_id, row.domain, row.friendly_name, row.state, row.unit, row.attributes, row.last_changed, row.updated_at]
    );
  }
}

function parseRow(row) {
  let attributes = {};
  try {
    attributes = JSON.parse(row.attributes || "{}");
  } catch {
    attributes = {};
  }
  return { ...row, attributes };
}

async function cachedList(storage, domain, q) {
  const rows = await storage.query("SELECT * FROM entities ORDER BY domain, friendly_name");
  const needle = q ? String(q).toLowerCase() : "";
  return rows
    .filter((r) => !domain || r.domain === domain)
    .filter((r) => !needle || r.entity_id.toLowerCase().includes(needle) || String(r.friendly_name || "").toLowerCase().includes(needle))
    .map(parseRow);
}

export async function execute(input, ctx) {
  const cfg = config(ctx);
  const storage = ctx.storage;
  if (storage) await ensureSchema(storage);

  if (input.action === "ping") {
    if (!cfg) return { ok: false, error: "Basis-URL oder Access-Token fehlt. Bitte in den Plugin-Einstellungen konfigurieren." };
    try {
      const res = await haFetch(ctx, cfg, "/api/");
      return { ok: true, message: (res && res.message) || "Verbindung erfolgreich." };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (input.action === "list_states") {
    const domain = input.domain ? String(input.domain) : undefined;
    if (!cfg) {
      if (!storage) return { error: "Home Assistant ist nicht konfiguriert." };
      return { stale: true, error: "Home Assistant ist nicht konfiguriert.", entities: await cachedList(storage, domain, input.q) };
    }
    try {
      const states = await haFetch(ctx, cfg, "/api/states");
      const rows = states.map(toRow);
      if (storage) await upsertEntities(storage, rows);
      const needle = input.q ? String(input.q).toLowerCase() : "";
      const entities = rows
        .filter((r) => !domain || r.domain === domain)
        .filter((r) => !needle || r.entity_id.toLowerCase().includes(needle) || String(r.friendly_name || "").toLowerCase().includes(needle))
        .map((r) => ({ ...r, attributes: JSON.parse(r.attributes) }));
      return { count: entities.length, entities };
    } catch (error) {
      ctx.logger?.warn?.("homeassistant list_states failed, falling back to cache", { error: error instanceof Error ? error.message : String(error) });
      if (!storage) return { error: error instanceof Error ? error.message : String(error) };
      return { stale: true, error: error instanceof Error ? error.message : String(error), entities: await cachedList(storage, domain, input.q) };
    }
  }

  if (input.action === "get_state") {
    if (!input.entity_id) return { error: "entity_id ist erforderlich" };
    if (!cfg) return { error: "Home Assistant ist nicht konfiguriert." };
    try {
      const entity = await haFetch(ctx, cfg, `/api/states/${encodeURIComponent(input.entity_id)}`);
      const row = toRow(entity);
      if (storage) await upsertEntities(storage, [row]);
      return parseRow(row);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (input.action === "call_service" || input.action === "turn_on" || input.action === "turn_off" || input.action === "toggle") {
    if (!cfg) return { error: "Home Assistant ist nicht konfiguriert." };
    if (!input.entity_id) return { error: "entity_id ist erforderlich" };

    const domain = input.action === "call_service" ? String(input.domain || domainOf(input.entity_id)) : GENERIC_SERVICE_DOMAIN;
    const service = input.action === "call_service" ? String(input.service || "") : input.action;
    if (!service) return { error: "service ist erforderlich für action=call_service" };

    try {
      await haFetch(ctx, cfg, `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
        method: "POST",
        body: JSON.stringify({ entity_id: input.entity_id, ...(input.data || {}) }),
      });
      const entity = await haFetch(ctx, cfg, `/api/states/${encodeURIComponent(input.entity_id)}`);
      const row = toRow(entity);
      if (storage) await upsertEntities(storage, [row]);
      return { ok: true, entity: parseRow(row) };
    } catch (error) {
      ctx.logger?.warn?.("homeassistant service call failed", { error: error instanceof Error ? error.message : String(error) });
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { error: `Unbekannte action: ${input.action}` };
}
