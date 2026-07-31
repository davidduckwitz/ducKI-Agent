import { X } from "lucide-react";
import { useI18n } from "../../lib/i18n";

/** Editor tab strip. Middle-click closes, like every editor people already know. */
export function CodingEditorTabs({
  openPaths,
  activePath,
  dirtyPaths,
  onSelect,
  onClose,
}: {
  openPaths: string[];
  activePath: string;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useI18n();
  if (openPaths.length === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-border bg-background/40">
      {openPaths.map((path) => {
        const active = path === activePath;
        const dirty = dirtyPaths.has(path);
        const name = path.split("/").pop() || path;
        return (
          <div
            key={path}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(path);
              }
            }}
            className={`group flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-b-2 border-b-primary bg-card font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <button type="button" onClick={() => onSelect(path)} className="min-w-0 truncate" title={path}>
              {name}
            </button>
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title={t("codingPage.unsaved")} />}
            <button
              type="button"
              onClick={() => onClose(path)}
              title={t("codingPage.closeTab")}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
