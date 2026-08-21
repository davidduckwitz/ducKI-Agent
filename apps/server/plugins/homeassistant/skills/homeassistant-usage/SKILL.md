---
name: homeassistant-usage
description: How to read device states and control smart-home devices via the homeassistant tool (Home Assistant). Use when the user asks about lights, switches, sensors, thermostats, covers/rollos, locks, or media players in their home, or wants to turn something on/off/toggle it.
---

# Home Assistant

The `homeassistant` tool talks to a Home Assistant instance configured in this plugin's settings (base URL + long-lived access token). It also caches the last known state of every entity in this plugin's OWN SQLite database, so a brief connection drop doesn't lose the dashboard.

List devices (optionally filtered by domain or free-text search):
```
[TOOL:homeassistant({"action": "list_states", "domain": "light"})]
[TOOL:homeassistant({"action": "list_states", "q": "wohnzimmer"})]
```

Read a single entity's current state:
```
[TOOL:homeassistant({"action": "get_state", "entity_id": "sensor.aussentemperatur"})]
```

Turn something on/off or toggle it — these work across almost any domain (light, switch, fan, lock, cover, ...), no need to know the exact service:
```
[TOOL:homeassistant({"action": "turn_on", "entity_id": "light.wohnzimmer"})]
[TOOL:homeassistant({"action": "turn_off", "entity_id": "switch.kaffeemaschine"})]
[TOOL:homeassistant({"action": "toggle", "entity_id": "light.flur"})]
```

For anything more specific (dimming, thermostat target temperature, opening/closing a cover, media player controls), call the domain's own service directly:
```
[TOOL:homeassistant({"action": "call_service", "domain": "light", "service": "turn_on", "entity_id": "light.wohnzimmer", "data": {"brightness_pct": 40}})]
[TOOL:homeassistant({"action": "call_service", "domain": "climate", "service": "set_temperature", "entity_id": "climate.wohnzimmer", "data": {"temperature": 21}})]
[TOOL:homeassistant({"action": "call_service", "domain": "cover", "service": "close_cover", "entity_id": "cover.rollo_kueche"})]
```

Test the connection (base URL/token reachable):
```
[TOOL:homeassistant({"action": "ping"})]
```

- Entity IDs always look like `domain.name`, e.g. `light.wohnzimmer`, `sensor.aussentemperatur`, `climate.buero`.
- If the tool returns `stale: true`, Home Assistant was unreachable and the result is the last cached snapshot — mention that to the user.
- If it returns an error about missing base_url/access_token, tell the user to configure the Home Assistant plugin settings (base URL + long-lived access token from their HA profile).
