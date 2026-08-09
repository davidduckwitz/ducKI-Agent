import type { ToolResult, ToolExecutor } from "@ducki/shared";
import { z } from "zod";

/**
 * First-class weather tool. Fetches CURRENT weather (and a short daily outlook) for a
 * place name or coordinates via the free, key-less Open-Meteo API. Doing the geocode +
 * forecast round-trips server-side in ONE tool call is far more stable and faster than
 * asking a local model to chain two raw http calls and parse WMO codes itself.
 */

const WeatherInputSchema = z.object({
  // City / place name — geocoded automatically. Either this or latitude+longitude.
  location: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  // Number of forecast days to include in the outlook (0 = current only).
  days: z.number().int().min(0).max(7).optional(),
  // BCP-47-ish language for the geocoder's place labels.
  language: z.string().optional(),
});

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min: weather changes slowly; repeats stay instant + free.

/** WMO weather interpretation codes -> short German description. */
const WEATHER_CODE_DE: Record<number, string> = {
  0: "klar", 1: "überwiegend klar", 2: "teils bewölkt", 3: "bewölkt",
  45: "Nebel", 48: "Reifnebel",
  51: "leichter Nieselregen", 53: "Nieselregen", 55: "starker Nieselregen",
  56: "gefrierender Nieselregen", 57: "starker gefrierender Nieselregen",
  61: "leichter Regen", 63: "Regen", 65: "starker Regen",
  66: "gefrierender Regen", 67: "starker gefrierender Regen",
  71: "leichter Schneefall", 73: "Schneefall", 75: "starker Schneefall", 77: "Schneegriesel",
  80: "leichte Regenschauer", 81: "Regenschauer", 82: "heftige Regenschauer",
  85: "leichte Schneeschauer", 86: "starke Schneeschauer",
  95: "Gewitter", 96: "Gewitter mit leichtem Hagel", 99: "Gewitter mit starkem Hagel",
};

interface CacheEntry { at: number; data: unknown; }
const cache = new Map<string, CacheEntry>();

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function geocode(name: string, language: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=${encodeURIComponent(language)}&format=json`;
  const json = (await fetchJson(url)) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string; admin1?: string }> };
  const hit = json.results?.[0];
  if (!hit) return null;
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
  return { lat: hit.latitude, lon: hit.longitude, label };
}

export const weatherTool: ToolExecutor = {
  name: "weather",
  description:
    "Get the CURRENT weather (temperature, wind, precipitation, conditions) and a short daily outlook for a city name or coordinates. Free, no API key. Use this for any 'what's the weather' question instead of asking the user for measurements.",
  definition: {
    name: "weather",
    description: "Fetch current weather + short forecast for a place (Open-Meteo, no key required).",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City / place name, e.g. 'Fulda'. Geocoded automatically. Provide this OR latitude+longitude." },
        latitude: { type: "number", description: "Latitude (use with longitude to skip geocoding)" },
        longitude: { type: "number", description: "Longitude (use with latitude to skip geocoding)" },
        days: { type: "number", description: "Forecast days to include in the outlook (0-7, default 2)" },
        language: { type: "string", description: "Language for place labels (default 'de')" },
      },
      required: [],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = WeatherInputSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, data: null, error: parsed.error.message };
    }
    const { location, latitude, longitude, language = "de" } = parsed.data;
    const days = parsed.data.days ?? 2;

    try {
      let lat = latitude;
      let lon = longitude;
      let label = location ?? (lat !== undefined && lon !== undefined ? `${lat},${lon}` : "");

      if (lat === undefined || lon === undefined) {
        if (!location) {
          return { success: false, data: null, error: "Provide a 'location' (city name) or both 'latitude' and 'longitude'." };
        }
        const geo = await geocode(location, language);
        if (!geo) {
          return { success: false, data: null, error: `No place found for '${location}'. Try a more specific name or pass latitude/longitude.` };
        }
        lat = geo.lat; lon = geo.lon; label = geo.label;
      }

      const roundedKey = `${lat.toFixed(2)},${lon.toFixed(2)},${days}`;
      const cached = cache.get(roundedKey);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return { success: true, data: { ...(cached.data as object), cached: true } };
      }

      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
        timezone: "auto",
      });
      if (days > 0) {
        params.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum");
        params.set("forecast_days", String(days));
      }
      const forecast = (await fetchJson(`${FORECAST_URL}?${params.toString()}`)) as {
        current?: Record<string, number>;
        current_units?: Record<string, string>;
        daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_sum?: number[] };
      };

      const c = forecast.current ?? {};
      const code = Number(c["weather_code"]);
      const current = {
        temperatureC: c["temperature_2m"],
        feelsLikeC: c["apparent_temperature"],
        humidityPct: c["relative_humidity_2m"],
        precipitationMm: c["precipitation"],
        windKmh: c["wind_speed_10m"],
        condition: WEATHER_CODE_DE[code] ?? `Wettercode ${code}`,
      };
      const outlook = (forecast.daily?.time ?? []).map((date, i) => ({
        date,
        condition: WEATHER_CODE_DE[Number(forecast.daily?.weather_code?.[i])] ?? undefined,
        maxC: forecast.daily?.temperature_2m_max?.[i],
        minC: forecast.daily?.temperature_2m_min?.[i],
        precipitationMm: forecast.daily?.precipitation_sum?.[i],
      }));

      const summary = `Wetter in ${label}: ${current.condition}, ${current.temperatureC ?? "?"}°C`
        + (current.feelsLikeC !== undefined ? ` (gefühlt ${current.feelsLikeC}°C)` : "")
        + `, Wind ${current.windKmh ?? "?"} km/h, Niederschlag ${current.precipitationMm ?? 0} mm.`;

      const data = { location: label, latitude: lat, longitude: lon, summary, current, outlook };
      cache.set(roundedKey, { at: Date.now(), data });
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /abort/i.test(message) ? " (timeout - the weather service was slow, try again)" : "";
      return { success: false, data: null, error: `Weather lookup failed: ${message}${hint}` };
    }
  },
};
