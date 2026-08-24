/**
 * Tool whitelist picker for the bot builder, mirroring SkillMultiSelect but backed by
 * api.tools.list() (GET /tools). Empty selection = unrestricted, same semantics as
 * BotService's toolWhitelist.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { Badge } from "../ui/badge";

export function ToolMultiSelect({ value, onChange }: { value: string[]; onChange: (names: string[]) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const toolsQuery = useQuery({ queryKey: ["tools"], queryFn: () => api.tools.list() });
  const tools = toolsQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q));
  }, [tools, query]);

  const selected = new Set(value);
  const unrestricted = value.length === 0;

  function toggle(name: string) {
    if (selected.has(name)) {
      onChange(value.filter((n) => n !== name));
    } else {
      onChange([...value, name]);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("bots.builder.tools.search")}
            className="w-full rounded-lg border border-input bg-background py-1.5 pl-8 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Badge variant={unrestricted ? "secondary" : "default"}>
          {unrestricted ? t("bots.builder.tools.unrestricted") : t("bots.builder.tools.selectedCount").replace("{count}", String(value.length))}
        </Badge>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto overflow-x-hidden rounded-lg border border-border p-1.5">
        {toolsQuery.isLoading ? <p className="p-2 text-xs text-muted-foreground">{t("bots.builder.tools.loading")}</p> : null}
        {!toolsQuery.isLoading && filtered.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">{t("bots.builder.tools.empty")}</p>
        ) : null}
        {filtered.map((tool) => (
          <label key={tool.name} className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-accent">
            <input
              type="checkbox"
              checked={selected.has(tool.name)}
              onChange={() => toggle(tool.name)}
              className="mt-0.5 shrink-0 accent-primary"
            />
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate font-medium">{tool.name}</span>
              {tool.description ? <span className="block truncate text-xs text-muted-foreground">{tool.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {value.length > 0 ? (
        <button type="button" onClick={() => onChange([])} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          {t("bots.builder.tools.clear")}
        </button>
      ) : null}
    </div>
  );
}
