import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { buildVoiceMemoryGraph, relaxVoiceMemoryLayout } from "./voiceMemoryGraph";
import { VoiceAudioFeatures, type VoiceOrbStatus } from "./voice3d/audioFeatures";
import type { VoiceStageHandle } from "./voice3d/webglStage";

/** "loading" while three.js is fetched; "2d" without WebGL2 or after a lost GPU context. */
export type VoiceStageMode = "loading" | "webgl" | "2d";

interface VoiceStageContextValue {
  mode: VoiceStageMode;
  status: VoiceOrbStatus;
  features: VoiceAudioFeatures;
  setOrbAnchor: (element: HTMLElement | null) => void;
}

const VoiceStageContext = createContext<VoiceStageContextValue | null>(null);
export const useVoiceStage = () => useContext(VoiceStageContext);

function supportsWebGL2(): boolean {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

/**
 * Hosts the voice tab's visuals: a full-size WebGL canvas behind `children` showing the
 * LLM wiki as a rotating 3D network, into which the VoiceOrb is drawn wherever its anchor
 * sits. three.js is loaded only when this tab opens. Without WebGL2 the orb falls back to
 * its own canvas-2D renderer and the backdrop stays a plain dark surface.
 */
export function VoiceStage({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<VoiceStageHandle | null>(null);
  const orbAnchorRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<VoiceOrbStatus>("idle");
  const [features] = useState(() => new VoiceAudioFeatures(setStatus));
  const [mode, setMode] = useState<VoiceStageMode>(() => (supportsWebGL2() ? "loading" : "2d"));
  const labelMode = useVoiceSettings((state) => state.voiceBackdropLabels);
  const previews = labelMode === "titles-notes";

  const graphQuery = useQuery({
    queryKey: ["wiki", "graph", { previews }],
    queryFn: () => api.wiki.graph({ previews }),
    refetchInterval: 30000,
    retry: false,
    enabled: mode !== "2d",
  });
  // Relaxing is the expensive part; the 30 s refetch only rebuilds when the graph changed.
  const graphSignature = useMemo(() => {
    const data = graphQuery.data;
    if (!data) return "";
    return JSON.stringify([data.nodes.map((node) => [node.id, node.status, node.preview ?? ""]), data.edges.map((edge) => [edge.source, edge.target, edge.resolved])]);
  }, [graphQuery.data]);
  const graph = useMemo(() => {
    const built = buildVoiceMemoryGraph(graphQuery.data);
    return built ? relaxVoiceMemoryLayout(built) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSignature]);

  useEffect(() => () => features.dispose(), [features]);

  useEffect(() => {
    if (mode === "2d") return;
    let cancelled = false;
    void import("./voice3d/webglStage").then(({ createWebGLStage }) => {
      const canvas = canvasRef.current, labelLayer = labelLayerRef.current;
      if (cancelled || !canvas || !labelLayer) return;
      try {
        handleRef.current = createWebGLStage({ canvas, labelLayer, features, onContextLost: () => setMode("2d") });
      } catch (error) {
        console.warn("[VoiceStage] WebGL unavailable, using 2D orb", error);
        setMode("2d");
        return;
      }
      handleRef.current.setOrbAnchor(orbAnchorRef.current);
      setMode("webgl");
    }).catch((error) => {
      console.warn("[VoiceStage] could not load 3D renderer", error);
      if (!cancelled) setMode("2d");
    });
    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // Only (re)created when entering a WebGL-capable mode, not on the loading->webgl step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode === "2d", features]);

  useEffect(() => { if (mode === "webgl") handleRef.current?.setGraph(graph); }, [graph, mode]);
  useEffect(() => { if (mode === "webgl") handleRef.current?.setLabelMode(labelMode); }, [labelMode, mode]);

  const setOrbAnchor = useCallback((element: HTMLElement | null) => {
    orbAnchorRef.current = element;
    handleRef.current?.setOrbAnchor(element);
  }, []);
  const value = useMemo<VoiceStageContextValue>(() => ({ mode, status, features, setOrbAnchor }), [mode, status, features, setOrbAnchor]);

  return (
    <VoiceStageContext.Provider value={value}>
      <div className="relative h-full min-h-0 overflow-hidden bg-[#020306]">
        {mode !== "2d" && (
          <>
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
            <div ref={labelLayerRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" />
          </>
        )}
        {/* Soft vignette keeps the controls readable over the brightest part of the network. */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(2,3,6,0.7)_100%)]" aria-hidden="true" />
        <div className="relative h-full min-h-0">{children}</div>
      </div>
    </VoiceStageContext.Provider>
  );
}
