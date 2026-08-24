import { api } from "./api";
import { useServerQuery } from "./useServerQuery";

export interface SettingEntry {
  key: string;
  value: string;
}

/**
 * One shared settings query for the whole app.
 *
 * Layout, App's coding gate, CodingSidebarPanel and CodingWorkspace each ran their own
 * `settings.list()` on a 5-second interval - four identical requests every five seconds,
 * ~48 per minute, purely to notice an edit. They now share this cache, which never goes
 * stale on a timer and is invalidated by the server's `settings:changed` event
 * (see useSettingsChangeListener).
 */
export function useSettings() {
  return useServerQuery<SettingEntry[]>({
    queryKey: ["settings"],
    queryFn: () => api.settings.list() as Promise<SettingEntry[]>,
    staleTime: Infinity,
  });
}

export function readFlag(settings: SettingEntry[] | undefined, key: string): boolean {
  return String(settings?.find((s) => s.key === key)?.value ?? "false").trim().toLowerCase() === "true";
}

/** Parses a numeric setting; falls back to `fallback` when unset, blank or not a positive number. */
export function readNumber(settings: SettingEntry[] | undefined, key: string, fallback: number): number {
  const raw = settings?.find((s) => s.key === key)?.value;
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** True once the settings have actually been loaded, so callers can avoid acting on defaults. */
export function settingsReady(query: ReturnType<typeof useSettings>): boolean {
  return !query.isLoading && Boolean(query.data);
}
