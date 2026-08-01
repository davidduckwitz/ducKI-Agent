import { useEffect, useState } from "react";
import { ChevronDown, AlertCircle, Loader2 } from "lucide-react";
import { api } from "../../lib/api";

interface Provider {
  id: string;
  name: string;
}

interface Model {
  id: string;
  name: string;
}

export function ProviderModelSelector({
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
}: {
  selectedProvider?: string;
  selectedModel?: string;
  onProviderChange: (provider: string | undefined) => void;
  onModelChange: (model: string | undefined) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const loadProviders = async () => {
      try {
        setError(undefined);
        const list = await api.providerModels.listProviders();
        setProviders(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load providers");
      }
    };
    loadProviders();
  }, []);

  useEffect(() => {
    if (!selectedProvider) {
      setModels([]);
      return;
    }

    const loadModels = async () => {
      try {
        setLoading(true);
        setError(undefined);
        const response = await api.providerModels.getModels(selectedProvider);
        if (response.success && response.models) {
          setModels(response.models);
        } else {
          setError(response.error || "Failed to load models");
          setModels([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load models");
        setModels([]);
      } finally {
        setLoading(false);
      }
    };

    loadModels();
  }, [selectedProvider]);

  return (
    <div className="flex gap-2 px-4 py-2 bg-accent/30 rounded-lg border border-border/50 text-sm">
      {/* Provider Selector */}
      <div className="flex-1 flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Provider</label>
        <div className="relative">
          <select
            value={selectedProvider || ""}
            onChange={(e) => {
              const value = e.target.value || undefined;
              onProviderChange(value);
              onModelChange(undefined);
            }}
            className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm appearance-none cursor-pointer pr-8 hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Default</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        </div>
      </div>

      {/* Model Selector */}
      <div className="flex-1 flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Model</label>
        <div className="relative">
          <select
            value={selectedModel || ""}
            onChange={(e) => onModelChange(e.target.value || undefined)}
            disabled={!selectedProvider || loading}
            className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm appearance-none cursor-pointer pr-8 hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {loading && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin pointer-events-none" />}
          {!loading && <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}
    </div>
  );
}
