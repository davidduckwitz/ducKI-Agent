/**
 * Tool whitelist picker for the bot builder, backed by api.tools.list() (GET /tools).
 *
 * Access semantics are explicit:
 * - []      = no tools (safe default for newly-created bots)
 * - ["*"]   = unrestricted / every tool
 * - [names] = only the selected tools
 *
 * Older bots stored `null` for unrestricted access; BotBuilderDialog maps that legacy value to
 * ["*"] so simply editing/saving an existing bot does not silently change its permissions.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { Badge } from "../ui/badge";

const UNRESTRICTED = "*";

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

  const unrestricted = value.includes(UNRESTRICTED);
  const concreteValue = unrestricted ? [] : value;
  const selected = new Set(concreteValue);

  function toggle(name: string) {
    // Selecting one concrete tool while in unrestricted mode intentionally narrows access to
    // that tool. This avoids carrying the wildcard alongside a misleading concrete selection.
    if (unrestricted) {
      onChange([name]);
      return;
    }
    if (selected.has(name)) {
      onChange(concreteValue.filter((n) => n !== name));
    } else {
      onChange([...concreteValue, name]);
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
          {unrestricted
            ? t("bots.builder.tools.unrestricted")
            : t("bots.builder.tools.selectedCount").replace("{count}", String(concreteValue.length))}
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

      <div className="flex flex-wrap gap-3">
        {!unrestricted ? (
          <button
            type="button"
            onClick={() => onChange([UNRESTRICTED])}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("bots.builder.tools.unrestricted")}
          </button>
        ) : null}
        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("bots.builder.tools.clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
