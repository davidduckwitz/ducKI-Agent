import type { VoiceMemoryGraph } from "../voiceMemoryGraph";

export type DischargeKind = "bolt" | "pulse";

export interface Discharge {
  kind: DischargeKind;
  edge: number;
  from: number;
  to: number;
  born: number;
  /** ms until the head reaches `to`. */
  travel: number;
  /** ms from birth until fully faded. */
  life: number;
  /** Re-rolled by the renderer for the jagged path, so each bolt flickers differently. */
  seed: number;
  generation: number;
  arrived: boolean;
}

export interface DischargeInput {
  speaking: boolean;
  thinking: boolean;
  /** Smoothed agent output energy, 0..1. */
  energy: number;
  /** A syllable started this frame. */
  onset: boolean;
  reducedMotion: boolean;
}

const MAX_GENERATION = 4;
const BOLT_FADE_MS = 260;

/**
 * Decides when and where synapse discharges travel through the wiki graph. While the
 * agent speaks, bolts fire at a rate following its voice energy, syllable onsets add
 * small bursts, and a bolt reaching a note may fire onward along that note's other
 * links - a cascade like neurons triggering each other. While the agent only thinks,
 * slow single pulses wander instead. Reduced motion keeps sparse single bolts only. Pure logic: rendering lives in memoryGraph3d.ts.
 */
export class SynapseScheduler {
  readonly discharges: Discharge[] = [];
  /** Per-node glow, 0..1, set when a discharge arrives and decaying afterwards. */
  readonly flash: Float32Array;
  private boltCarry = 0;
  private pulseCarry = 0;

  constructor(
    private readonly graph: Pick<VoiceMemoryGraph, "edges" | "incident" | "rootIndex">,
    private readonly random: () => number = Math.random,
    readonly maxDischarges = 56,
  ) {
    this.flash = new Float32Array(graph.incident.length);
  }

  update(now: number, dtSeconds: number, input: DischargeInput): void {
    const decay = Math.exp(-dtSeconds * 3.2);
    for (let i = 0; i < this.flash.length; i++) this.flash[i]! *= decay;

    for (let i = this.discharges.length - 1; i >= 0; i--) {
      const discharge = this.discharges[i]!;
      const age = now - discharge.born;
      if (!discharge.arrived && age >= discharge.travel) {
        discharge.arrived = true;
        this.flash[discharge.to] = Math.min(1, this.flash[discharge.to]! + (discharge.kind === "bolt" ? 0.85 : 0.4));
        if (discharge.kind === "bolt" && input.speaking && !input.reducedMotion && discharge.generation < MAX_GENERATION
          && this.random() < 0.3 + input.energy * 0.5) {
          const children = this.random() < input.energy * 0.6 ? 2 : 1;
          for (let c = 0; c < children; c++) this.fire("bolt", discharge.to, now, discharge.generation + 1, discharge.edge);
        }
      }
      if (age >= discharge.life) this.discharges.splice(i, 1);
    }

    if (!this.graph.edges.length) { this.boltCarry = this.pulseCarry = 0; return; }
    if (input.speaking) {
      // Baseline keeps bolts alive for TTS engines without measurable PCM (Web Speech).
      // Reduced motion: a few single bolts, no syllable bursts and no cascades.
      this.boltCarry += dtSeconds * (input.reducedMotion ? 1 + input.energy * 3 : 2 + input.energy * 16);
      if (input.onset && !input.reducedMotion) this.boltCarry += 2 + Math.floor(input.energy * 3);
    } else {
      this.boltCarry = 0;
    }
    this.pulseCarry = input.thinking ? this.pulseCarry + dtSeconds * (input.reducedMotion ? 0.5 : 1.2) : 0;
    while (this.boltCarry >= 1) { this.boltCarry -= 1; this.fire("bolt", this.pickStart(), now, 0); }
    while (this.pulseCarry >= 1) { this.pulseCarry -= 1; this.fire("pulse", this.pickStart(), now, 0); }
  }

  /** index.md is the most frequent origin; otherwise a random link end, i.e. degree-weighted. */
  private pickStart(): number {
    if (this.random() < 0.4 && this.graph.incident[this.graph.rootIndex]?.length) return this.graph.rootIndex;
    const edge = this.graph.edges[Math.floor(this.random() * this.graph.edges.length)]!;
    return this.random() < 0.5 ? edge.source : edge.target;
  }

  private fire(kind: DischargeKind, from: number, now: number, generation: number, avoidEdge?: number): void {
    if (this.discharges.length >= this.maxDischarges) return;
    const options = (this.graph.incident[from] ?? []).filter((edge) => edge !== avoidEdge);
    if (!options.length) return;
    const edgeIndex = options[Math.floor(this.random() * options.length)]!;
    const edge = this.graph.edges[edgeIndex]!;
    const to = edge.source === from ? edge.target : edge.source;
    const travel = kind === "bolt" ? 80 + this.random() * 90 : 900 + this.random() * 500;
    this.discharges.push({
      kind, edge: edgeIndex, from, to, born: now, travel,
      life: travel + (kind === "bolt" ? BOLT_FADE_MS : 350),
      seed: this.random() * 1000, generation, arrived: false,
    });
  }
}
