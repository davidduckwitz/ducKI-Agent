import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Flexible content box: header stays put, body scrolls. Use instead of `.card`
 * whenever the box lives inside a height-constrained flex/grid cell.
 */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("panel", className)}>{children}</section>;
}

export function PanelHeader({
  title,
  icon,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("panel-head", className)}>
      {children ?? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            <h2 className="panel-title">{title}</h2>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </>
      )}
    </div>
  );
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("panel-body", className)}>{children}</div>;
}

/** Centered placeholder for "nothing selected" / "nothing here yet" states. */
export function PanelEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-6 text-center">
      {icon ? <div className="text-muted-foreground/50">{icon}</div> : null}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground/70">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
