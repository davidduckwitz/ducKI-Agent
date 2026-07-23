export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "blue" | "violet" | "green" | "orange" | "rose" | "zinc";

export const THEME_MODE_KEY = "ducki.theme.mode";
export const THEME_ACCENT_KEY = "ducki.theme.accent";

export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
export const ACCENT_COLORS: AccentColor[] = ["blue", "violet", "green", "orange", "rose", "zinc"];

export const DEFAULT_THEME_MODE: ThemeMode = "dark";
export const DEFAULT_ACCENT_COLOR: AccentColor = "blue";

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as string[]).includes(value);
}

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === "string" && (ACCENT_COLORS as string[]).includes(value);
}

export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(mode: ThemeMode, accent: AccentColor) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveMode(mode) === "dark");
  root.setAttribute("data-accent", accent);
}
