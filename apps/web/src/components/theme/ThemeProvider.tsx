import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_THEME_CUSTOMIZATION,
  DEFAULT_THEME_MODE,
  THEME_ACCENT_KEY,
  THEME_MODE_KEY,
  THEME_DARK_BACKGROUND_KEY,
  THEME_DARK_CARD_KEY,
  THEME_FONT_KEY,
  THEME_FONT_SIZE_KEY,
  THEME_LIGHT_BACKGROUND_KEY,
  THEME_LIGHT_CARD_KEY,
  THEME_RADIUS_KEY,
  THEME_MODES,
  applyTheme,
  clampThemeNumber,
  isAccentColor,
  isHexColor,
  isThemeFont,
  isThemeMode,
  resolveMode,
  type AccentColor,
  type ThemeMode,
  type ThemeFont,
} from "../../lib/theme";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: "light" | "dark";
  accent: AccentColor;
  lightBackground: string;
  darkBackground: string;
  lightCard: string;
  darkCard: string;
  font: ThemeFont;
  fontSize: number;
  radius: number;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
  setLightBackground: (color: string) => void;
  setDarkBackground: (color: string) => void;
  setLightCard: (color: string) => void;
  setDarkCard: (color: string) => void;
  setFont: (font: ThemeFont) => void;
  setFontSize: (size: number) => void;
  setRadius: (radius: number) => void;
  resetCustomization: () => void;
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

function readStoredString<T extends string>(key: string, fallback: T, validator: (value: unknown) => value is T): T {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return validator(value) ? value : fallback;
}

