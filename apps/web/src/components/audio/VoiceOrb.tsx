import { useEffect, useRef, useState } from "react";
import { useVoiceStage } from "./VoiceStage";
import { VoiceAudioFeatures, type VoiceOrbStatus } from "./voice3d/audioFeatures";
import { startFallbackOrb } from "./voice3d/fallback2d";

export type { VoiceOrbStatus };
const LABELS: Record<VoiceOrbStatus, string> = {
  idle: "Bereit für dich", listening: "Ich höre zu", thinking: "Agent arbeitet",
  speaking: "Agent spricht", "user-speaking": "Du sprichst",
};

/**
 * Layout slot and status label of the voice orb. Inside a VoiceStage with WebGL the orb
 * itself is drawn by the stage's shared GPU canvas into this element's rect; otherwise
 * (no WebGL2, lost context, or used outside a stage) a canvas-2D fallback renders here.
 */
export function VoiceOrb({ size = 420 }: { size?: number }) {
  const stage = useVoiceStage();
  const anchorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [localStatus, setLocalStatus] = useState<VoiceOrbStatus>("idle");
  const stageMode = stage?.mode ?? "2d";
  const setOrbAnchor = stage?.setOrbAnchor;
  const stageFeatures = stage?.features;

  useEffect(() => {
    if (!setOrbAnchor) return;
    setOrbAnchor(anchorRef.current);
    return () => setOrbAnchor(null);
  }, [setOrbAnchor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (stageMode !== "2d" || !canvas) return;
    const own = stageFeatures ? null : new VoiceAudioFeatures(setLocalStatus);
    const stop = startFallbackOrb(canvas, stageFeatures ?? own!, true);
    return () => { stop(); own?.dispose(); };
  }, [stageMode, stageFeatures]);

  const status = stage?.status ?? localStatus;
  return (
    <div className="relative flex flex-col items-center" style={{ width: `min(${size}px, 78vw)` }}>
      <div ref={anchorRef} className="aspect-square w-full rounded-full" data-voice-orb={stageMode}>
        {stageMode === "2d" && <canvas ref={canvasRef} className="h-full w-full rounded-full" aria-hidden="true" />}
      </div>
      <span role="status" className="mt-1 text-sm font-medium tracking-wide text-slate-200">{LABELS[status]}</span>
      <span className="mt-2 flex gap-4 text-[10px] uppercase tracking-[0.18em] text-slate-500">
        <span className="text-cyan-300/70">● Mikrofon</span><span className="text-rose-300/70">● Agent</span>
      </span>
    </div>
  );
}
