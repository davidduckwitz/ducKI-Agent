import { useParams } from "react-router-dom";
import { pluginUiUrl } from "../../lib/backendUrl";
import { usePlugins } from "../../lib/usePlugins";

/**
 * Full-page host for a plugin's frontend page. Reached via the sidebar link a plugin earns
 * when it ships provides.frontendPage and is enabled. The page renders in the content area
 * beside the sidebar, exactly like a built-in route, via a same-origin iframe.
 */
export function PluginFrontendView() {
  const { name = "" } = useParams();
  const { data: plugins } = usePlugins();
  const plugin = plugins?.find((p) => p.name === name);

  if (plugin && (!plugin.frontendPage || !plugin.enabled)) {
    return (
      <div className="page">
        <p className="text-sm text-muted-foreground">
          Dieses Plugin hat keine aktive Frontend-Seite.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-lg">{plugin?.icon ?? "🧩"}</span>
        <h1 className="text-sm font-semibold">{plugin?.name ?? name}</h1>
      </div>
      <iframe
        title={`${name} Frontend`}
        src={pluginUiUrl(name, "frontend")}
        sandbox="allow-scripts allow-forms allow-same-origin"
        className="min-h-0 flex-1 w-full border-0 bg-background"
      />
    </div>
  );
}

export default PluginFrontendView;
