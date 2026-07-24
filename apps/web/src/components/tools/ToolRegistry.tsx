import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Sparkles, Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface ToolItem {
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  subagent: boolean;
}

interface SettingEntry {
  key: string;
  value: string;
}

const ENABLED_OPTIONAL_TOOLS_KEY = "ENABLED_OPTIONAL_TOOLS";

function parseEnabledTools(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase());
  } catch {
    return [];
  }
}

export function ToolRegistry() {
  const { t } = useI18n();
  const qc = useQueryClient();

  const { data: tools = [] } = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.tools.list() as Promise<ToolItem[]>,
  });

  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.list() as Promise<SettingEntry[]>,
  });

  const enabledOptionalTools = useMemo(() => {
    const setting = settings.find((item) => item.key === ENABLED_OPTIONAL_TOOLS_KEY);
    return parseEnabledTools(setting?.value);
  }, [settings]);

  const enabledSet = useMemo(() => new Set(enabledOptionalTools), [enabledOptionalTools]);

  const saveEnabledOptionalTools = useMutation({
    mutationFn: (nextEnabled: string[]) => api.settings.set(ENABLED_OPTIONAL_TOOLS_KEY, JSON.stringify(nextEnabled)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const toggleTool = (name: string): void => {
    const next = new Set(enabledSet);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    saveEnabledOptionalTools.mutate(Array.from(next).sort());
  };

  const coreTools = tools.filter((tool) => tool.core);
  const optionalTools = tools.filter((tool) => !tool.core);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("nav.tools")}</h1>
        <p className="text-sm text-gray-400 mt-1">{t("toolsPage.titleHint")}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500">{t("toolsPage.core")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {coreTools.map((tool) => (
            <div key={tool.name} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 bg-purple-400/10 rounded-lg">
                    <Wrench className="w-5 h-5 text-purple-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium font-mono text-sm">{tool.name}</p>
                    <p className="text-sm text-gray-400 mt-1">{tool.description}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-gray-700 bg-gray-800 text-gray-400 shrink-0">
                  <Lock className="w-3.5 h-3.5" />
                  {t("toolsPage.alwaysOn")}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500">{t("toolsPage.optional")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {optionalTools.map((tool) => {
            const enabled = tool.enabled;
            return (
              <div key={tool.name} className="card">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 bg-purple-400/10 rounded-lg">
                      <Wrench className="w-5 h-5 text-purple-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium font-mono text-sm">{tool.name}</p>
                      <p className="text-sm text-gray-400 mt-1">{tool.description}</p>
                      {tool.subagent && (
                        <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md text-xs border border-amber-500/40 bg-amber-500/10 text-amber-300">
                          <Sparkles className="w-3 h-3" />
                          {t("toolsPage.usesSubagent")}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleTool(tool.name)}
                    disabled={saveEnabledOptionalTools.isPending}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition shrink-0 ${
                      enabled
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                        : "border-gray-700 bg-gray-800 text-gray-300"
                    }`}
                  >
                    {enabled ? t("toolsPage.on") : t("toolsPage.off")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {tools.length === 0 && (
        <div className="col-span-2 text-center text-gray-500 py-12">
          <Wrench className="w-10 h-10 mx-auto mb-3 text-gray-700" />
          <p>{t("toolsPage.noTools")}</p>
        </div>
      )}
    </div>
  );
}
