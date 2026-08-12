import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Vertical drag handle between two columns. Pointer capture keeps the drag alive
 * even when the cursor leaves the 6px strip - without it, resizing feels broken.
 *
 * `direction: "left"` means dragging left grows the panel to the RIGHT of the handle
 * (the usual case for a right-hand side panel).
 */
export function SplitHandle({
  value,
  onChange,
  direction = "left",
  className,
  ariaLabel,
  resetValue = 380,
  step = 16,
}: {
  value: number;
  onChange: (next: number) => void;
  direction?: "left" | "right";
  className?: string;
  ariaLabel?: string;
  /** Width restored on double click. */
  resetValue?: number;
  /** Pixels per arrow-key press, for keyboard resizing. */
  step?: number;
}) {
  const startRef = useRef({ x: 0, value: 0 });

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      startRef.current = { x: event.clientX, value };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [value]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const delta = event.clientX - startRef.current.x;
      onChange(startRef.current.value + (direction === "left" ? -delta : delta));
    },
    [direction, onChange]
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Same sign convention as the drag: for "left", moving left grows the panel.
      const grow = direction === "left" ? -1 : 1;
      if (event.key === "ArrowLeft") onChange(value - grow * step);
      else if (event.key === "ArrowRight") onChange(value + grow * step);
      else if (event.key === "Home" || event.key === "End") onChange(resetValue);
      else return;
      event.preventDefault();
    },
    [direction, onChange, resetValue, step, value]
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      className={cn("split-handle group", className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onChange(resetValue)}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-transparent" />
    </div>
  );
}