function readStoredNumber(key: string, min: number, max: number, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  return clampThemeNumber(window.localStorage.getItem(key), min, max, fallback);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readInitialMode);
  const [accent, setAccentState] = useState<AccentColor>(readInitialAccent);
  const [lightBackground, setLightBackgroundState] = useState(() => readStoredString(THEME_LIGHT_BACKGROUND_KEY, DEFAULT_THEME_CUSTOMIZATION.lightBackground, isHexColor));
  const [darkBackground, setDarkBackgroundState] = useState(() => readStoredString(THEME_DARK_BACKGROUND_KEY, DEFAULT_THEME_CUSTOMIZATION.darkBackground, isHexColor));
  const [lightCard, setLightCardState] = useState(() => readStoredString(THEME_LIGHT_CARD_KEY, DEFAULT_THEME_CUSTOMIZATION.lightCard, isHexColor));
  const [darkCard, setDarkCardState] = useState(() => readStoredString(THEME_DARK_CARD_KEY, DEFAULT_THEME_CUSTOMIZATION.darkCard, isHexColor));
  const [font, setFontState] = useState<ThemeFont>(() => readStoredString(THEME_FONT_KEY, DEFAULT_THEME_CUSTOMIZATION.font, isThemeFont));
  const [fontSize, setFontSizeState] = useState(() => readStoredNumber(THEME_FONT_SIZE_KEY, 14, 19, DEFAULT_THEME_CUSTOMIZATION.fontSize));
  const [radius, setRadiusState] = useState(() => readStoredNumber(THEME_RADIUS_KEY, 0, 20, DEFAULT_THEME_CUSTOMIZATION.radius));
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
    applyTheme(mode, accent, { lightBackground, darkBackground, lightCard, darkCard, font, fontSize, radius });
  }, [mode, accent, lightBackground, darkBackground, lightCard, darkCard, font, fontSize, radius, systemPrefersDark]);

  useEffect(() => {
    const handleNativeTheme = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (!isThemeMode(next)) return;
      setModeState(next);
      window.localStorage.setItem(THEME_MODE_KEY, next);
      api.settings.set(THEME_MODE_KEY, next).catch(() => {});
    };
    window.addEventListener("ducki:set-theme", handleNativeTheme);
    return () => window.removeEventListener("ducki:set-theme", handleNativeTheme);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modeSetting, accentSetting, lightBackgroundSetting, darkBackgroundSetting, lightCardSetting, darkCardSetting, fontSetting, fontSizeSetting, radiusSetting] = await Promise.all([
          api.settings.get(THEME_MODE_KEY),
          api.settings.get(THEME_ACCENT_KEY),
          api.settings.get(THEME_LIGHT_BACKGROUND_KEY),
          api.settings.get(THEME_DARK_BACKGROUND_KEY),
          api.settings.get(THEME_LIGHT_CARD_KEY),
          api.settings.get(THEME_DARK_CARD_KEY),
          api.settings.get(THEME_FONT_KEY),
          api.settings.get(THEME_FONT_SIZE_KEY),
          api.settings.get(THEME_RADIUS_KEY),
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
        if (isHexColor(lightBackgroundSetting?.value)) {
          setLightBackgroundState(lightBackgroundSetting.value);
          window.localStorage.setItem(THEME_LIGHT_BACKGROUND_KEY, lightBackgroundSetting.value);
        }
        if (isHexColor(darkBackgroundSetting?.value)) {
          setDarkBackgroundState(darkBackgroundSetting.value);
          window.localStorage.setItem(THEME_DARK_BACKGROUND_KEY, darkBackgroundSetting.value);
        }
        if (isHexColor(lightCardSetting?.value)) {
          setLightCardState(lightCardSetting.value);
          window.localStorage.setItem(THEME_LIGHT_CARD_KEY, lightCardSetting.value);
        }
        if (isHexColor(darkCardSetting?.value)) {
          setDarkCardState(darkCardSetting.value);
          window.localStorage.setItem(THEME_DARK_CARD_KEY, darkCardSetting.value);
        }
        if (isThemeFont(fontSetting?.value)) {
          setFontState(fontSetting.value);
          window.localStorage.setItem(THEME_FONT_KEY, fontSetting.value);
        }
        const syncedFontSize = clampThemeNumber(fontSizeSetting?.value, 14, 19, DEFAULT_THEME_CUSTOMIZATION.fontSize);
        const syncedRadius = clampThemeNumber(radiusSetting?.value, 0, 20, DEFAULT_THEME_CUSTOMIZATION.radius);
        if (fontSizeSetting?.value != null) {
          setFontSizeState(syncedFontSize);
          window.localStorage.setItem(THEME_FONT_SIZE_KEY, String(syncedFontSize));
        }
        if (radiusSetting?.value != null) {
          setRadiusState(syncedRadius);
          window.localStorage.setItem(THEME_RADIUS_KEY, String(syncedRadius));
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

  const persist = useCallback((key: string, value: string) => {
    window.localStorage.setItem(key, value);
    api.settings.set(key, value).catch(() => {});
  }, []);

  const setLightBackground = useCallback((next: string) => {
    if (!isHexColor(next)) return;
    setLightBackgroundState(next);
    persist(THEME_LIGHT_BACKGROUND_KEY, next);
  }, [persist]);
  const setDarkBackground = useCallback((next: string) => {
    if (!isHexColor(next)) return;
    setDarkBackgroundState(next);
    persist(THEME_DARK_BACKGROUND_KEY, next);
  }, [persist]);
  const setLightCard = useCallback((next: string) => {
    if (!isHexColor(next)) return;
    setLightCardState(next);
    persist(THEME_LIGHT_CARD_KEY, next);
  }, [persist]);
  const setDarkCard = useCallback((next: string) => {
    if (!isHexColor(next)) return;
    setDarkCardState(next);
    persist(THEME_DARK_CARD_KEY, next);
  }, [persist]);
  const setFont = useCallback((next: ThemeFont) => {
    setFontState(next);
    persist(THEME_FONT_KEY, next);
  }, [persist]);
  const setFontSize = useCallback((next: number) => {
    const value = clampThemeNumber(next, 14, 19, DEFAULT_THEME_CUSTOMIZATION.fontSize);
    setFontSizeState(value);
    persist(THEME_FONT_SIZE_KEY, String(value));
  }, [persist]);
  const setRadius = useCallback((next: number) => {
    const value = clampThemeNumber(next, 0, 20, DEFAULT_THEME_CUSTOMIZATION.radius);
    setRadiusState(value);
    persist(THEME_RADIUS_KEY, String(value));
  }, [persist]);
  const resetCustomization = useCallback(() => {
    setLightBackground(DEFAULT_THEME_CUSTOMIZATION.lightBackground);
    setDarkBackground(DEFAULT_THEME_CUSTOMIZATION.darkBackground);
    setLightCard(DEFAULT_THEME_CUSTOMIZATION.lightCard);
    setDarkCard(DEFAULT_THEME_CUSTOMIZATION.darkCard);
    setFont(DEFAULT_THEME_CUSTOMIZATION.font);
    setFontSize(DEFAULT_THEME_CUSTOMIZATION.fontSize);
    setRadius(DEFAULT_THEME_CUSTOMIZATION.radius);
  }, [setDarkBackground, setDarkCard, setFont, setFontSize, setLightBackground, setLightCard, setRadius]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedMode: resolveMode(mode), accent, lightBackground, darkBackground, lightCard, darkCard, font, fontSize, radius, setMode, setAccent, setLightBackground, setDarkBackground, setLightCard, setDarkCard, setFont, setFontSize, setRadius, resetCustomization }),
    [mode, accent, lightBackground, darkBackground, lightCard, darkCard, font, fontSize, radius, systemPrefersDark, setMode, setAccent, setLightBackground, setDarkBackground, setLightCard, setDarkCard, setFont, setFontSize, setRadius, resetCustomization]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

export { THEME_MODES, ACCENT_COLORS };
