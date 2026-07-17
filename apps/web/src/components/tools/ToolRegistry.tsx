import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

export function ToolRegistry() {
  const { t } = useI18n();
  const { data: tools = [] } = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.tools.list(),
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Tools</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {tools.map((tool) => (
          <div key={tool.name} className="card">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-purple-400/10 rounded-lg">
                <Wrench className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <p className="font-medium font-mono text-sm">{tool.name}</p>
                <p className="text-sm text-gray-400 mt-1">{tool.description}</p>
              </div>
            </div>
          </div>
        ))}
        {tools.length === 0 && (
          <div className="col-span-2 text-center text-gray-500 py-12">
            <Wrench className="w-10 h-10 mx-auto mb-3 text-gray-700" />
            <p>{t("toolsPage.noTools")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
