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
    "Home Assistant Steuerung. Natürliche Ziele können über entity_id oder target mit room/name/kind angegeben werden. " +
    "action=list_states (alle oder gefiltert nach domain/q), action=resolve_entities, action=get_state, action=get_weather/get_forecast, " +
    "action=call_service, action=turn_on/turn_off/toggle sowie Medienaktionen für Fernseher/media_player (play, pause, volume, source). " +
    "action=ping (Verbindung testen).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["ping", "list_states", "resolve_entities", "get_state", "get_weather", "get_forecast", "call_service", "turn_on", "turn_off", "toggle", "play", "pause", "stop", "next", "previous", "mute", "unmute", "volume_up", "volume_down", "set_volume", "select_source"],
        description: "Welche Operation ausgeführt wird",
      },
      domain: { type: "string", description: "Entity-Domain-Filter für list_states (z. B. light, switch, sensor) oder Service-Domain für call_service" },
      service: { type: "string", description: "Service-Name für call_service (z. B. turn_on, set_temperature, open_cover)" },
      entity_id: { type: "string", description: "Ziel-Entity, z. B. light.wohnzimmer" },
      q: { type: "string", description: "Freitext-Suche über entity_id/friendly_name für list_states" },
      data: { type: "object", description: "Zusätzliche Service-Daten für call_service, z. B. { brightness_pct: 50 }" },
      target: { type: "object", description: "Natürliches Ziel: { room/area, name, kind/domain, entity_id }. kind kann z. B. light, tv, media_player oder climate sein." },
      room: { type: "string", description: "Raum-/Area-Name als Kurzform für target.room" },
      name: { type: "string", description: "Friendly Name oder Alias des Geräts" },
      kind: { type: "string", description: "Geräteart, z. B. light, tv, media_player, climate oder weather" },
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
  // Additive migrations for databases created by older plugin versions.
  for (const column of [
    "area_id TEXT",
    "area_name TEXT",
    "device_class TEXT",
    "supported_features INTEGER",
  ]) {
    try { await storage.exec(`ALTER TABLE entities ADD COLUMN ${column}`); } catch { /* already exists */ }
  }
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

