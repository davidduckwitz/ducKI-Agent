import { useState, useMemo } from "react";
import { ChevronDown, Sparkles, Activity, Zap, Search, AlertCircle, CheckCircle2, Clock, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

interface SkillManifest {
  slug: string;
  name: string;
  description: string;
  category?: string;
  tags?: string[];
}

interface SkillBundle {
  id: string;
  name: string;
  description: string;
  category: "development" | "infrastructure" | "data" | "communication" | "automation" | "analysis" | "custom";
  skills: SkillManifest[];
  tags: string[];
  priority: "critical" | "high" | "medium" | "low";
  minSkillsRequired: number;
  maxConcurrent: number;
  dependencies: string[];
}

// Mock data for default skill bundles
const DEFAULT_SKILL_BUNDLES: SkillBundle[] = [
  {
    id: "web-development",
    name: "Web Development",
    description: "Skills for web application development and frontend work",
    category: "development",
    skills: [],
    tags: ["frontend", "javascript", "typescript", "react", "html", "css"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "backend-development",
    name: "Backend Development",
    description: "Skills for backend services and API development",
    category: "development",
    skills: [],
    tags: ["backend", "nodejs", "database", "api", "server"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "devops",
    name: "DevOps & Infrastructure",
    description: "Skills for deployment, infrastructure, and monitoring",
    category: "infrastructure",
    skills: [],
    tags: ["docker", "kubernetes", "ci/cd", "deployment", "cloud", "aws", "azure"],
    priority: "high",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Skills for data processing, analysis, and visualization",
    category: "data",
    skills: [],
    tags: ["data", "analysis", "sql", "python", "statistics", "visualization"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "automation",
    name: "Automation & Scripting",
    description: "Skills for task automation and script development",
    category: "automation",
    skills: [],
    tags: ["automation", "scripting", "bash", "shell", "workflow", "robotics"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 3,
    dependencies: [],
  },
  {
    id: "code-review",
    name: "Code Quality & Review",
    description: "Skills for code review, testing, and quality assurance",
    category: "analysis",
    skills: [],
    tags: ["testing", "review", "quality", "linting", "debugging"],
    priority: "medium",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
  {
    id: "documentation",
    name: "Documentation",
    description: "Skills for creating and maintaining documentation",
    category: "communication",
    skills: [],
    tags: ["documentation", "writing", "markdown", "api-docs", "guides"],
    priority: "low",
    minSkillsRequired: 1,
    maxConcurrent: 2,
    dependencies: [],
  },
];

const CATEGORY_COLORS: Record<SkillBundle["category"], string> = {
  development: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300",
  infrastructure: "bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300",
  data: "bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-300",
  communication: "bg-pink-100 dark:bg-pink-950 text-pink-700 dark:text-pink-300",
  automation: "bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300",
  analysis: "bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300",
  custom: "bg-gray-100 dark:bg-gray-950 text-gray-700 dark:text-gray-300",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-blue-600 dark:text-blue-400",
  low: "text-gray-600 dark:text-gray-400",
};

const PRIORITY_ICONS: Record<"critical" | "high" | "medium" | "low", LucideIcon> = {
  critical: Zap,
  high: Activity,
  medium: Clock,
  low: Activity,
};

interface BundleCardProps {
  bundle: SkillBundle;
  isSelected: boolean;
  onToggle: (bundleId: string) => void;
  expandedBundles: Set<string>;
  onToggleExpand: (bundleId: string) => void;
}

function BundleCard({ bundle, isSelected, onToggle, expandedBundles, onToggleExpand }: BundleCardProps) {
  const isExpanded = expandedBundles.has(bundle.id);
  const PriorityIcon = PRIORITY_ICONS[bundle.priority];

  return (
    <div className={cn("card border-2 transition-all", isSelected ? "border-primary bg-primary/5" : "border-border")}>
      <div className="space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(bundle.id)}
                className="w-5 h-5 rounded cursor-pointer accent-primary"
              />
              <h3 className="font-semibold">{bundle.name}</h3>
              <span className={cn(CATEGORY_COLORS[bundle.category], "text-xs px-2 py-0.5 rounded-full")}>
                {bundle.category}
              </span>
              <div className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", PRIORITY_COLORS[bundle.priority])}>
                <PriorityIcon className="w-3 h-3 inline mr-1" />
                {bundle.priority}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{bundle.description}</p>
          </div>
          <button
            onClick={() => onToggleExpand(bundle.id)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={cn("w-4 h-4 transition-transform", isExpanded && "rotate-180")}
            />
          </button>
        </div>

        {/* Bundle Stats */}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>{bundle.skills.length} skills</span>
          </div>
          <div className="flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            <span>Min required: {bundle.minSkillsRequired}</span>
          </div>
          <div className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            <span>Max concurrent: {bundle.maxConcurrent}</span>
          </div>
        </div>

        {/* Tags */}
        {bundle.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {bundle.tags.map((tag) => (
              <span key={tag} className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground">
                #{tag}
              </span>
            ))}
          </div>
        )}

        {/* Dependencies */}
        {bundle.dependencies.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 rounded">
            <AlertCircle className="w-3 h-3" />
            <span>Requires: {bundle.dependencies.join(", ")}</span>
          </div>
        )}

        {/* Expanded Details */}
        {isExpanded && (
          <div className="border-t border-border pt-3 mt-3 space-y-2">
            <div className="text-xs space-y-1">
              <p className="font-semibold text-foreground">Configuration</p>
              <p className="text-muted-foreground">
                <span className="font-mono">minSkillsRequired:</span> {bundle.minSkillsRequired}
              </p>
              <p className="text-muted-foreground">
                <span className="font-mono">maxConcurrent:</span> {bundle.maxConcurrent}
              </p>
              <p className="text-muted-foreground">
                <span className="font-mono">priority:</span> {bundle.priority}
              </p>
            </div>

            {bundle.skills.length > 0 && (
              <div>
                <p className="font-semibold text-xs text-foreground mb-1">Included Skills</p>
                <div className="flex flex-wrap gap-1">
                  {bundle.skills.map((skill) => (
                    <span key={skill.slug} className="text-xs px-2 py-0.5 rounded bg-secondary text-secondary-foreground">
                      {skill.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SkillsManagementSettings() {
  const [bundles] = useState<SkillBundle[]>(DEFAULT_SKILL_BUNDLES);
  const [selectedBundles, setSelectedBundles] = useState<Set<string>>(new Set());
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  const filteredBundles = useMemo(() => {
    return bundles.filter((bundle) => {
      const matchesSearch =
        bundle.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bundle.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bundle.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesCategory = !filterCategory || bundle.category === filterCategory;

      return matchesSearch && matchesCategory;
    });
  }, [bundles, searchQuery, filterCategory]);

  const toggleBundleSelection = (bundleId: string) => {
    const newSelected = new Set(selectedBundles);
    if (newSelected.has(bundleId)) {
      newSelected.delete(bundleId);
    } else {
      newSelected.add(bundleId);
    }
    setSelectedBundles(newSelected);
  };

  const toggleExpandBundle = (bundleId: string) => {
    const newExpanded = new Set(expandedBundles);
    if (newExpanded.has(bundleId)) {
      newExpanded.delete(bundleId);
    } else {
      newExpanded.add(bundleId);
    }
    setExpandedBundles(newExpanded);
  };

  const uniqueCategories = Array.from(new Set(bundles.map((b) => b.category)));

  const stats = {
    totalBundles: bundles.length,
    selectedBundles: selectedBundles.size,
    totalSkills: bundles.reduce((sum, b) => sum + b.skills.length, 0),
    maxConcurrentTotal: Array.from(selectedBundles)
      .map((id) => bundles.find((b) => b.id === id)?.maxConcurrent ?? 0)
      .reduce((sum, max) => sum + max, 0),
  };

  return (
    <div className="card space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          Skills & Bundles
        </h2>
        <p className="text-sm text-muted-foreground">
          Manage skill bundles for intelligent context-aware skill selection. Select bundles to activate for your agent.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-secondary/50 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Total Bundles</p>
          <p className="text-lg font-semibold">{stats.totalBundles}</p>
        </div>
        <div className="bg-primary/10 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Selected</p>
          <p className="text-lg font-semibold text-primary">{stats.selectedBundles}</p>
        </div>
        <div className="bg-secondary/50 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Total Skills</p>
          <p className="text-lg font-semibold">{stats.totalSkills}</p>
        </div>
        <div className="bg-secondary/50 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Max Concurrent</p>
          <p className="text-lg font-semibold">{stats.maxConcurrentTotal}</p>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search bundles by name, description, or tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10 w-full"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilterCategory(null)}
            className={cn("btn-secondary text-xs", !filterCategory && "btn-primary")}
          >
            All Categories
          </button>
          {uniqueCategories.map((category) => (
            <button
              key={category}
              onClick={() => setFilterCategory(category)}
              className={cn(
                "btn-secondary text-xs",
                filterCategory === category && "btn-primary"
              )}
            >
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Bundles Grid */}
      <div className="grid gap-3 md:grid-cols-2">
        {filteredBundles.length > 0 ? (
          filteredBundles.map((bundle) => (
            <BundleCard
              key={bundle.id}
              bundle={bundle}
              isSelected={selectedBundles.has(bundle.id)}
              onToggle={toggleBundleSelection}
              expandedBundles={expandedBundles}
              onToggleExpand={toggleExpandBundle}
            />
          ))
        ) : (
          <div className="col-span-full text-center py-8 text-muted-foreground">
            <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No skill bundles found matching your search</p>
          </div>
        )}
      </div>

      {/* Selection Summary */}
      {selectedBundles.size > 0 && (
        <div className="border-t border-border pt-4 space-y-2">
          <p className="text-sm font-semibold">Selected Bundles ({selectedBundles.size})</p>
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedBundles).map((bundleId) => {
              const bundle = bundles.find((b) => b.id === bundleId);
              return bundle ? (
                <div
                  key={bundleId}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium"
                >
                  <span>{bundle.name}</span>
                  <button
                    onClick={() => toggleBundleSelection(bundleId)}
                    className="hover:opacity-70 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ) : null;
            })}
          </div>
        </div>
      )}

      {/* Footer Note */}
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300">
        <p className="font-semibold mb-1">ℹ️ Intelligent Skill Selection</p>
        <p>
          The agent automatically selects skills from your selected bundles based on user input, task type, complexity level, and time constraints. Each bundle respects its maxConcurrent limit to optimize context usage.
        </p>
      </div>
    </div>
  );
}
