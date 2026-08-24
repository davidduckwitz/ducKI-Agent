/**
 * Skill whitelist picker for the bot builder, backed by api.skills.list().
 *
 * Access semantics are explicit:
 * - []      = no skills (safe default for newly-created bots)
 * - ["*"]   = unrestricted / every skill
 * - [slugs] = only the selected skills
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

export function SkillMultiSelect({ value, onChange }: { value: string[]; onChange: (slugs: string[]) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills.list() });
  const skills = skillsQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q)
    );
  }, [skills, query]);

  const unrestricted = value.includes(UNRESTRICTED);
  const concreteValue = unrestricted ? [] : value;
  const selected = new Set(concreteValue);

  function toggle(slug: string) {
    if (unrestricted) {
      onChange([slug]);
      return;
    }
    if (selected.has(slug)) {
      onChange(concreteValue.filter((s) => s !== slug));
    } else {
      onChange([...concreteValue, slug]);
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
            placeholder={t("bots.builder.skills.search")}
            className="w-full rounded-lg border border-input bg-background py-1.5 pl-8 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Badge variant={unrestricted ? "secondary" : "default"}>
          {unrestricted
            ? t("bots.builder.skills.unrestricted")
            : t("bots.builder.skills.selectedCount").replace("{count}", String(concreteValue.length))}
        </Badge>
      </div>

      <div className="max-h-56 space-y-1 overflow-y-auto overflow-x-hidden rounded-lg border border-border p-1.5">
        {skillsQuery.isLoading ? <p className="p-2 text-xs text-muted-foreground">{t("bots.builder.skills.loading")}</p> : null}
        {!skillsQuery.isLoading && filtered.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">{t("bots.builder.skills.empty")}</p>
        ) : null}
        {filtered.map((skill) => (
          <label
            key={skill.slug}
            className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={selected.has(skill.slug)}
              onChange={() => toggle(skill.slug)}
              className="mt-0.5 shrink-0 accent-primary"
            />
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate font-medium">{skill.name}</span>
              {skill.description ? <span className="block truncate text-xs text-muted-foreground">{skill.description}</span> : null}
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
            {t("bots.builder.skills.unrestricted")}
          </button>
        ) : null}
        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("bots.builder.skills.clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
