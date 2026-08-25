import type { CSSProperties } from "react";
import type { PluginWidgetPlacement, PluginWidgetSpec } from "../../lib/api";
import { pluginUiUrl } from "../../lib/backendUrl";
import { pluginWidgets, usePlugins, type ResolvedPluginWidget } from "../../lib/usePlugins";
import { useTheme } from "../theme/ThemeProvider";

/**
 * Renders all enabled plugin widgets for a layout slot. Every iframe has its own manifest
 * configuration, so one plugin may contribute independently sized and styled surfaces.
 */
const WIDTHS: Record<Exclude<PluginWidgetSpec["width"], number>, string> = {
  auto: "auto", sm: "12rem", md: "20rem", lg: "32rem", full: "100%",
};

function widthOf(width: PluginWidgetSpec["width"]): string {
  return typeof width === "number" ? `${width}px` : WIDTHS[width];
}

export function PluginWidgets({ placement, className = "" }: { placement: PluginWidgetPlacement; className?: string }) {
  const { data: plugins } = usePlugins();
  const { resolvedMode, accent } = useTheme();
  const entries = pluginWidgets(plugins, placement);
  if (entries.length === 0) return null;

  if (placement.startsWith("sidebar-")) {
    return (
      <div className={`min-w-0 space-y-2 px-1 py-1 ${className}`}>
        {entries.map((entry) => <WidgetFrame key={`${entry.plugin.name}:${entry.widget.id}`} entry={entry} theme={resolvedMode} accent={accent} />)}
      </div>
    );
  }

  if (placement === "dashboard") {
    return <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 ${className}`}>{entries.map((entry) => <WidgetFrame key={`${entry.plugin.name}:${entry.widget.id}`} entry={entry} theme={resolvedMode} accent={accent} />)}</div>;
  }

  const full = entries.filter(({ widget }) => widget.align === "full");
  const aligned = (["left", "center", "right"] as const).map((align) => ({ align, entries: entries.filter(({ widget }) => widget.align === align) }));
  return <div className={`w-full min-w-0 shrink-0 px-2 ${className}`}>
    {full.map((entry) => <WidgetFrame key={`${entry.plugin.name}:${entry.widget.id}`} entry={entry} theme={resolvedMode} accent={accent} />)}
    {aligned.some((column) => column.entries.length > 0) && <div className="grid min-w-0 grid-cols-3 items-center gap-2">
      {aligned.map((column) => <div key={column.align} className={`flex min-w-0 gap-2 ${column.align === "left" ? "justify-start" : column.align === "center" ? "justify-center" : "justify-end"}`}>
        {column.entries.map((entry) => <WidgetFrame key={`${entry.plugin.name}:${entry.widget.id}`} entry={entry} theme={resolvedMode} accent={accent} />)}
      </div>)}
    </div>}
  </div>;
}

function WidgetFrame({ entry, theme, accent }: { entry: ResolvedPluginWidget; theme: "light" | "dark"; accent: string }) {
  const { plugin, widget } = entry;
  const borderless = widget.frame === "borderless";
  const backgroundClass = widget.background === "transparent" ? "bg-transparent" : widget.background === "inherit" ? "bg-inherit" : "bg-card";
  const style: CSSProperties = {
    height: widget.height,
    width: widthOf(widget.width),
    maxWidth: "100%",
    border: borderless ? 0 : undefined,
    background: widget.background === "transparent" ? "transparent" : widget.background === "inherit" ? "inherit" : undefined,
    colorScheme: widget.background === "transparent" ? "normal" : theme,
  };
  return (
    <div className={`${borderless ? "min-w-0 overflow-hidden" : "min-w-0 overflow-hidden rounded-lg border border-border p-2"} ${backgroundClass}`} style={{ width: widthOf(widget.width), maxWidth: "100%" }}>
      {widget.title && !borderless && <div className="mb-1 truncate text-xs font-medium">{widget.title}</div>}
      <iframe title={`${plugin.name}: ${widget.title ?? widget.id}`} src={`${pluginUiUrl(plugin.name, "widget", widget.id)}?theme=${theme}&accent=${encodeURIComponent(accent)}`} sandbox="allow-scripts allow-forms allow-same-origin" className="block max-w-full" style={style} />
    </div>
  );
}

export default PluginWidgets;
