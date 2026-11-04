import type { VoiceBackdropLabels } from "../../../hooks/useVoiceSettings";
import type { VoiceMemoryGraph } from "../voiceMemoryGraph";
import type { ProjectedNode } from "./memoryBackdrop";

export interface LabelPickOptions {
  mode: VoiceBackdropLabels;
  width: number;
  height: number;
  /** Screen area (css px) to keep free, e.g. the orb. */
  avoid: { x: number; y: number; width: number; height: number } | null;
}

const MAX_LABELS: Record<VoiceBackdropLabels, number> = { none: 0, titles: 9, "titles-notes": 5 };

/**
 * Chooses which nodes get a label: front-facing, on screen, outside the orb, spread
 * apart, preferring notes close to index.md and with many links. The root is always
 * labelled while visible.
 */
export function pickLabelNodes(projected: ProjectedNode[], graph: VoiceMemoryGraph, options: LabelPickOptions): number[] {
  const limit = MAX_LABELS[options.mode];
  if (!limit) return [];
  const margin = 24;
  const spacing = options.mode === "titles-notes" ? 190 : 120;
  const avoid = options.avoid;
  const candidates = projected.filter((point) => {
    if (point.depth > 0.15 || point.x < margin || point.y < margin || point.x > options.width - margin || point.y > options.height - margin) return false;
    if (avoid && point.x > avoid.x - 30 && point.x < avoid.x + avoid.width + 30 && point.y > avoid.y - 20 && point.y < avoid.y + avoid.height + 40) return false;
    return true;
  });
  const score = (point: ProjectedNode) => {
    const node = graph.nodes[point.index]!;
    if (point.index === graph.rootIndex) return Number.POSITIVE_INFINITY;
    return node.degree * 0.6 - node.hop * 1.5 - point.depth * 4 + (node.kind === "folder" ? -1 : 0)
      + (options.mode === "titles-notes" && node.preview ? 2 : 0);
  };
  candidates.sort((a, b) => score(b) - score(a));
  const chosen: ProjectedNode[] = [];
  for (const point of candidates) {
    if (chosen.length >= limit) break;
    if (chosen.some((other) => Math.abs(other.x - point.x) < spacing && Math.abs(other.y - point.y) < spacing * 0.45)) continue;
    chosen.push(point);
  }
  return chosen.map((point) => point.index);
}

/**
 * A small pool of absolutely positioned DOM labels following their nodes every frame.
 * The chosen set is re-evaluated only every ~1.4 s and labels fade in/out via CSS, so
 * the rotating graph never makes text flicker. DOM text stays crisp on every browser,
 * unlike text rendered into WebGL textures.
 */
export class LabelOverlay {
  private readonly pool = new Map<number, HTMLDivElement>();
  private mode: VoiceBackdropLabels = "none";
  private chosen: number[] = [];
  private lastPick = -Infinity;

  constructor(private readonly layer: HTMLElement) {}

  setMode(mode: VoiceBackdropLabels): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lastPick = -Infinity;
    for (const element of this.pool.values()) element.remove();
    this.pool.clear();
  }

  update(now: number, graph: VoiceMemoryGraph | null, projected: ProjectedNode[], options: Omit<LabelPickOptions, "mode">): void {
    if (!graph || this.mode === "none") { this.clear(); return; }
    if (now - this.lastPick > 1400) {
      this.lastPick = now;
      this.chosen = pickLabelNodes(projected, graph, { ...options, mode: this.mode });
      for (const [index, element] of this.pool) {
        if (this.chosen.includes(index)) continue;
        element.style.opacity = "0";
        if (element.dataset.leaving !== "1") {
          element.dataset.leaving = "1";
          setTimeout(() => { if (element.dataset.leaving === "1") { element.remove(); this.pool.delete(index); } }, 600);
        }
      }
    }
    for (const index of this.chosen) {
      const point = projected[index];
      const node = graph.nodes[index];
      if (!point || !node) continue;
      let element = this.pool.get(index);
      if (!element) {
        element = this.createLabel(node.title, index === graph.rootIndex, this.mode === "titles-notes" ? node.preview : undefined);
        this.pool.set(index, element);
        this.layer.appendChild(element);
        const created = element;
        requestAnimationFrame(() => { created.style.opacity = "var(--label-opacity)"; });
      }
      element.dataset.leaving = "0";
      if (element.style.opacity === "0") element.style.opacity = "var(--label-opacity)";
      const offset = index === graph.rootIndex ? 18 : 10;
      element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${(point.y + offset).toFixed(1)}px, 0) translateX(-50%)`;
      // Labels drifting toward the back dim with their node.
      element.style.setProperty("--label-opacity", String(Math.max(0.35, Math.min(0.9, 0.75 - point.depth * 0.5))));
    }
  }

  private createLabel(title: string, root: boolean, preview: string | undefined): HTMLDivElement {
    const element = document.createElement("div");
    element.className = preview
      ? "absolute left-0 top-0 max-w-[220px] rounded-md border border-white/10 bg-slate-950/55 px-2 py-1 text-left shadow-lg backdrop-blur-[2px] transition-opacity duration-500 will-change-transform"
      : "absolute left-0 top-0 whitespace-nowrap transition-opacity duration-500 will-change-transform";
    element.style.opacity = "0";
    const heading = document.createElement("div");
    heading.className = root
      ? "text-[11px] font-semibold tracking-wide text-amber-200/90"
      : "max-w-[200px] truncate text-[10px] font-medium tracking-wide text-sky-100/80";
    heading.textContent = root ? "index.md" : title;
    element.appendChild(heading);
    if (preview) {
      const body = document.createElement("div");
      body.className = "mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-300/75";
      body.textContent = preview;
      element.appendChild(body);
    }
    return element;
  }

  clear(): void {
    for (const element of this.pool.values()) element.remove();
    this.pool.clear();
    this.chosen = [];
  }
}