function toRow(entity, registry = {}) {
  const attrs = entity.attributes || {};
  const meta = registry[entity.entity_id] || {};
  return {
    entity_id: entity.entity_id,
    domain: domainOf(entity.entity_id),
    friendly_name: attrs.friendly_name || entity.entity_id,
    state: entity.state,
    unit: attrs.unit_of_measurement || null,
    attributes: JSON.stringify(attrs),
    area_id: meta.area_id || attrs.area_id || null,
    area_name: meta.area_name || attrs.area_name || null,
    device_class: meta.device_class || attrs.device_class || null,
    supported_features: Number(meta.supported_features ?? attrs.supported_features ?? 0),
    last_changed: entity.last_changed || null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertEntities(storage, rows) {
  for (const row of rows) {
    await storage.exec(
      "INSERT INTO entities (entity_id, domain, friendly_name, state, unit, attributes, area_id, area_name, device_class, supported_features, last_changed, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(entity_id) DO UPDATE SET domain=excluded.domain, friendly_name=excluded.friendly_name, " +
        "state=excluded.state, unit=excluded.unit, attributes=excluded.attributes, area_id=excluded.area_id, area_name=excluded.area_name, " +
        "device_class=excluded.device_class, supported_features=excluded.supported_features, last_changed=excluded.last_changed, updated_at=excluded.updated_at",
      [row.entity_id, row.domain, row.friendly_name, row.state, row.unit, row.attributes, row.area_id, row.area_name, row.device_class, row.supported_features, row.last_changed, row.updated_at]
    );
  }
}

function parseRow(row) {
  let attributes = {};
  if (row.attributes && typeof row.attributes === "object") attributes = row.attributes;
  else {
    try { attributes = JSON.parse(row.attributes || "{}"); }
    catch { attributes = {}; }
  }
  return { ...row, attributes, area_name: row.area_name || attributes.area_name || null };
}

async function cachedList(storage, domain, q) {
  const rows = await storage.query("SELECT * FROM entities ORDER BY domain, friendly_name");
  const needle = q ? String(q).toLowerCase() : "";
  return rows
    .filter((r) => !domain || r.domain === domain)
    .filter((r) => !needle || r.entity_id.toLowerCase().includes(needle) || String(r.friendly_name || "").toLowerCase().includes(needle))
    .map(parseRow);
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function targetInput(input) {
  const target = input.target && typeof input.target === "object" ? input.target : {};
  return {
    entity_id: String(target.entity_id || input.entity_id || "").trim(),
    room: String(target.room || target.area || input.room || "").trim(),
    name: String(target.name || input.name || "").trim(),
    kind: String(target.kind || target.domain || input.kind || input.domain || "").trim().toLowerCase(),
  };
}

function kindMatches(row, kind) {
  if (!kind) return true;
  const domain = row.domain;
  if (kind === "tv" || kind === "television" || kind === "fernseher") {
    const haystack = normalize(`${row.friendly_name} ${row.entity_id} ${row.device_class || ""}`);
    return domain === "media_player" && (row.device_class === "tv" || /(^| )(tv|fernseher|television)( |$)/.test(haystack));
  }
  if (kind === "weather" || kind === "wetter") return domain === "weather";
  return domain === kind || (kind === "plug" && domain === "switch");
}

function rowMatchesTarget(row, target) {
  if (target.entity_id && row.entity_id !== target.entity_id) return false;
  if (!kindMatches(row, target.kind)) return false;
  if (target.room) {
    const room = normalize(target.room);
    const rowRoom = normalize(row.area_name || row.attributes?.area_name || "");
    if (!rowRoom.includes(room) && !normalize(row.friendly_name).includes(room) && !normalize(row.entity_id).includes(room)) return false;
  }
  if (target.name) {
    const name = normalize(target.name);
    if (!normalize(row.friendly_name).includes(name) && !normalize(row.entity_id).includes(name)) return false;
  }
  return true;
}

function rankTarget(row, target) {
  let score = 0;
  if (target.entity_id === row.entity_id) score += 100;
  if (target.name && normalize(row.friendly_name) === normalize(target.name)) score += 50;
  if (target.room && normalize(row.area_name) === normalize(target.room)) score += 25;
  if (target.kind === "tv" && row.device_class === "tv") score += 20;
  return score;
}

function resolveRows(rows, input) {
  const target = targetInput(input);
  const matches = rows.filter((row) => rowMatchesTarget(row, target)).sort((a, b) => rankTarget(b, target) - rankTarget(a, target));
  return { target, matches };
}

async function loadRegistries(ctx, cfg) {
  const registry = {};
  try {
    const [entities, areas] = await Promise.all([
      haFetch(ctx, cfg, "/api/config/entity_registry"),
      haFetch(ctx, cfg, "/api/config/area_registry"),
    ]);
    const areaNames = new Map((Array.isArray(areas) ? areas : []).map((a) => [a.area_id, a.name]));
    for (const item of Array.isArray(entities) ? entities : []) {
      registry[item.entity_id] = {
        area_id: item.area_id || null,
        area_name: item.area_id ? areaNames.get(item.area_id) || null : null,
        device_class: item.device_class || null,
        supported_features: item.supported_features || 0,
      };
    }
  } catch { /* registry endpoints may be unavailable with limited HA permissions */ }
  return registry;
}

function publicEntity(row) {
  return { ...parseRow(row), area_name: row.area_name || null, device_class: row.device_class || null, supported_features: Number(row.supported_features || 0) };
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
      const registry = await loadRegistries(ctx, cfg);
      const rows = states.map((state) => toRow(state, registry));
      if (storage) await upsertEntities(storage, rows);
      const needle = input.q ? String(input.q).toLowerCase() : "";
      const entities = rows
        .filter((r) => !domain || r.domain === domain)
        .filter((r) => !needle || r.entity_id.toLowerCase().includes(needle) || String(r.friendly_name || "").toLowerCase().includes(needle))
        .map(publicEntity);
      return { count: entities.length, entities };
    } catch (error) {
      ctx.logger?.warn?.("homeassistant list_states failed, falling back to cache", { error: error instanceof Error ? error.message : String(error) });
      if (!storage) return { error: error instanceof Error ? error.message : String(error) };
      return { stale: true, error: error instanceof Error ? error.message : String(error), entities: await cachedList(storage, domain, input.q) };
    }
  }

  if (input.action === "resolve_entities") {
    const listed = await execute({ action: "list_states", domain: input.domain }, ctx);
    const rows = listed.entities || [];
    const resolved = resolveRows(rows, input);
    return {
      count: resolved.matches.length,
      entities: resolved.matches.map(publicEntity),
      ambiguous: resolved.matches.length > 1 && !resolved.target.entity_id,
      target: resolved.target,
    };
  }

  if (input.action === "get_weather" || input.action === "get_forecast") {
    const listed = await execute({ action: "list_states", domain: "weather" }, ctx);
    const resolved = resolveRows(listed.entities || [], { ...input, kind: "weather" });
    const entity = resolved.matches[0];
    if (!entity) return { error: "Keine Wetter-Entity in Home Assistant gefunden." };
    const forecast = Array.isArray(entity.attributes?.forecast) ? entity.attributes.forecast : [];
    return {
      entity: publicEntity(entity),
      location: entity.friendly_name,
      condition: entity.state,
      current: {
        temperature: entity.attributes?.temperature ?? null,
        apparent_temperature: entity.attributes?.apparent_temperature ?? null,
        humidity: entity.attributes?.humidity ?? null,
        wind_speed: entity.attributes?.wind_speed ?? null,
        unit: entity.attributes?.temperature_unit ?? entity.unit ?? null,
      },
      forecast: forecast.slice(0, input.action === "get_weather" ? 1 : 7),
      stale: listed.stale === true,
    };
  }

  if (input.action === "get_state") {
    if (!cfg) return { error: "Home Assistant ist nicht konfiguriert." };
    try {
      let entityId = input.entity_id;
      if (!entityId) {
        const listed = await execute({ ...input, action: "resolve_entities" }, ctx);
        if (listed.ambiguous) return { error: "Mehrere Geräte passen zum Ziel. Bitte Raum oder Gerätenamen präzisieren.", entities: listed.entities };
        entityId = listed.entities?.[0]?.entity_id;
      }
      if (!entityId) return { error: "Kein passendes Gerät gefunden." };
      const entity = await haFetch(ctx, cfg, `/api/states/${encodeURIComponent(entityId)}`);
      const row = toRow(entity);
      if (storage) await upsertEntities(storage, [row]);
      return publicEntity(row);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const mediaActions = new Set(["play", "pause", "stop", "next", "previous", "mute", "unmute", "volume_up", "volume_down", "set_volume", "select_source"]);
  if (input.action === "call_service" || input.action === "turn_on" || input.action === "turn_off" || input.action === "toggle" || mediaActions.has(input.action)) {
    if (!cfg) return { error: "Home Assistant ist nicht konfiguriert." };
    let entityId = input.entity_id;
    if (!entityId) {
      const listed = await execute({ ...input, action: "resolve_entities", kind: input.kind || input.target?.kind || (mediaActions.has(input.action) ? "tv" : undefined) }, ctx);
      if (listed.ambiguous) return { error: "Mehrere Geräte passen zum Ziel. Bitte Raum oder Gerätenamen präzisieren.", entities: listed.entities };
      entityId = listed.entities?.[0]?.entity_id;
    }
    if (!entityId) return { error: "Kein passendes Gerät gefunden." };

    const domain = input.action === "call_service" ? String(input.domain || domainOf(entityId)) : mediaActions.has(input.action) ? "media_player" : GENERIC_SERVICE_DOMAIN;
    const serviceMap = { play: "media_play", pause: "media_pause", stop: "media_stop", next: "media_next_track", previous: "media_previous_track", mute: "volume_mute", unmute: "volume_mute", volume_up: "volume_up", volume_down: "volume_down", set_volume: "volume_set", select_source: "select_source" };
    const service = input.action === "call_service" ? String(input.service || "") : serviceMap[input.action] || input.action;
    if (!service) return { error: "service ist erforderlich für action=call_service" };

    if (["lock", "unlock", "open_cover", "close_cover"].includes(service) && input.confirmed !== true) {
      return { requires_confirmation: true, error: "Diese Aktion benötigt eine explizite Bestätigung.", entity_id: entityId, service };
    }

    const serviceData = { entity_id: entityId, ...(input.data || {}) };
    if (input.action === "unmute") serviceData.is_volume_muted = false;

    try {
      await haFetch(ctx, cfg, `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
        method: "POST",
        body: JSON.stringify(serviceData),
      });
      const entity = await haFetch(ctx, cfg, `/api/states/${encodeURIComponent(entityId)}`);
      const row = toRow(entity);
      if (storage) await upsertEntities(storage, [row]);
      return { ok: true, entity: publicEntity(row), service, domain };
    } catch (error) {
      ctx.logger?.warn?.("homeassistant service call failed", { error: error instanceof Error ? error.message : String(error) });
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { error: `Unbekannte action: ${input.action}` };
}
