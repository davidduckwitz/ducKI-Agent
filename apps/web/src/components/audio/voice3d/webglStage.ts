import * as THREE from "three";
import type { VoiceBackdropLabels } from "../../../hooks/useVoiceSettings";
import type { VoiceMemoryGraph } from "../voiceMemoryGraph";
import type { VoiceAudioFeatures } from "./audioFeatures";
import { LabelOverlay } from "./labelOverlay";
import { MemoryBackdrop, type ProjectedNode } from "./memoryBackdrop";
import { AudioTexture, OrbLayer } from "./orbLayer";
import { SynapseScheduler } from "./synapseBolts";

export interface VoiceStageHandle {
  setGraph(graph: VoiceMemoryGraph | null): void;
  setLabelMode(mode: VoiceBackdropLabels): void;
  setOrbAnchor(element: HTMLElement | null): void;
  dispose(): void;
}

interface QualityTier { maxPixelRatio: number; particles: number }
/** Stepped down - never back up, to avoid oscillating - when frames run long. */
const QUALITY: QualityTier[] = [
  { maxPixelRatio: 2, particles: 36000 },
  { maxPixelRatio: 1.5, particles: 20000 },
  { maxPixelRatio: 1, particles: 11000 },
];
const MAX_DISCHARGES = 56;

/**
 * One WebGL canvas for the whole voice tab: the wiki backdrop fills it, the orb is
 * drawn into the on-screen rect of its DOM anchor via viewport + scissor. A single
 * context avoids per-page context limits (iOS) and keeps both layers in one frame.
 */
export function createWebGLStage(options: {
  canvas: HTMLCanvasElement;
  labelLayer: HTMLElement;
  features: VoiceAudioFeatures;
  onContextLost: () => void;
}): VoiceStageHandle {
  const { canvas, labelLayer, features } = options;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  const coarse = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency ?? 8) <= 4;
  let tier = coarse ? 1 : 0;
  const audio = new AudioTexture();
  const orb = new OrbLayer(audio);
  const backdrop = new MemoryBackdrop(MAX_DISCHARGES);
  const labels = new LabelOverlay(labelLayer);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let scheduler: SynapseScheduler | null = null;
  let orbAnchor: HTMLElement | null = null;
  let width = 0, height = 0;

  const applyQuality = () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, QUALITY[tier]!.maxPixelRatio));
    orb.setParticleCount(QUALITY[tier]!.particles);
  };
  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    backdrop.resize(width, height);
  };
  applyQuality();
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const onLost = (event: Event) => { event.preventDefault(); options.onContextLost(); };
  canvas.addEventListener("webglcontextlost", onLost);

  let frame = 0, previous = 0, slowFrames = 0;
  const projected: ProjectedNode[] = [];
  const render = (now: number) => {
    frame = requestAnimationFrame(render);
    if (document.hidden || width === 0 || height === 0) return;
    const reduced = motion.matches;
    const elapsed = now - previous;
    if (reduced && elapsed < 33) return;
    previous = now;

    if (elapsed > 0 && elapsed < 250) {
      // The reduced-motion 30 fps cap must not count as a slow frame.
      slowFrames = elapsed > (reduced ? 50 : 26) ? slowFrames + 1 : Math.max(0, slowFrames - 2);
      if (slowFrames > 90 && tier < QUALITY.length - 1) { tier += 1; slowFrames = 0; applyQuality(); }
    }

    features.update(now);
    audio.update(features);
    const seconds = now * 0.001;
    const dt = Math.min(0.1, elapsed / 1000);
    scheduler?.update(now, dt, {
      speaking: features.status === "speaking",
      thinking: features.status === "thinking",
      energy: features.outputEnergy,
      onset: features.outputOnset,
      reducedMotion: reduced,
    });
    const canvasRect = canvas.getBoundingClientRect();
    let orbRect: { x: number; y: number; width: number; height: number } | null = null;
    if (orbAnchor?.isConnected) {
      const rect = orbAnchor.getBoundingClientRect();
      const x = rect.left - canvasRect.left, y = rect.top - canvasRect.top, size = rect.width;
      if (size > 0 && y + size > 0 && y < height) orbRect = { x, y, width: size, height: size };
    }
    if (orbRect) backdrop.focusOn(orbRect.x + orbRect.width / 2, orbRect.y + orbRect.height / 2);
    backdrop.update(seconds, reduced, features.outputEnergy, scheduler, now, height * renderer.getPixelRatio());

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear();
    renderer.render(backdrop.scene, backdrop.camera);

    if (orbRect) {
      const { x, y, width: size } = orbRect;
      orb.update(features, seconds, reduced, size, renderer.getPixelRatio());
      renderer.setViewport(x, height - y - size, size, size);
      renderer.setScissor(x, height - y - size, size, size);
      renderer.setScissorTest(true);
      renderer.render(orb.scene, orb.camera);
      renderer.setScissorTest(false);
    }
    canvas.dataset.outputMeasured = String(features.measuredOutput);
    canvas.dataset.quality = String(tier);
    canvas.dataset.discharges = String(scheduler?.discharges.length ?? 0);

    labels.update(now, backdrop.memoryGraph, backdrop.project(width, height, projected), { width, height, avoid: orbRect });
  };
  frame = requestAnimationFrame(render);

  return {
    setGraph(graph) {
      backdrop.setGraph(graph);
      scheduler = graph ? new SynapseScheduler(graph, Math.random, MAX_DISCHARGES) : null;
      labels.clear();
    },
    setLabelMode(mode) { labels.setMode(mode); },
    setOrbAnchor(element) { orbAnchor = element; },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      labels.clear();
      orb.dispose();
      backdrop.dispose();
      audio.dispose();
      renderer.dispose();
    },
  };
}
