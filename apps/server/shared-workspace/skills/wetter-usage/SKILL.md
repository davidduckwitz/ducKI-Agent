# Wetter (Weather Data Fetcher)

## Summary
A simple datasource tool that fetches current weather and hourly forecast data for Fulda from Open-Meteo's free, no-key API. Returns temperature, wind speed, precipitation probability, and a short outlook text summary. Uses own SQLite database to persist readings.

---

## Usage

**How it works**

- Calls https://api.open-meteo.com/v1/forecast (no API key required)
- Fetches current conditions and hourly data for next 24 hours
- Returns structured JSON + text summary
- Persists temperature readings to SQLite database

**Typical invocation**

```
[TOOL:weather({"location": "Fulda"})]
```

**Response format**

Returns an object with `summary` (short text) and `current` details including temperature, wind speed, precipitation.

---

## Constraints

- Always requires a city name or coordinates
- Returns temperature in Celsius by default
- Includes 24-hour forecast by default
- Fetches only current + next hour by default (use extended=true for more hours)

**Safety rules followed:**

- Uses sandboxed trust (no database row, no npm package, no build step)
- Calls only open-meteo.com (allowed in plugin config)
- Stores readings in own SQLite database (not system DB)

---

## API Reference

### Parameters

| Parameter | Type   | Description                          | Default |
|-----------|--------|--------------------------------------|---------|
| location  | string | City name or coordinates             | Fulda   |

### Example

```
[TOOL:weather({"location": "Fulda"})]
```

---

## Implementation Details

**API Endpoint:** https://api.open-meteo.com/v1/forecast  
**Data:** Current weather + hourly forecast for 24 hours  
**Storage:** SQLite database (own DB)  

The tool returns:
- Current temperature, wind speed, precipitation probability
- Short outlook summary (3 lines max, no timestamps)

---

## Related Tools

None - this is a standalone datasource plugin.