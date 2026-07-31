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
}: {
  value: number;
  onChange: (next: number) => void;
  direction?: "left" | "right";
  className?: string;
  ariaLabel?: string;
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

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      className={cn("split-handle group", className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={() => onChange(380)}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-transparent" />
    </div>
  );
}
