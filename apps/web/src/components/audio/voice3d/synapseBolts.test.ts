import { describe, expect, it } from "vitest";
import { buildVoiceMemoryGraph, type WikiMemoryNode } from "../voiceMemoryGraph";
import { SynapseScheduler, type DischargeInput } from "./synapseBolts";

const node = (id: string): WikiMemoryNode => ({ id, title: id, status: "approved", tags: [], degree: 1 });
const chain = buildVoiceMemoryGraph({
  nodes: ["index.md", "a.md", "b.md", "c.md"].map(node),
  edges: [
    { id: 1, source: "index.md", target: "a.md", resolved: true },
    { id: 2, source: "a.md", target: "b.md", resolved: true },
    { id: 3, source: "b.md", target: "c.md", resolved: true },
  ],
})!;
const quiet: DischargeInput = { speaking: false, thinking: false, energy: 0, onset: false, reducedMotion: false };

function seeded(seed = 7) {
  let state = seed;
  return () => { state = (state * 16807) % 2147483647; return (state - 1) / 2147483646; };
}

describe("SynapseScheduler", () => {
  it("stays silent while nobody speaks", () => {
    const scheduler = new SynapseScheduler(chain, seeded());
    for (let t = 0; t < 2000; t += 16) scheduler.update(t, 0.016, quiet);
    expect(scheduler.discharges).toHaveLength(0);
  });

  it("fires bolts along real links while the agent speaks and flashes their targets", () => {
    const scheduler = new SynapseScheduler(chain, seeded());
    const speaking = { ...quiet, speaking: true, energy: 0.8 };
    let seen = 0;
    for (let t = 0; t < 1000; t += 16) {
      scheduler.update(t, 0.016, speaking);
      for (const discharge of scheduler.discharges) {
        const edge = chain.edges[discharge.edge]!;
        expect([edge.source, edge.target].sort()).toEqual([discharge.from, discharge.to].sort());
      }
      seen = Math.max(seen, scheduler.discharges.length);
    }
    expect(seen).toBeGreaterThan(2);
    expect(Math.max(...scheduler.flash)).toBeGreaterThan(0);
  });

  it("cascades onward without bouncing straight back and respects the pool size", () => {
    const scheduler = new SynapseScheduler(chain, () => 0.01, 4);
    scheduler.update(0, 0.2, { ...quiet, speaking: true, energy: 1, onset: true });
    expect(scheduler.discharges.length).toBeLessThanOrEqual(4);
    const first = scheduler.discharges[0]!;
    scheduler.discharges.splice(1);
    scheduler.update(first.travel + 1, 0, { ...quiet, speaking: true, energy: 1 });
    const children = scheduler.discharges.filter((discharge) => discharge.generation === 1);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => child.from === first.to && child.edge !== first.edge)).toBe(true);
  });

  it("sends slow pulses while thinking and only sparse single bolts under reduced motion", () => {
    const thinking = new SynapseScheduler(chain, seeded());
    for (let t = 0; t < 2000; t += 16) thinking.update(t, 0.016, { ...quiet, thinking: true });
    expect(thinking.discharges.every((discharge) => discharge.kind === "pulse")).toBe(true);
    expect(thinking.discharges.length).toBeGreaterThan(0);

    const reduced = new SynapseScheduler(chain, seeded());
    const full = new SynapseScheduler(chain, seeded());
    let reducedMax = 0, fullMax = 0;
    for (let t = 0; t < 2000; t += 16) {
      reduced.update(t, 0.016, { ...quiet, speaking: true, energy: 1, onset: t % 160 === 0, reducedMotion: true });
      full.update(t, 0.016, { ...quiet, speaking: true, energy: 1, onset: t % 160 === 0 });
      expect(reduced.discharges.every((discharge) => discharge.generation === 0)).toBe(true);
      reducedMax = Math.max(reducedMax, reduced.discharges.length);
      fullMax = Math.max(fullMax, full.discharges.length);
    }
    expect(reducedMax).toBeGreaterThan(0);
    expect(reducedMax).toBeLessThan(fullMax);
  });
});
