import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  Brain,
  Check,
  Clock3,
  Database,
  Gauge,
  LayoutGrid,
  Plus,
  Save,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface MemoryEntry {
  id: number;
  content: string;
  type: string;
  importance: number;
  createdAt: string;
}

interface PendingMemoryWrite {
  id: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

const PAGE_SIZE = 10;
type ActiveTab = "memory" | "profile" | "approvals";

function memoryTypeColor(type: string): string {
  if (type === "long-term") return "bg-blue-500/20 text-blue-300";
  if (type === "semantic") return "bg-emerald-500/20 text-emerald-300";
  if (type === "episodic") return "bg-amber-500/20 text-amber-300";
  if (type === "short-term") return "bg-violet-500/20 text-violet-300";
  return "bg-gray-700 text-gray-200";
}

function MemoryTypeIcon({ type }: { type: string }) {
  if (type === "semantic") return <UserRound className="w-4 h-4 text-emerald-300" />;
  if (type === "episodic") return <Clock3 className="w-4 h-4 text-amber-300" />;
  if (type === "short-term") return <Gauge className="w-4 h-4 text-violet-300" />;
  return <Brain className="w-4 h-4 text-blue-300" />;
}

export function MemoryBrowser() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [agentBehavior, setAgentBehavior] = useState("");
  const [humanInfo, setHumanInfo] = useState("");
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("memory");

  const { data: memories = [] } = useQuery({
    queryKey: ["memory"],
    queryFn: () => api.memory.list() as Promise<MemoryEntry[]>,
    refetchInterval: 5000,
  });

  const pendingQuery = useQuery({
    queryKey: ["memory", "pending"],
    queryFn: () => api.memory.action({ action: "pending_list" }) as Promise<PendingMemoryWrite[]>,
    refetchInterval: 4000,
  });

  const profileQuery = useQuery({
    queryKey: ["memory", "profile"],
    queryFn: () => api.memory.getProfile(),
  });

  useEffect(() => {
    if (!profileQuery.data) return;
    setAgentBehavior(profileQuery.data.agentBehavior ?? "");
    setHumanInfo(profileQuery.data.humanInfo ?? "");
  }, [profileQuery.data]);

