import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Sidebar section with a clickable header. Controlled from the outside so the open
 * state can live in `useUiStore` and survive reloads.
 */
export function CollapsibleSection({
  title,
  open,
  onToggle,
  count,
  icon,
  actions,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  count?: number;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    // shrink-0 by default: inside the sidebar's flex scroll container a shrinkable
    // section gets squeezed to nothing and its rows overflow on top of the next one.
    // Sections that really should take the leftover space pass their own flex-1.
    <div className={cn("flex shrink-0 flex-col", className)}>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", !open && "-rotate-90")} />
          {icon}
          <span className="truncate">{title}</span>
          {typeof count === "number" && count > 0 && (
            <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        {actions}
      </div>
      {open && <div className={cn("min-h-0", bodyClassName)}>{children}</div>}
    </div>
  );
}

/** Thin rule with a centered label - the "Mehr" separator in the sidebar. */
export function DividerToggle({
  label,
  open,
  onToggle,
  className,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className={cn("divider-label", className)}>
      <span className="inline-flex items-center gap-1">
        {label}
        <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
      </span>
    </button>
  );
}
