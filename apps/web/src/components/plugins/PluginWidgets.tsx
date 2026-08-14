import type { PluginInfo } from "../../lib/api";
import { pluginUiUrl } from "../../lib/backendUrl";
import { usePlugins, widgetPlugins } from "../../lib/usePlugins";

/**
 * Renders the widget tiles of enabled plugins for a given placement. A widget is a small
 * same-origin iframe (provides.widgetPage) shown inline - compact in the sidebar, as cards on
 * the dashboard. Placement comes from the plugin manifest (sidebar | dashboard | both).
 */
export function PluginWidgets({ placement }: { placement: "sidebar" | "dashboard" }) {
  const { data: plugins } = usePlugins();
  const widgets = widgetPlugins(plugins, placement);
  if (widgets.length === 0) return null;

  if (placement === "sidebar") {
    return (
      <div className="space-y-2 px-1 py-2">
        {widgets.map((p) => (
          <WidgetFrame key={p.name} plugin={p} height={104} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {widgets.map((p) => (
        <div key={p.name} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <span>{p.icon ?? "🧩"}</span>
            <span className="truncate">{p.name}</span>
          </div>
          <WidgetFrame plugin={p} height={150} />
        </div>
      ))}
    </div>
  );
}

function WidgetFrame({ plugin, height }: { plugin: PluginInfo; height: number }) {
  return (
    <iframe
      title={`${plugin.name} Widget`}
      src={pluginUiUrl(plugin.name, "widget")}
      className="w-full rounded-md border border-border bg-background/40"
      style={{ height }}
    />
  );
}

export default PluginWidgets;
