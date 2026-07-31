import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Star, ExternalLink, Search, Filter } from "lucide-react";
import { cn } from "../../lib/utils";

interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  status?: string;
  lines?: number;
  updated?: string;
}

interface SkillDiscoveryProps {
  installedSkills: string[];
}

const LANDING_PAGE_API = "https://ducki-ai-agent.davidduckwitz.de/api/v1.php";

export function SkillDiscovery({ installedSkills }: SkillDiscoveryProps) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  const { data: discoveredSkills = [], isLoading: skillsLoading } = useQuery({
    queryKey: ["discover-skills"],
    queryFn: async () => {
      const res = await fetch(`${LANDING_PAGE_API}?action=skills`);
      if (!res.ok) throw new Error("Failed to load skills");
      const data = await res.json();
      return data.data?.skills || [];
    },
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["discover-categories"],
    queryFn: async () => {
      const res = await fetch(`${LANDING_PAGE_API}?action=categories`);
      if (!res.ok) throw new Error("Failed to load categories");
      const data = await res.json();
      return data.data?.skill_categories || [];
    },
  });

  const installSkillMutation = useMutation({
    mutationFn: async (skill: DiscoveredSkill) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skill.id,
          description: skill.description,
          slug: skill.id,
        }),
      });
      if (!res.ok) throw new Error("Failed to install skill");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  // Filter skills
  const filtered = discoveredSkills.filter((skill: DiscoveredSkill) => {
    const matchesSearch =
      search === "" ||
      skill.name.toLowerCase().includes(search.toLowerCase()) ||
      skill.description.toLowerCase().includes(search.toLowerCase());

    const matchesCategory =
      selectedCategory === "" || skill.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const isInstalled = (skillId: string) =>
    installedSkills.includes(skillId.replace(/-/g, "_"));

  return (
    <div className="space-y-4 h-full">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Download className="w-5 h-5 text-blue-500" />
          Discover & Install Skills
        </h2>
        <p className="text-sm text-gray-400">
          Browse available skills from the public landing page and install them with one click
        </p>
      </div>

      {/* Search & Filter */}
      <div className="card p-4 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 w-full"
          />
        </div>

        {categories.length > 0 && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-gray-400">Filter by Category</label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedCategory("")}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium transition",
                  selectedCategory === ""
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                )}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs font-medium transition",
                    selectedCategory === cat
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="text-xs text-gray-500">
          Showing {filtered.length} of {discoveredSkills.length} skills
        </div>
      </div>

      {/* Skills Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 overflow-y-auto flex-1">
        {skillsLoading ? (
          <div className="col-span-full text-center py-12 text-gray-400">
            Loading available skills...
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-gray-400">
            No skills found matching your search
          </div>
        ) : (
          filtered.map((skill: DiscoveredSkill) => {
            const installed = isInstalled(skill.id);
            return (
              <div
                key={skill.id}
                className="card p-4 hover:shadow-lg transition-shadow"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm truncate">{skill.name}</h3>
                    <span className="inline-block mt-1 px-2 py-0.5 text-xs rounded bg-gray-700 text-gray-200">
                      {skill.category || "Utility"}
                    </span>
                  </div>
                  {skill.status === "beta" && (
                    <span className="ml-2 px-2 py-0.5 text-xs rounded bg-yellow-900/30 text-yellow-300">
                      Beta
                    </span>
                  )}
                </div>

                {/* Description */}
                <p className="text-xs text-gray-400 mb-3 line-clamp-2">
                  {skill.description}
                </p>

                {/* Meta */}
                <div className="text-xs text-gray-500 space-y-1 mb-3">
                  {skill.lines && <p>📝 {skill.lines} lines</p>}
                  {skill.updated && (
                    <p>
                      🔄 Updated {new Date(skill.updated).toLocaleDateString()}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {!installed ? (
                    <button
                      onClick={() => installSkillMutation.mutate(skill)}
                      disabled={installSkillMutation.isPending}
                      className="flex-1 px-3 py-2 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition flex items-center justify-center gap-1"
                    >
                      <Download className="w-3 h-3" />
                      Install
                    </button>
                  ) : (
                    <div className="flex-1 px-3 py-2 rounded text-xs font-medium bg-green-900/30 text-green-300 flex items-center justify-center gap-1">
                      ✓ Installed
                    </div>
                  )}

                  <button
                    onClick={() =>
                      window.open(
                        `${LANDING_PAGE_API.replace(
                          "/api/v1.php",
                          ""
                        )}/detail.html?type=skill&id=${skill.id}`,
                        "_blank"
                      )
                    }
                    className="px-3 py-2 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
                    title="View on landing page"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Info Footer */}
      <div className="card p-3 text-xs text-gray-400">
        <p>
          💡 <strong>Tip:</strong> Skills are installed directly from the public inventory. Once
          installed, manage them in the "My Skills" tab.
        </p>
      </div>
    </div>
  );
}
