/**
 * Viewport queries as React state. The layout needs the breakpoint in JS - not just in
 * CSS - because the sidebar is a resizable column on desktop and an off-canvas drawer
 * on mobile, and those are structurally different, not just styled differently.
 */
import { useEffect, useState } from "react";

/** Matches Tailwind's `md` - below it the sidebar becomes a drawer. */
export const MOBILE_BREAKPOINT = 768;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** True on phone-sized viewports (and narrow desktop windows, which want the same layout). */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

/** Matches Tailwind's `lg` - tablets in portrait (iPad) still get the drawer, not the squeezed desktop rail. */
export const COMPACT_BREAKPOINT = 1024;

/** True below `lg`: phones and portrait tablets, where the sidebar is an off-canvas drawer. */
export function useIsCompact(): boolean {
  return useMediaQuery(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`);
}

/** True when the primary input is touch - used to drop hover-only affordances. */
export function useIsTouch(): boolean {
  return useMediaQuery("(hover: none) and (pointer: coarse)");
}
