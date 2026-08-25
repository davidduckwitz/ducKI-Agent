import { api, type PluginInfo, type PluginWidgetPlacement, type PluginWidgetSpec } from "./api";
import { useServerQuery } from "./useServerQuery";

/**
 * Shared query for the installed plugin list. Backs the plugin page, the dynamic sidebar
 * frontend links and the dashboard/sidebar widgets, so enabling a plugin surfaces its
 * frontend/widget everywhere from one cached source.
 */
export function usePlugins() {
  return useServerQuery<PluginInfo[]>({
    queryKey: ["plugins"],
    queryFn: () => api.plugins.list(),
    staleTime: 30_000,
    // The plugin list changes only on enable/disable/install and is invalidated explicitly
    // there - it must NOT poll. Without this it inherits the app's activity volatility and
    // refetches every ~1.5s, hammering loadPlugins() (file reads, plugin DB opens, secret
    // decryption) and making the UI unresponsive.
    refetchInterval: false,
  });
}

/** Enabled, error-free plugins that ship a frontend page (for sidebar links). */
export function frontendPlugins(plugins: PluginInfo[] | undefined): PluginInfo[] {
  return (plugins ?? []).filter((p) => p.enabled && !p.error && p.frontendPage);
}

/** Enabled, error-free plugins whose widget should render at `placement`. */
export interface ResolvedPluginWidget {
  plugin: PluginInfo;
  widget: PluginWidgetSpec;
}

export function pluginWidgets(plugins: PluginInfo[] | undefined, placement: PluginWidgetPlacement): ResolvedPluginWidget[] {
  return (plugins ?? []).flatMap((plugin) => {
    if (!plugin.enabled || plugin.error) return [];
    return (plugin.widgets ?? []).filter((widget) => widget.placement === placement).map((widget) => ({ plugin, widget }));
  });
}

/** Enabled, error-free plugins that ship a full-window overlay page (mounted globally by the host). */
export function overlayPlugins(plugins: PluginInfo[] | undefined): PluginInfo[] {
  return (plugins ?? []).filter((p) => p.enabled && !p.error && p.overlayPage);
}
