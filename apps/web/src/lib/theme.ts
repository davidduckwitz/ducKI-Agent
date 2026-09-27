export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "blue" | "violet" | "green" | "orange" | "rose" | "zinc";
export type ThemeFont = "system" | "modern" | "humanist" | "serif" | "mono";

export interface ThemeCustomization {
  lightBackground: string;
  darkBackground: string;
  lightCard: string;
  darkCard: string;
  font: ThemeFont;
  fontSize: number;
  radius: number;
}

export const THEME_MODE_KEY = "ducki.theme.mode";
export const THEME_ACCENT_KEY = "ducki.theme.accent";
export const THEME_LIGHT_BACKGROUND_KEY = "ducki.theme.background.light";
export const THEME_DARK_BACKGROUND_KEY = "ducki.theme.background.dark";
export const THEME_LIGHT_CARD_KEY = "ducki.theme.card.light";
export const THEME_DARK_CARD_KEY = "ducki.theme.card.dark";
export const THEME_FONT_KEY = "ducki.theme.font";
export const THEME_FONT_SIZE_KEY = "ducki.theme.fontSize";
export const THEME_RADIUS_KEY = "ducki.theme.radius";

export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
export const ACCENT_COLORS: AccentColor[] = ["blue", "violet", "green", "orange", "rose", "zinc"];

/** Tailwind background class previewing each accent (Settings theme tab, setup wizard). */
export const ACCENT_SWATCH_CLASS: Record<AccentColor, string> = {
  blue: "bg-[hsl(217,91%,60%)]",
  violet: "bg-[hsl(258,90%,66%)]",
  green: "bg-[hsl(142,71%,40%)]",
  orange: "bg-[hsl(24,95%,53%)]",
  rose: "bg-[hsl(346,77%,50%)]",
  zinc: "bg-[hsl(240,5%,34%)]",
};
export const THEME_FONTS: ThemeFont[] = ["system", "modern", "humanist", "serif", "mono"];

export const DEFAULT_THEME_MODE: ThemeMode = "dark";
export const DEFAULT_ACCENT_COLOR: AccentColor = "blue";
export const DEFAULT_THEME_CUSTOMIZATION: ThemeCustomization = {
  lightBackground: "#ffffff",
  darkBackground: "#050812",
  lightCard: "#ffffff",
  darkCard: "#0e1421",
  font: "system",
  fontSize: 16,
  radius: 12,
};

export const THEME_FONT_STACKS: Record<ThemeFont, string> = {
  system: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  modern: "Inter, ui-sans-serif, system-ui, sans-serif",
  humanist: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', serif",
  mono: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as string[]).includes(value);
}

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === "string" && (ACCENT_COLORS as string[]).includes(value);
}

export function isThemeFont(value: unknown): value is ThemeFont {
  return typeof value === "string" && (THEME_FONTS as string[]).includes(value);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function clampThemeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function hexToHslTriplet(hex: string): string {
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  if (hue < 0) hue += 360;
  return `${Math.round(hue * 10) / 10} ${Math.round(saturation * 1000) / 10}% ${Math.round(lightness * 1000) / 10}%`;
}

export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(mode: ThemeMode, accent: AccentColor, customization = DEFAULT_THEME_CUSTOMIZATION) {
  const root = document.documentElement;
  const resolvedMode = resolveMode(mode);
  root.classList.toggle("dark", resolvedMode === "dark");
  root.setAttribute("data-accent", accent);
  root.style.colorScheme = resolvedMode;
  root.style.setProperty(
    "--background",
    hexToHslTriplet(resolvedMode === "dark" ? customization.darkBackground : customization.lightBackground)
  );
  const cardColor = hexToHslTriplet(resolvedMode === "dark" ? customization.darkCard : customization.lightCard);
  root.style.setProperty("--card", cardColor);
  root.style.setProperty("--popover", cardColor);
  root.style.setProperty("--font-interface", THEME_FONT_STACKS[customization.font]);
  root.style.setProperty("--radius", `${customization.radius}px`);
  root.style.fontSize = `${customization.fontSize}px`;
}