  const saveProfile = useMutation({
    mutationFn: (payload: { agentBehavior: string; humanInfo: string }) => api.memory.saveProfile(payload),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["memory"] });
      await qc.invalidateQueries({ queryKey: ["memory", "profile"] });
      setShowProfileModal(false);
    },
  });

  const approveWrite = useMutation({
    mutationFn: (pendingId: string) => api.memory.action({ action: "approve", pendingId, approved: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["memory"] });
      await qc.invalidateQueries({ queryKey: ["memory", "pending"] });
    },
  });

  const rejectWrite = useMutation({
    mutationFn: (pendingId: string) => api.memory.action({ action: "approve", pendingId, approved: false }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["memory", "pending"] });
    },
  });

  const sortedMemories = useMemo(
    () => [...(memories as MemoryEntry[])].sort((a, b) => b.id - a.id),
    [memories]
  );

  const filteredMemories = useMemo(() => {
    return sortedMemories.filter((entry) => {
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (search.trim().length > 0) {
        const needle = search.trim().toLowerCase();
        if (!entry.content.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [sortedMemories, typeFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filteredMemories.length / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedMemories = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredMemories.slice(start, start + PAGE_SIZE);
  }, [filteredMemories, page]);

  const memoryTypeStats = useMemo(() => {
    const stats = new Map<string, number>();
    for (const entry of sortedMemories) {
      stats.set(entry.type, (stats.get(entry.type) ?? 0) + 1);
    }
    return Array.from(stats.entries()).map(([type, count]) => ({ type, count }));
  }, [sortedMemories]);

  const timelineBuckets = useMemo(() => {
    const now = Date.now();
    const buckets = [
      { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
      { key: "3d", label: "3d", ms: 3 * 24 * 60 * 60 * 1000 },
      { key: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
      { key: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
    ];

    return buckets.map((bucket) => ({
      ...bucket,
      count: sortedMemories.filter((entry) => now - new Date(entry.createdAt).getTime() <= bucket.ms).length,
    }));
  }, [sortedMemories]);

  const avgImportance = useMemo(() => {
    if (sortedMemories.length === 0) return 0;
    const total = sortedMemories.reduce((sum, entry) => sum + entry.importance, 0);
    return total / sortedMemories.length;
  }, [sortedMemories]);

  const pendingWrites = (pendingQuery.data ?? []) as PendingMemoryWrite[];

  const paginationButtons = useMemo(() => {
    const pages = new Set<number>([1, totalPages, page - 1, page, page + 1]);
    return Array.from(pages)
      .filter((p) => p >= 1 && p <= totalPages)
      .sort((a, b) => a - b);
  }, [page, totalPages]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Memory</h1>
          <p className="text-sm text-gray-400">{t("memoryPage.subtitle")}</p>
        </div>
        <button
          onClick={() => setShowProfileModal(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          {t("memoryPage.profileEntry")}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className={`btn-secondary flex items-center gap-2 ${activeTab === "memory" ? "ring-2 ring-blue-500" : ""}`}
          onClick={() => setActiveTab("memory")}
        >
          <LayoutGrid className="w-4 h-4" />
          Memory
        </button>
        <button
          className={`btn-secondary flex items-center gap-2 ${activeTab === "profile" ? "ring-2 ring-emerald-500" : ""}`}
          onClick={() => setActiveTab("profile")}
        >
          <UserRound className="w-4 h-4" />
          {t("memoryPage.profile")}
        </button>
        <button
          className={`btn-secondary flex items-center gap-2 ${activeTab === "approvals" ? "ring-2 ring-amber-500" : ""}`}
          onClick={() => setActiveTab("approvals")}
        >
          <ShieldCheck className="w-4 h-4" />
          {t("memoryPage.approvals")}
        </button>
      </div>

      {activeTab === "memory" && (
        <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="card flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">{t("memoryPage.totalEntries")}</p>
            <p className="text-2xl font-semibold">{sortedMemories.length}</p>
          </div>
          <Database className="w-6 h-6 text-blue-300" />
        </div>
        <div className="card flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">{t("memoryPage.avgImportance")}</p>
            <p className="text-2xl font-semibold">{avgImportance.toFixed(1)}</p>
          </div>
          <Gauge className="w-6 h-6 text-emerald-300" />
        </div>
        <div className="card flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">{t("memoryPage.memoryTypes")}</p>
            <p className="text-2xl font-semibold">{memoryTypeStats.length}</p>
          </div>
          <BarChart3 className="w-6 h-6 text-amber-300" />
        </div>
        <div className="card flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">{t("memoryPage.pendingApprovals")}</p>
            <p className="text-2xl font-semibold">{pendingWrites.length}</p>
          </div>
          <Clock3 className="w-6 h-6 text-violet-300" />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <BarChart3 className="w-4 h-4" />
            Verteilung nach Memory-Typ
          </div>
          {memoryTypeStats.length === 0 && <p className="text-sm text-gray-500">{t("memoryPage.noData")}</p>}
          {memoryTypeStats.length > 0 && (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={memoryTypeStats} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                  <XAxis dataKey="type" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: "rgba(148,163,184,0.12)" }}
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e5e7eb" }}
                    labelStyle={{ color: "#e5e7eb" }}
                  />
                  <Bar dataKey="count" fill="#60a5fa" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <Clock3 className="w-4 h-4" />
            {t("memoryPage.activityOverTime")}
          </div>
          {timelineBuckets.length > 0 && (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timelineBuckets} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: "rgba(148,163,184,0.12)" }}
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e5e7eb" }}
                    labelStyle={{ color: "#e5e7eb" }}
                  />
                  <Bar dataKey="count" fill="#34d399" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[220px]"
            placeholder={t("memoryPage.searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <select
            className="input"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">{t("memoryPage.allTypes")}</option>
            <option value="long-term">long-term</option>
            <option value="semantic">semantic</option>
            <option value="episodic">episodic</option>
            <option value="short-term">short-term</option>
          </select>
        </div>

        <div className="space-y-2">
        {pagedMemories.map((mem) => (
          <div key={mem.id} className="card">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <MemoryTypeIcon type={mem.type} />
                <p className="text-sm text-gray-200 break-words">{mem.content}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full ${memoryTypeColor(mem.type)}`}>
                  {mem.type}
                </span>
                <span className="text-xs text-gray-500">
                  {t("memoryPage.importance")}: {mem.importance}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {new Date(mem.createdAt).toLocaleString("de-DE")}
            </p>
          </div>
        ))}
        {filteredMemories.length === 0 && (
          <div className="text-center text-gray-500 py-12">
            <Brain className="w-10 h-10 mx-auto mb-3 text-gray-700" />
            <p>{t("memoryPage.noEntries")}</p>
          </div>
        )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-gray-500">
            {t("memoryPage.pageOf")} {page} {t("memoryPage.of")} {totalPages} • {filteredMemories.length} {t("memoryPage.hits")}
          </p>
          <div className="flex gap-2 items-center">
            <button className="btn-secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              {t("memoryPage.back")}
            </button>
            <div className="flex gap-1">
              {paginationButtons.map((p) => (
                <button
                  key={p}
                  className={`px-2 py-1 rounded text-xs border ${
                    p === page
                      ? "border-blue-500 bg-blue-600/20 text-blue-200"
                      : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"
                  }`}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <button
              className="btn-secondary"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              {t("memoryPage.next")}
            </button>
          </div>
        </div>
      </div>
      </>
      )}

      {activeTab === "approvals" && (
      <div className="card space-y-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <AlertTriangle className="w-4 h-4" />
          Pending Memory Approvals
        </div>
        {pendingWrites.length === 0 && <p className="text-sm text-gray-500">{t("memoryPage.noPending")}</p>}
        {pendingWrites.map((entry) => {
          const payloadText = JSON.stringify(entry.payload, null, 2);
          return (
            <div key={entry.id} className="rounded-lg border border-gray-800 bg-gray-900/70 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-gray-300">{entry.id}</p>
                  <p className="text-xs text-gray-500">{new Date(entry.createdAt).toLocaleString("de-DE")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn-secondary flex items-center gap-1"
                    onClick={() => rejectWrite.mutate(entry.id)}
                    disabled={rejectWrite.isPending || approveWrite.isPending}
                  >
                    <X className="w-3.5 h-3.5" />
                    {t("memoryPage.reject")}
                  </button>
                  <button
                    className="btn-primary flex items-center gap-1"
                    onClick={() => approveWrite.mutate(entry.id)}
                    disabled={rejectWrite.isPending || approveWrite.isPending}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t("memoryPage.approve")}
                  </button>
                </div>
              </div>
              <pre className="text-xs text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto">{payloadText}</pre>
            </div>
          );
        })}
      </div>
      )}

      {activeTab === "profile" && (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <Brain className="w-4 h-4 text-blue-300" />
            Agentenverhalten
          </div>
          <p className="text-sm text-gray-200 whitespace-pre-wrap min-h-[120px]">
            {agentBehavior.trim().length > 0 ? agentBehavior : t("memoryPage.noEntryYet")}
          </p>
        </div>
        <div className="card space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <UserRound className="w-4 h-4 text-emerald-300" />
            Infos zum Mensch
          </div>
          <p className="text-sm text-gray-200 whitespace-pre-wrap min-h-[120px]">
            {humanInfo.trim().length > 0 ? humanInfo : t("memoryPage.noEntryYet")}
          </p>
        </div>
      </div>
      )}

      {showProfileModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold">{t("memoryPage.storeProfile")}</h2>
              <button className="text-gray-400 hover:text-white" onClick={() => setShowProfileModal(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-blue-300" />
                  {t("memoryPage.behaviorEntry")}
                </label>
                <textarea
                  className="input w-full min-h-[140px]"
                  placeholder="z. B. Immer erst Plan erstellen, dann mit kleinen Schritten umsetzen..."
                  value={agentBehavior}
                  onChange={(e) => setAgentBehavior(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-gray-300 flex items-center gap-2">
                  <UserRound className="w-4 h-4 text-emerald-300" />
                  {t("memoryPage.humanEntry")}
                </label>
                <textarea
                  className="input w-full min-h-[140px]"
                  placeholder="z. B. bevorzugte Sprache, Arbeitsweise, wichtige Präferenzen..."
                  value={humanInfo}
                  onChange={(e) => setHumanInfo(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button className="btn-secondary" onClick={() => setShowProfileModal(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  className="btn-primary flex items-center gap-2"
                  onClick={() => saveProfile.mutate({ agentBehavior, humanInfo })}
                  disabled={saveProfile.isPending}
                >
                  <Save className="w-4 h-4" />
                  {saveProfile.isPending ? t("memoryPage.saveInProgress") : t("common.save")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
