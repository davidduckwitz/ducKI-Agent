import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CornerDownLeft, Loader2, Play, Search, Sparkles, Wrench, X } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface ToolItem {
  kind: "tool";
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface SkillItem {
  kind: "skill";
  name: string;
  description: string;
}

type SelectorItem = ToolItem | SkillItem;
export type SelectorMode = "all" | "skills" | "tools";

interface PropertySchema {
  type?: string;
  enum?: string[];
  description?: string;
}

function propertiesOf(parameters?: Record<string, unknown>): Record<string, PropertySchema> {
  const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties && typeof properties === "object" ? (properties as Record<string, PropertySchema>) : {};
}

function requiredOf(parameters?: Record<string, unknown>): string[] {
  const required = (parameters as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) ? required.map(String) : [];
}

interface ToolSkillSelectorProps {
  /** Seeds the search box - e.g. whatever was typed after "/" in the composer. */
  query?: string;
  mode?: SelectorMode;
  conversationId?: number;
  onInsertSkill: (slug: string) => void;
  onToolExecuted: (result: { toolName: string; success: boolean; data: unknown; error?: string }) => void;
  onClose: () => void;
}

/**
 * Command palette for skills and tools. A skill is inserted as the "/slug " prefix the
 * agent already parses (extractRequestedSkillSlugs); a tool runs immediately via
 * POST /tools/execute -> Agent.executeToolDirect, bypassing the LLM.
 *
 * The palette owns its own search field and keyboard focus. Syncing a second input with
 * the composer's textarea was the alternative and it desynchronises the moment the user
 * edits either side.
 */
export function ToolSkillSelector({
  query = "",
  mode = "all",
  conversationId,
  onInsertSkill,
  onToolExecuted,
  onClose,
}: ToolSkillSelectorProps) {
  const { t } = useI18n();
  const toolsQuery = useQuery({ queryKey: ["selector", "tools"], queryFn: api.tools.list, staleTime: 60_000 });
  const skillsQuery = useQuery({ queryKey: ["selector", "skills"], queryFn: api.skills.list, staleTime: 60_000 });

  const [search, setSearch] = useState(query);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeTool, setActiveTool] = useState<ToolItem | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | undefined>();
  const [useFreetextMode, setUseFreetextMode] = useState(false);
  const [freetextInput, setFreetextInput] = useState("");

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const items: SelectorItem[] = useMemo(() => {
    const tools: ToolItem[] =
      mode === "skills"
        ? []
        : (toolsQuery.data ?? [])
            .filter((tool) => tool.enabled)
            .map((tool) => ({
              kind: "tool",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }));
    const skills: SkillItem[] =
      mode === "tools"
        ? []
        : (skillsQuery.data ?? []).map((skill) => ({
            kind: "skill",
            name: skill.slug,
            description: skill.description ?? skill.name,
          }));
    return [...skills, ...tools];
  }, [toolsQuery.data, skillsQuery.data, mode]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q
      ? items.filter((item) => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
      : items;
    return matches.slice(0, 40);
  }, [items, search]);

  useEffect(() => {
    setActiveIndex(0);
  }, [search, mode]);

  // Keep the highlighted row inside the scroll box while arrowing through the list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSelect = (item: SelectorItem) => {
    if (item.kind === "skill") {
      onInsertSkill(item.name);
      return;
    }
    setActiveTool(item);
    setFormValues({});
    setFreetextInput("");
    setUseFreetextMode(false);
    setRunError(undefined);
  };

  const handleRunTool = async () => {
    if (!activeTool) return;
    setRunning(true);
    setRunError(undefined);
    try {
      let input: Record<string, unknown> = {};

      if (useFreetextMode) {
        if (!freetextInput.trim()) {
          setRunError(t("chat.palette.instructionRequired"));
          setRunning(false);
          return;
        }
        input = { _instruction: freetextInput.trim() };
      } else {
        const schema = propertiesOf(activeTool.parameters);
        for (const [key, def] of Object.entries(schema)) {
          const raw = formValues[key];
          if (raw === undefined || raw.trim() === "") continue;
          if (def.type === "number") {
            input[key] = Number(raw);
          } else if (def.type === "boolean") {
            input[key] = raw === "true";
          } else if (def.type === "array" || def.type === "object") {
            try {
              input[key] = JSON.parse(raw);
            } catch {
              input[key] = raw;
            }
          } else {
            input[key] = raw;
          }
        }
      }

      const result = await api.tools.execute(activeTool.name, input, conversationId);
      onToolExecuted({ toolName: activeTool.name, success: result.success, data: result.data, error: result.error });
      onClose();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const shell =
    "absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl";

  if (activeTool) {
    const schema = propertiesOf(activeTool.parameters);
    const required = requiredOf(activeTool.parameters);
    const fields = Object.entries(schema);

    return (
      <div className={shell}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setActiveTool(null)}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title={t("chat.palette.back")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Wrench className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{activeTool.name}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[22rem] space-y-3 overflow-y-auto p-3">
          <p className="text-xs text-muted-foreground">{activeTool.description}</p>

          {fields.length > 0 && (
            <div className="flex gap-1 rounded-lg border border-border p-0.5">
              {[
                { key: false, label: t("chat.palette.form") },
                { key: true, label: t("chat.palette.instruction") },
              ].map(({ key, label }) => (
                <button
                  key={String(key)}
                  type="button"
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                    useFreetextMode === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setUseFreetextMode(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {useFreetextMode ? (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">
                {t("chat.palette.instructionLabel")}
              </label>
              <textarea
                autoFocus
                className="input w-full resize-none text-xs"
                rows={4}
                value={freetextInput}
                onChange={(e) => setFreetextInput(e.target.value)}
                placeholder={t("chat.palette.instructionPlaceholder")}
              />
            </div>
          ) : (
            <>
              {fields.length === 0 && <p className="text-xs text-muted-foreground">{t("chat.palette.noParams")}</p>}
              {fields.map(([key, def]) => (
                <div key={key} className="space-y-1">
                  <label className="block text-xs font-medium">
                    {key}
                    {required.includes(key) ? <span className="text-destructive"> *</span> : null}
                    {def.description ? (
                      <span className="font-normal text-muted-foreground"> — {def.description}</span>
                    ) : null}
                  </label>
                  {def.enum ? (
                    <select
                      className="input w-full text-xs"
                      value={formValues[key] ?? ""}
                      onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {def.enum.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input w-full text-xs"
                      value={formValues[key] ?? ""}
                      onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={def.type ?? "string"}
                    />
                  )}
                </div>
              ))}
            </>
          )}

          {runError && <p className="text-xs text-destructive">{runError}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() => void handleRunTool()}
            disabled={running}
          >
            {running ? (
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1 inline h-3.5 w-3.5" />
            )}
            {running ? t("chat.palette.running") : t("chat.palette.runNow")}
          </button>
        </div>
      </div>
    );
  }

  const skillCount = filtered.filter((i) => i.kind === "skill").length;
  let renderedSkillHeader = false;
  let renderedToolHeader = false;

  return (
    <div className={shell}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((prev) => Math.max(prev - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = filtered[activeIndex];
              if (item) handleSelect(item);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={t("chat.palette.search")}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={listRef} className="max-h-[20rem] overflow-y-auto py-1">
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {toolsQuery.isLoading || skillsQuery.isLoading ? t("app.loadingPage") : t("chat.palette.noResults")}
          </p>
        )}

        {filtered.map((item, index) => {
          const active = index === activeIndex;
          let header: string | null = null;
          if (item.kind === "skill" && !renderedSkillHeader) {
            renderedSkillHeader = true;
            header = t("chat.palette.skills");
          } else if (item.kind === "tool" && !renderedToolHeader) {
            renderedToolHeader = true;
            header = t("chat.palette.tools");
          }

          return (
            <div key={`${item.kind}-${item.name}`}>
              {header && (
                <div className={`px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 ${index === 0 ? "pt-1" : "pt-2"}`}>
                  {header}
                  {header === t("chat.palette.skills") && skillCount > 0 ? ` · ${skillCount}` : ""}
                </div>
              )}
              <button
                type="button"
                data-index={index}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => handleSelect(item)}
                className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                  active ? "bg-accent" : ""
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                    item.kind === "tool" ? "bg-amber-500/15 text-amber-500" : "bg-primary/15 text-primary"
                  }`}
                >
                  {item.kind === "tool" ? <Wrench className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.kind === "skill" ? `/${item.name}` : item.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
                {active && <CornerDownLeft className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1">↑</kbd>
          <kbd className="rounded border border-border px-1">↓</kbd>
          {t("chat.palette.hintNavigate")}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1">↵</kbd>
          {t("chat.palette.hintSelect")}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1">esc</kbd>
          {t("chat.palette.hintClose")}
        </span>
      </div>
    </div>
  );
}
