import { useMemo } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface SkillManifest {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  dependencies?: string[];
}

interface SkillDependencyGraphProps {
  selectedSkills: SkillManifest[];
  allSkills: Map<string, SkillManifest>;
  dependencyGraph: Map<string, string[]>;
}

export function SkillDependencyGraph({
  selectedSkills,
  allSkills,
  dependencyGraph,
}: SkillDependencyGraphProps) {
  const { resolved, issues, circular } = useMemo(() => {
    const resolved = new Map<string, SkillManifest>();
    const issues: string[] = [];
    const visited = new Set<string>();
    const circular: string[] = [];

    const traverse = (slug: string, path: string[] = []): void => {
      if (path.includes(slug)) {
        // Circular dependency detected
        const cycle = path.slice(path.indexOf(slug)).concat(slug);
        circular.push(cycle.join(" → "));
        return;
      }

      if (visited.has(slug)) return;
      visited.add(slug);

      const skill = allSkills.get(slug);
      if (!skill) {
        issues.push(`Missing skill: ${slug}`);
        return;
      }

      resolved.set(slug, skill);

      // Recursively traverse dependencies
      const deps = dependencyGraph.get(slug) || [];
      for (const dep of deps) {
        traverse(dep, [...path, slug]);
      }
    };

    // Start traversal from selected skills
    for (const skill of selectedSkills) {
      traverse(skill.slug);
    }

    return { resolved, issues, circular };
  }, [selectedSkills, allSkills, dependencyGraph]);

  if (selectedSkills.length === 0) {
    return (
      <div className="card p-8 text-center text-muted-foreground">
        <p>Select skills to visualize their dependencies</p>
      </div>
    );
  }

  const skillsByDepth = useMemo(() => {
    const depths = new Map<string, number>();

    const computeDepth = (slug: string): number => {
      if (depths.has(slug)) return depths.get(slug)!;

      const deps = dependencyGraph.get(slug) || [];
      if (deps.length === 0) {
        depths.set(slug, 0);
        return 0;
      }

      const maxDepth = Math.max(...deps.map((d) => computeDepth(d)));
      const depth = maxDepth + 1;
      depths.set(slug, depth);
      return depth;
    };

    for (const skill of resolved.values()) {
      computeDepth(skill.slug);
    }

    // Group by depth
    const byDepth = new Map<number, SkillManifest[]>();
    for (const [slug, depth] of depths) {
      const skill = resolved.get(slug);
      if (skill) {
        if (!byDepth.has(depth)) byDepth.set(depth, []);
        byDepth.get(depth)!.push(skill);
      }
    }

    return byDepth;
  }, [resolved, dependencyGraph]);

  return (
    <div className="space-y-4">
      {/* Circular Dependency Warnings */}
      {circular.length > 0 && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="w-4 h-4" />
            <span className="font-semibold text-sm">Circular Dependencies Detected</span>
          </div>
          <ul className="space-y-1 ml-6">
            {circular.map((cycle, idx) => (
              <li key={idx} className="text-xs text-destructive/80">
                {cycle}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Issues */}
      {issues.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-600">
            <AlertCircle className="w-4 h-4" />
            <span className="font-semibold text-sm">Missing Dependencies</span>
          </div>
          <ul className="space-y-1 ml-6">
            {issues.map((issue, idx) => (
              <li key={idx} className="text-xs text-amber-700 dark:text-amber-600">
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dependency Layers */}
      <div className="space-y-4">
        {Array.from(skillsByDepth.entries())
          .sort(([a], [b]) => a - b)
          .map(([depth, skills]) => (
            <div key={depth} className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {depth === 0
                  ? "Direct Skills (Selected)"
                  : `Depth ${depth} Dependencies`}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {skills.map((skill) => {
                  const isSelected = selectedSkills.some((s) => s.slug === skill.slug);
                  const deps = dependencyGraph.get(skill.slug) || [];

                  return (
                    <div
                      key={skill.slug}
                      className={`rounded-lg p-3 text-sm border transition-colors ${
                        isSelected
                          ? "bg-primary/10 border-primary/50"
                          : "bg-secondary/50 border-secondary/50"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {isSelected && (
                          <CheckCircle2 className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate">{skill.name}</p>
                          {skill.category && (
                            <p className="text-xs text-muted-foreground capitalize">
                              {skill.category}
                            </p>
                          )}
                          {deps.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Depends on: {deps.join(", ")}
                            </p>
                          )}
                          {skill.tags && skill.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {skill.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-block px-2 py-0.5 rounded text-xs bg-background/50"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>

      {/* Summary */}
      <div className="bg-secondary/50 rounded-lg p-4 space-y-2 text-sm">
        <p className="font-semibold">Resolution Summary</p>
        <ul className="text-xs text-muted-foreground space-y-1 ml-4">
          <li>• Selected Skills: {selectedSkills.length}</li>
          <li>• Resolved Skills: {resolved.size}</li>
          <li>
            • Auto-added Dependencies:{" "}
            {resolved.size - selectedSkills.length}
          </li>
          {circular.length > 0 && (
            <li className="text-destructive">
              • Circular Dependencies: {circular.length}
            </li>
          )}
          {issues.length > 0 && (
            <li className="text-amber-700 dark:text-amber-600">
              • Missing Skills: {issues.length}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
