import type { ComponentType } from "react";
import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun, Wifi, WifiOff } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_MODES, type ThemeMode } from "../../lib/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { DuckyMascot } from "../chat/DuckyMascot";

const THEME_MODE_ICONS: Record<ThemeMode, ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

function ThemeModeSwitcher() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const ActiveIcon = THEME_MODE_ICONS[mode];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("themeSettings.modeTitle")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
        >
          <ActiveIcon className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_MODES.map((value) => {
          const Icon = THEME_MODE_ICONS[value];
          return (
            <DropdownMenuItem key={value} onClick={() => setMode(value)} className="gap-2">
              <Icon className="h-4 w-4" />
              {t(`themeSettings.mode.${value}`)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Brand + status + language + theme in two compact rows. The old header used five
 * rows (incl. a bordered language box) and pushed the actual navigation below the fold.
 */
export function SidebarHeader({
  connected,
  agentStatus,
  busy,
  collapsed,
  onToggleCollapsed,
}: {
  connected: boolean;
  agentStatus: string;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t, language, setLanguage, languages } = useI18n();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 border-b border-border p-2">
        <DuckyMascot
          working={busy}
          connected={connected}
          size={26}
          title={busy ? t("layout.duckyWorkingTitle") : t("layout.duckyIdleTitle")}
        />
        <button type="button" onClick={onToggleCollapsed} title={t("layout.sidebar.expand")} className="rail-item">
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <DuckyMascot
            working={busy}
            connected={connected}
            size={26}
            title={busy ? t("layout.duckyWorkingTitle") : t("layout.duckyIdleTitle")}
          />
          <span className="truncate text-base font-bold">DucKI</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeModeSwitcher />
          <button
            type="button"
            onClick={onToggleCollapsed}
            title={t("layout.sidebar.collapse")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span
          className="flex min-w-0 items-center gap-1 text-[11px]"
          title={`${connected ? t("layout.connected") : t("layout.disconnected")} - ${agentStatus}`}
        >
          {connected ? (
            <Wifi className="h-3 w-3 shrink-0 text-green-500" />
          ) : (
            <WifiOff className="h-3 w-3 shrink-0 text-red-500" />
          )}
          <span className={connected ? "text-green-500" : "text-red-500"}>
            {connected ? t("layout.connected") : t("layout.disconnected")}
          </span>
          <span className="truncate capitalize text-muted-foreground">· {agentStatus}</span>
        </span>

        <div className="flex shrink-0 items-center gap-0.5" title={t("layout.sidebar.language")}>
          {languages.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => setLanguage(entry.code)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                language === entry.code
                  ? "bg-primary/20 text-primary ring-1 ring-primary/50"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={entry.label}
            >
              <img src={entry.flagSrc} alt={entry.label} className="h-2.5 w-3.5 rounded-[2px]" />
              {entry.code.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
