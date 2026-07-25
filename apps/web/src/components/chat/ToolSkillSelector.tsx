import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

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
  query: string;
  conversationId?: number;
  onInsertSkill: (slug: string) => void;
  onToolExecuted: (result: { toolName: string; success: boolean; data: unknown; error?: string }) => void;
  onClose: () => void;
}

/**
 * "/" chat selector: lets the user pick a skill (inserted as the "/slug " prefix the
 * agent already parses via extractRequestedSkillSlugs) or a tool (run immediately via
 * POST /tools/execute -> Agent.executeToolDirect, bypassing the LLM). Tools/skills are
 * the same lists shown in Settings, just filtered live against the typed query.
 */
export function ToolSkillSelector({ query, conversationId, onInsertSkill, onToolExecuted, onClose }: ToolSkillSelectorProps) {
  const toolsQuery = useQuery({ queryKey: ["selector", "tools"], queryFn: api.tools.list, staleTime: 60_000 });
  const skillsQuery = useQuery({ queryKey: ["selector", "skills"], queryFn: api.skills.list, staleTime: 60_000 });
  const [activeTool, setActiveTool] = useState<ToolItem | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | undefined>();

  const items: SelectorItem[] = useMemo(() => {
    const tools: ToolItem[] = (toolsQuery.data ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => ({ kind: "tool", name: tool.name, description: tool.description, parameters: tool.parameters }));
    const skills: SkillItem[] = (skillsQuery.data ?? []).map((skill) => ({
      kind: "skill",
      name: skill.slug,
      description: skill.description ?? skill.name,
    }));
    return [...tools, ...skills];
  }, [toolsQuery.data, skillsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter((item) => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
      : items;
    return matches.slice(0, 30);
  }, [items, query]);

  const [useFreetextMode, setUseFreetextMode] = useState(false);
  const [freetextInput, setFreetextInput] = useState("");

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
          setRunError("Bitte geben Sie eine Anweisung ein");
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

  if (activeTool) {
    const schema = propertiesOf(activeTool.parameters);
    const required = requiredOf(activeTool.parameters);
    const fields = Object.entries(schema);

    return (
      <div className="absolute bottom-full left-0 mb-2 w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 shadow-xl z-20 p-3 space-y-2 max-h-96 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-100">/{activeTool.name}</div>
          <button type="button" className="text-xs text-gray-400 hover:text-white" onClick={() => setActiveTool(null)}>
            ← Zurück
          </button>
        </div>
        <div className="text-xs text-gray-400">{activeTool.description}</div>

        {fields.length > 0 && (
          <div className="flex gap-2 border-b border-gray-700 pb-2">
            <button
              type="button"
              className={`text-xs px-2 py-1 rounded ${!useFreetextMode ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
              onClick={() => setUseFreetextMode(false)}
            >
              Formular
            </button>
            <button
              type="button"
              className={`text-xs px-2 py-1 rounded ${useFreetextMode ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
              onClick={() => setUseFreetextMode(true)}
            >
              Anweisung
            </button>
          </div>
        )}

        {useFreetextMode ? (
          <>
            <div className="space-y-1">
              <label className="text-xs text-gray-300 block">Anweisung (Freitext)</label>
              <textarea
                className="input w-full text-xs resize-none"
                rows={4}
                value={freetextInput}
                onChange={(e) => setFreetextInput(e.target.value)}
                placeholder={`z.B. "Erstelle ein Projekt namens 'Blog' mit Beschreibung 'WordPress Clone'"`}
              />
            </div>
          </>
        ) : (
          <>
            {fields.length === 0 && <div className="text-xs text-gray-500">Keine Parameter erforderlich.</div>}

            {fields.map(([key, def]) => (
              <div key={key} className="space-y-1">
                <label className="text-xs text-gray-300 block">
                  {key}
                  {required.includes(key) ? " *" : ""}
                  {def.description ? <span className="text-gray-500"> — {def.description}</span> : null}
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

        {runError && <div className="text-xs text-red-400">{runError}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn-primary text-xs" onClick={handleRunTool} disabled={running}>
            {running ? "Läuft…" : "Jetzt ausführen"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 mb-2 w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 shadow-xl z-20 max-h-80 overflow-y-auto">
      {filtered.length === 0 && <div className="px-3 py-2 text-xs text-gray-500">Keine Treffer</div>}
      {filtered.map((item) => (
        <button
          key={`${item.kind}-${item.name}`}
          type="button"
          className="w-full text-left px-3 py-2 hover:bg-gray-800 border-b border-gray-800 last:border-0"
          onClick={() => handleSelect(item)}
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                item.kind === "tool" ? "bg-amber-500/20 text-amber-300" : "bg-indigo-500/20 text-indigo-300"
              }`}
            >
              {item.kind === "tool" ? "Tool" : "Skill"}
            </span>
            <span className="text-sm font-medium text-gray-100">/{item.name}</span>
          </div>
          <div className="text-xs text-gray-400 truncate">{item.description}</div>
        </button>
      ))}
    </div>
  );
}
