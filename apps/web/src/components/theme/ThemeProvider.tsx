import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_THEME_MODE,
  THEME_ACCENT_KEY,
  THEME_MODE_KEY,
  THEME_MODES,
  applyTheme,
  isAccentColor,
  isThemeMode,
  resolveMode,
  type AccentColor,
  type ThemeMode,
} from "../../lib/theme";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: "light" | "dark";
  accent: AccentColor;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME_MODE;
  const stored = window.localStorage.getItem(THEME_MODE_KEY);
  return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
}

function readInitialAccent(): AccentColor {
  if (typeof window === "undefined") return DEFAULT_ACCENT_COLOR;
  const stored = window.localStorage.getItem(THEME_ACCENT_KEY);
  return isAccentColor(stored) ? stored : DEFAULT_ACCENT_COLOR;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);
  const [accent, setAccentState] = useState<AccentColor>(readInitialAccent);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    applyTheme(mode, accent);
  }, [mode, accent, systemPrefersDark]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modeSetting, accentSetting] = await Promise.all([
          api.settings.get(THEME_MODE_KEY),
          api.settings.get(THEME_ACCENT_KEY),
        ]);
        if (cancelled) return;
        if (isThemeMode(modeSetting?.value)) {
          setModeState(modeSetting.value);
          window.localStorage.setItem(THEME_MODE_KEY, modeSetting.value);
        }
        if (isAccentColor(accentSetting?.value)) {
          setAccentState(accentSetting.value);
          window.localStorage.setItem(THEME_ACCENT_KEY, accentSetting.value);
        }
      } catch {
        // Backend evtl. noch nicht erreichbar - lokaler Wert bleibt gueltig.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    window.localStorage.setItem(THEME_MODE_KEY, next);
    api.settings.set(THEME_MODE_KEY, next).catch(() => {});
  }, []);

  const setAccent = useCallback((next: AccentColor) => {
    setAccentState(next);
    window.localStorage.setItem(THEME_ACCENT_KEY, next);
    api.settings.set(THEME_ACCENT_KEY, next).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedMode: resolveMode(mode), accent, setMode, setAccent }),
    [mode, accent, setMode, setAccent]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

export { THEME_MODES, ACCENT_COLORS };
