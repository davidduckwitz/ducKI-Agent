import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, Eye, EyeOff, Plus, Save, Search, Star, Trash2, UploadCloud, X } from "lucide-react";
import { api } from "../../lib/api";
import { CodePreview } from "../common/CodePreview";
import { useI18n } from "../../lib/i18n";

interface SkillItem {
  slug: string;
  name: string;
  description?: string;
}

interface SkillDetail {
  slug: string;
  name: string;
  description?: string;
  content: string;
}

interface SettingEntry {
  key: string;
  value: string;
}

interface DraftSkill {
  name: string;
  description: string;
}

type VisibilityFilter = "all" | "enabled" | "disabled";

function parseEnabledSkills(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

const importedSkillTemplates: Array<{ name: string; description: string; content: string }> = [
  {
    name: "plan",
    description: "Planning mode: erstellt einen ausführbaren Markdown-Plan statt direkt Code zu ändern.",
    content: [
      "---",
      "name: plan",
      "description: \"Planning mode: actionable plan only, no direct implementation in this turn.\"",
      "version: 1.0.0",
      "source: \"Inspired by https://github.com/NousResearch/hermes-agent/blob/main/skills/software-development/plan/SKILL.md\"",
      "---",
      "",
      "# Plan Mode",
      "",
      "## Zweck",
      "Nutze diesen Skill, wenn der User einen belastbaren Umsetzungsplan erwartet und nicht sofort Implementierung.",
      "",
      "## Regeln",
      "- Keine produktiven Codeaenderungen in diesem Schritt.",
      "- Falls noetig nur read-only Repo-Inspektion.",
      "- Ergebnis ist ein konkreter, testbarer Schritt-fuer-Schritt-Plan.",
      "",
      "## Plan-Struktur",
      "1. Ziel und Scope.",
      "2. Aktueller Stand und Annahmen.",
      "3. Schrittfolge in kleinen Tasks.",
      "4. Betroffene Dateien und Schnittstellen.",
      "5. Test- und Verifikationsstrategie.",
      "6. Risiken und offene Fragen.",
      "",
      "## Qualitaetskriterien",
      "- Jeder Task ist klein und eindeutig.",
      "- Dateipfade und Kommandos sind konkret.",
      "- Akzeptanzkriterien sind messbar.",
      "",
    ].join("\n"),
  },
  {
    name: "test-driven-development",
    description: "TDD-Loop fuer neue Features und Bugfixes mit expliziten Red-Green-Refactor Schritten.",
    content: [
      "---",
      "name: test-driven-development",
      "description: \"TDD-first implementation: red, green, refactor with explicit verification.\"",
      "version: 1.0.0",
      "source: \"Inspired by common Hermes/OpenClaw software-dev skill patterns\"",
      "---",
      "",
      "# TDD Mode",
      "",
      "## Ablauf",
      "1. Schreibe zuerst einen fehlschlagenden Test.",
      "2. Fuehre den Test aus und bestaetige den Fehler.",
      "3. Implementiere minimalen Code fuer gruen.",
      "4. Fuehre relevante Tests erneut aus.",
      "5. Refactor nur bei gruenen Tests.",
      "",
      "## Anforderungen",
      "- Kein ungetesteter Produktionscode.",
      "- Tests muessen Verhalten abdecken, nicht interne Details.",
      "- Testdaten klar und reproduzierbar.",
      "",
      "## Ausgabeformat",
      "- Geaenderte Dateien",
      "- Testbefehle und Ergebnisse",
      "- Restrisiken oder nicht abgedeckte Faelle",
      "",
    ].join("\n"),
  },
  {
    name: "code-review",
    description: "Review-Fokus auf Bugs, Regressionen, Risiken und fehlende Tests mit priorisierten Findings.",
    content: [
      "---",
      "name: code-review",
      "description: \"Structured review mode: findings-first, ordered by severity, with concrete file references.\"",
      "version: 1.0.0",
      "source: \"Inspired by Hermes review/reporting conventions\"",
      "---",
      "",
      "# Code Review Mode",
      "",
      "## Ziel",
      "Bewerte Aenderungen auf Korrektheit, Risiko und Wartbarkeit. Fokus auf echte Findings statt Zusammenfassung.",
      "",
      "## Priorisierung",
      "- Kritisch: Datenverlust, Security, harte Laufzeitfehler.",
      "- Hoch: funktionale Regressionen, API-Brueche.",
      "- Mittel: robuste Fehlerbehandlung, Edge Cases.",
      "- Niedrig: Stil, Lesbarkeit, kleinere Verbesserungen.",
      "",
      "## Ausgabe",
      "1. Findings (nach Schweregrad, mit Dateireferenz).",
      "2. Offene Fragen / Annahmen.",
      "3. Kurze Aenderungszusammenfassung.",
      "",
      "## Mindestchecks",
      "- Betroffene Tests vorhanden und sinnvoll?",
      "- Backward-Compatibility intakt?",
      "- Konfiguration und Defaults konsistent?",
      "",
    ].join("\n"),
  },
];

export function SkillManager() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [draftSkill, setDraftSkill] = useState<DraftSkill>({ name: "", description: "" });
  const [importForm, setImportForm] = useState<{ url: string; name: string }>({ url: "", name: "" });
  const [search, setSearch] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all");
  const [showManageModal, setShowManageModal] = useState(false);

  const { data: skills = [] } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills.list() as Promise<SkillItem[]>,
  });

  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.list() as Promise<SettingEntry[]>,
  });

  const enabledSkills = useMemo(() => {
    const setting = settings.find((item) => item.key === "ENABLED_SKILLS");
    return parseEnabledSkills(setting?.value);
  }, [settings]);

  const pinnedSkills = useMemo(() => {
    const setting = settings.find((item) => item.key === "PINNED_SKILLS");
    return parseEnabledSkills(setting?.value);
  }, [settings]);

  const enabledSet = useMemo(() => new Set(enabledSkills), [enabledSkills]);
  const pinnedSet = useMemo(() => new Set(pinnedSkills), [pinnedSkills]);

  const selectedDetail = useQuery({
    queryKey: ["skills", selectedSlug],
    queryFn: () => api.skills.get(selectedSlug ?? "") as Promise<SkillDetail>,
    enabled: Boolean(selectedSlug),
  });

  useEffect(() => {
    if (!selectedDetail.data) return;
    setEditorContent(selectedDetail.data.content);
  }, [selectedDetail.data]);

  const saveEnabledSkills = useMutation({
    mutationFn: (nextSkills: string[]) =>
      api.settings.set("ENABLED_SKILLS", JSON.stringify(nextSkills)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const savePinnedSkills = useMutation({
    mutationFn: (nextPinned: string[]) =>
      api.settings.set("PINNED_SKILLS", JSON.stringify(nextPinned)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: { name: string; description: string; content?: string }) =>
      api.skills.create(payload),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["skills"] });
      setSelectedSlug(data.slug);
      setDraftSkill({ name: "", description: "" });
    },
  });

  const updateSkill = useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.skills.update(slug, content),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["skills", vars.slug] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const importSkill = useMutation({
    mutationFn: (payload: { url: string; name?: string }) => api.skills.import(payload),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ["skills"] });
      setSelectedSlug(data.slug);
      setImportForm({ url: "", name: "" });
    },
  });

  const deleteSkill = useMutation({
    mutationFn: (slug: string) => api.skills.delete(slug),
    onSuccess: async (_data, slug) => {
      const nextEnabled = enabledSkills.filter((item) => item !== slug);
      await api.settings.set("ENABLED_SKILLS", JSON.stringify(nextEnabled));
      await qc.invalidateQueries({ queryKey: ["settings"] });
      await qc.invalidateQueries({ queryKey: ["skills"] });
      setSelectedSlug(null);
      setEditorContent("");
    },
  });

  const toggleSkill = (slug: string): void => {
    const next = new Set(enabledSet);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    saveEnabledSkills.mutate(Array.from(next).sort());
  };

  const sortedSkills = useMemo(() => {
    const collator = new Intl.Collator("de", { sensitivity: "base" });
    return [...skills].sort((a, b) => {
      const aPinned = pinnedSet.has(a.slug) ? 0 : 1;
      const bPinned = pinnedSet.has(b.slug) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;

      const aEnabled = enabledSet.has(a.slug) ? 0 : 1;
      const bEnabled = enabledSet.has(b.slug) ? 0 : 1;
      if (aEnabled !== bEnabled) return aEnabled - bEnabled;
      return collator.compare(a.name, b.name);
    });
  }, [skills, enabledSet, pinnedSet]);

  const visibleSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedSkills.filter((skill) => {
      const enabled = enabledSet.has(skill.slug);
      const matchesFilter =
        visibilityFilter === "all" ||
        (visibilityFilter === "enabled" && enabled) ||
        (visibilityFilter === "disabled" && !enabled);
      const matchesSearch =
        q.length === 0 ||
        skill.slug.toLowerCase().includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        (skill.description ?? "").toLowerCase().includes(q);
      return matchesFilter && matchesSearch;
    });
  }, [sortedSkills, enabledSet, visibilityFilter, search]);

  const hasUnsavedChanges = Boolean(selectedDetail.data && selectedDetail.data.content !== editorContent);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  const createDraftSkill = () => {
    const name = draftSkill.name.trim();
    if (!name) return;
    createSkill.mutate({ name, description: draftSkill.description.trim() });
  };

  const importFromUrl = () => {
    const url = importForm.url.trim();
    if (!url) return;
    importSkill.mutate({
      url,
      name: importForm.name.trim() || undefined,
    });
  };

  const togglePinned = (slug: string): void => {
    const next = new Set(pinnedSet);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    savePinnedSkills.mutate(Array.from(next).sort());
  };

  const selectSkill = (slug: string): void => {
    if (hasUnsavedChanges && selectedSlug && selectedSlug !== slug) {
      const proceed = window.confirm(t("skillsPage.confirmDiscard"));
      if (!proceed) return;
    }
    setSelectedSlug(slug);
  };

  const importInspirationSkills = async () => {
    for (const template of importedSkillTemplates) {
      const exists = skills.some((item) => item.slug === template.name);
      if (exists) continue;
      await createSkill.mutateAsync({
        name: template.name,
        description: template.description,
        content: template.content,
      });
    }
    await qc.invalidateQueries({ queryKey: ["skills"] });
  };

  return (
    <div className="p-6 space-y-4 h-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Skills</h1>
          <p className="text-sm text-gray-400">
            {t("skillsPage.titleHint")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={importInspirationSkills}
            className="btn-secondary text-sm"
            disabled={createSkill.isPending}
          >
            {t("skillsPage.loadExamples")}
          </button>
          <button
            onClick={() => setShowManageModal(true)}
            className="btn-primary text-sm"
          >
            {t("skillsPage.manage")}
          </button>
          <div className="text-sm text-gray-300 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
            {t("skillsPage.activeCount")}: <span className="font-semibold text-white">{enabledSet.size}</span> / {skills.length}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs text-gray-400">{t("skillsPage.total")}</p>
          <p className="text-2xl font-semibold">{skills.length}</p>
        </div>
        <div className="card border-amber-500/30 bg-amber-500/5">
          <p className="text-xs text-amber-200">{t("skillsPage.pinned")}</p>
          <p className="text-2xl font-semibold text-amber-100">{pinnedSet.size}</p>
        </div>
        <div className="card border-emerald-500/30 bg-emerald-500/5">
          <p className="text-xs text-emerald-200">{t("skillsPage.activeInContext")}</p>
          <p className="text-2xl font-semibold text-emerald-100">{enabledSet.size}</p>
        </div>
        <div className="card border-gray-700 bg-gray-900/40">
          <p className="text-xs text-gray-400">{t("skillsPage.deactivated")}</p>
          <p className="text-2xl font-semibold text-gray-200">{skills.length - enabledSet.size}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px,minmax(0,1fr)] gap-4 h-[calc(100%-210px)] min-h-[560px]">
        <div className="card overflow-y-auto space-y-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2 sticky top-0 z-10">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                className="input pl-9"
                placeholder={t("skillsPage.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <button
                onClick={() => setVisibilityFilter("all")}
                className={`px-2 py-1 rounded border ${visibilityFilter === "all" ? "border-blue-500 bg-blue-500/20" : "border-gray-700 bg-gray-800"}`}
              >
                {t("skillsPage.all")}
              </button>
              <button
                onClick={() => setVisibilityFilter("enabled")}
                className={`px-2 py-1 rounded border ${visibilityFilter === "enabled" ? "border-emerald-500 bg-emerald-500/20" : "border-gray-700 bg-gray-800"}`}
              >
                {t("common.active")}
              </button>
              <button
                onClick={() => setVisibilityFilter("disabled")}
                className={`px-2 py-1 rounded border ${visibilityFilter === "disabled" ? "border-gray-500 bg-gray-700/40" : "border-gray-700 bg-gray-800"}`}
              >
                {t("skillsPage.off")}
              </button>
            </div>
            <p className="text-xs text-gray-500">{t("skillsPage.hits")}: {visibleSkills.length}</p>
          </div>

          <div className="space-y-2">
            {visibleSkills.map((skill) => {
              const enabled = enabledSet.has(skill.slug);
              const selected = selectedSlug === skill.slug;
              return (
                <div
                  key={skill.slug}
                  className={`rounded-lg border px-3 py-3 ${
                    selected ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-gray-900/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => selectSkill(skill.slug)}
                      className="text-left min-w-0 flex-1"
                    >
                      <p className="text-sm font-semibold text-white truncate">{skill.name}</p>
                      <p className="text-xs text-gray-500 truncate">/{skill.slug}</p>
                      <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                        {skill.description ?? t("skillsPage.noDescription")}
                      </p>
                    </button>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => togglePinned(skill.slug)}
                        disabled={savePinnedSkills.isPending}
                        className={`inline-flex items-center justify-center p-1.5 rounded-md text-xs border transition ${
                          pinnedSet.has(skill.slug)
                            ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                            : "border-gray-700 bg-gray-800 text-gray-400"
                        }`}
                        title={pinnedSet.has(skill.slug) ? "Unpin" : "Pin"}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => toggleSkill(skill.slug)}
                        disabled={saveEnabledSkills.isPending}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition ${
                          enabled
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                            : "border-gray-700 bg-gray-800 text-gray-300"
                        }`}
                      >
                        {enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                        {enabled ? t("skillsPage.on") : t("skillsPage.off")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {visibleSkills.length === 0 && (
              <div className="text-center text-gray-500 py-10">
                <BookOpen className="w-10 h-10 mx-auto mb-3 text-gray-700" />
                <p>{t("skillsPage.noMatches")}</p>
              </div>
            )}
          </div>
        </div>

        <div className="card overflow-y-auto">
          {!selectedSlug && (
            <div className="h-full flex items-center justify-center text-gray-500">
              <div className="text-center">
                <BookOpen className="w-10 h-10 mx-auto mb-3 text-gray-700" />
                <p>{t("skillsPage.selectSkill")}</p>
              </div>
            </div>
          )}

          {selectedSlug && selectedDetail.data && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{selectedDetail.data.name}</h2>
                  <p className="text-xs text-gray-500">/{selectedDetail.data.slug}</p>
                  {hasUnsavedChanges && (
                    <p className="text-xs text-amber-300 mt-1">{t("skillsPage.unsavedChanges")}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {enabledSet.has(selectedDetail.data.slug) && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-emerald-500/50 bg-emerald-500/15 text-emerald-200">
                      <Check className="w-3.5 h-3.5" />
                      {t("common.active")}
                    </span>
                  )}
                  <button
                    onClick={() => updateSkill.mutate({ slug: selectedDetail.data.slug, content: editorContent })}
                    className="btn-primary text-sm flex items-center gap-2"
                    disabled={updateSkill.isPending || !hasUnsavedChanges}
                  >
                    <Save className="w-4 h-4" />
                    {t("common.save")}
                  </button>
                  <button
                    onClick={() => deleteSkill.mutate(selectedDetail.data.slug)}
                    className="btn-secondary text-sm flex items-center gap-2"
                    disabled={deleteSkill.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                    {t("skillsPage.delete")}
                  </button>
                </div>
              </div>

              {selectedDetail.data.description && (
                <p className="text-sm text-gray-300">{selectedDetail.data.description}</p>
              )}

              <textarea
                className="input w-full min-h-[60vh] font-mono text-sm leading-6"
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
              />
              <div className="rounded-lg border border-gray-800 overflow-hidden">
                <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900/60">
                  {t("skillsPage.preview")}
                </div>
                <CodePreview code={editorContent} language="markdown" maxHeight={280} fontSize={13} />
              </div>
            </div>
          )}
        </div>
      </div>

      {showManageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h3 className="text-base font-semibold">{t("skillsPage.manageTitle")}</h3>
              <button
                onClick={() => setShowManageModal(false)}
                className="p-1 rounded hover:bg-gray-800 text-gray-300"
                aria-label="Modal schließen"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
                <p className="text-sm font-semibold">{t("skillsPage.createNew")}</p>
                <input
                  className="input"
                  placeholder="Skill Name / Slug (z. B. api-planning)"
                  value={draftSkill.name}
                  onChange={(e) => setDraftSkill((prev) => ({ ...prev, name: e.target.value }))}
                />
                <input
                  className="input"
                  placeholder="Kurze Beschreibung"
                  value={draftSkill.description}
                  onChange={(e) => setDraftSkill((prev) => ({ ...prev, description: e.target.value }))}
                />
                <button
                  onClick={createDraftSkill}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                  disabled={createSkill.isPending || draftSkill.name.trim().length === 0}
                >
                  <Plus className="w-4 h-4" />
                  {t("skillsPage.create")}
                </button>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
                <p className="text-sm font-semibold">{t("skillsPage.importUrl")}</p>
                <input
                  className="input"
                  placeholder="https://.../SKILL.md"
                  value={importForm.url}
                  onChange={(e) => setImportForm((prev) => ({ ...prev, url: e.target.value }))}
                />
                <input
                  className="input"
                  placeholder="Optionaler Name/Slug-Override"
                  value={importForm.name}
                  onChange={(e) => setImportForm((prev) => ({ ...prev, name: e.target.value }))}
                />
                <button
                  onClick={importFromUrl}
                  className="btn-secondary w-full flex items-center justify-center gap-2"
                  disabled={importSkill.isPending || importForm.url.trim().length === 0}
                >
                  <UploadCloud className="w-4 h-4" />
                  {t("skillsPage.import")}
                </button>
                {importSkill.isError && (
                  <p className="text-xs text-red-300">{t("skillsPage.importFailed")}</p>
                )}
              </div>
            </div>

            <div className="px-4 py-3 border-t border-gray-800 flex justify-end">
              <button
                onClick={() => setShowManageModal(false)}
                className="btn-secondary"
              >
                {t("skillsPage.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
