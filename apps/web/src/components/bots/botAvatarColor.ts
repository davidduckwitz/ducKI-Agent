/** Deterministic accent color per bot slug, so the same bot always renders with the same color
 *  across a group chat's whole history without persisting a color anywhere. Picked from a small
 *  hand-tuned palette (not raw HSL-from-hash) so every result stays legible in light and dark. */
const PALETTE = [
  { bg: "bg-violet-500/15", text: "text-violet-500", ring: "ring-violet-500/30" },
  { bg: "bg-sky-500/15", text: "text-sky-500", ring: "ring-sky-500/30" },
  { bg: "bg-emerald-500/15", text: "text-emerald-500", ring: "ring-emerald-500/30" },
  { bg: "bg-amber-500/15", text: "text-amber-500", ring: "ring-amber-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-500", ring: "ring-rose-500/30" },
  { bg: "bg-cyan-500/15", text: "text-cyan-500", ring: "ring-cyan-500/30" },
  { bg: "bg-fuchsia-500/15", text: "text-fuchsia-500", ring: "ring-fuchsia-500/30" },
  { bg: "bg-lime-500/15", text: "text-lime-600", ring: "ring-lime-500/30" },
];

export function botAccentColor(slug: string): (typeof PALETTE)[number] {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
