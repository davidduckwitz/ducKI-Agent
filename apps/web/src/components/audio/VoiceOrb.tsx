import { useEffect, useRef, useState } from "react";
import { createAudioLevelAnalyser, type AudioLevelAnalyserHandle } from "../../lib/audioLevelAnalyser";
import { onVoiceCaptureStarted, onVoiceCaptureStopped } from "../../lib/voiceCaptureBus";
import { isPlaybackActive } from "../../lib/voicePlaybackRegistry";
import { readVoiceOutput } from "../../lib/voiceOutputAnalyser";
import { useAppStore } from "../../lib/store";

export type VoiceOrbStatus = "idle" | "listening" | "thinking" | "speaking" | "user-speaking";
const LABELS: Record<VoiceOrbStatus, string> = {
  idle: "Bereit für dich", listening: "Ich höre zu", thinking: "Agent arbeitet",
  speaking: "Agent spricht", "user-speaking": "Du sprichst",
};

// Perspective-projected 3D particle shell. All audio sampling and animation stays outside
// React: only semantic state transitions cause renders, never individual audio frames.
export function VoiceOrb({ size = 420 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<VoiceOrbStatus>("idle");
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    let microphone: AudioLevelAnalyserHandle | null = null;
    const offStart = onVoiceCaptureStarted((stream) => {
      microphone?.stop(); microphone = createAudioLevelAnalyser(stream);
    });
    const offStop = onVoiceCaptureStopped(() => { microphone?.stop(); microphone = null; });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const input = new Uint8Array(1024), output = new Uint8Array(1024);
    const inputSpectrum = new Uint8Array(512), outputSpectrum = new Uint8Array(512);
    const inputHistory = Array.from({ length: 3 }, () => new Uint8Array(1024).fill(128));
    const outputHistory = Array.from({ length: 3 }, () => new Uint8Array(1024).fill(128));
    let historyIndex = 0;
    input.fill(128); output.fill(128);
    let frame = 0, previousTime = 0, energy = 0, lastSpeech = -1000;
    let bass = 0, mids = 0, highs = 0;
    const echoes = new Float32Array(80);
    let echoIndex = 0;
    let currentStatus: VoiceOrbStatus = "idle";
    let width = size;
    const resize = () => {
      width = canvas.clientWidth || size;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(width * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const points = Array.from({ length: 11000 }, (_, i) => {
      const y = 1 - (i + 0.5) / 5500;
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const radius = Math.sqrt(1 - y * y);
      return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, angle, azimuth: Math.atan2(Math.sin(angle), Math.cos(angle)) };
    });
    const rms = (data: Uint8Array) => {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += ((data[i]! - 128) / 128) ** 2;
      return Math.sqrt(sum / data.length);
    };
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (document.hidden || now - previousTime < (motion.matches ? 100 : 1000 / 60)) return;
      previousTime = now;
      microphone?.read(input, inputSpectrum);
      if (!microphone) { input.fill(128); inputSpectrum.fill(0); }
      const measuredOutput = readVoiceOutput(output, outputSpectrum);
      inputHistory[historyIndex]!.set(input); outputHistory[historyIndex]!.set(output);
      historyIndex = (historyIndex + 1) % 3;
      const inputLevel = rms(input), outputLevel = rms(output);
      if (inputLevel > 0.025) lastSpeech = now;
      const speaking = isPlaybackActive();
      const next: VoiceOrbStatus = microphone && now - lastSpeech < 240 ? "user-speaking"
        : speaking ? "speaking" : useAppStore.getState().isLoading ? "thinking"
        : microphone ? "listening" : "idle";
      if (next !== currentStatus) { currentStatus = next; setStatus(next); }
      const user = next === "user-speaking";
      const wave = user ? input : output;
      const spectrum = user ? inputSpectrum : outputSpectrum;
      const target = Math.min(1, (user ? inputLevel : outputLevel) * 6);
      energy += (target - energy) * (target > energy ? 0.5 : 0.12);
      const bandEnergy = (from: number, to: number) => {
        let sum = 0;
        for (let i = from; i < to; i++) sum += spectrum[i]! / 255;
        return sum / (to - from);
      };
      bass += (bandEnergy(1, 8) - bass) * 0.3;
      mids += (bandEnergy(8, 70) - mids) * 0.4;
      highs += (bandEnergy(70, 230) - highs) * 0.5;
      echoes[echoIndex] = energy;
      echoIndex = (echoIndex + 1) % echoes.length;
      const t = motion.matches ? 0 : now * 0.001;
      const rotation = t * (next === "thinking" ? 0.25 : 0.09);
      const cs = Math.cos(rotation), sn = Math.sin(rotation);
      const radius = width * 0.315;
      ctx.fillStyle = "#020306"; ctx.fillRect(0, 0, width, width);
      const halo = ctx.createRadialGradient(width / 2, width / 2, radius * 0.3, width / 2, width / 2, radius * 1.5);
      halo.addColorStop(0, "rgba(38,24,86,0.16)");
      halo.addColorStop(0.7, `rgba(85,30,125,${0.06 + energy * 0.12})`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo; ctx.fillRect(0, 0, width, width);
      ctx.globalCompositeOperation = "lighter";
      for (const point of points) {
        const longitude = (point.azimuth + Math.PI) / (2 * Math.PI);
        const band = Math.min(400, Math.floor(2 ** (longitude * 8.5)));
        const echo = echoes[(echoIndex + Math.floor((point.y + 1) * 39)) % echoes.length]!;
        const frequency = spectrum[band]! / 255;
        const sample = (wave[Math.floor(longitude * 1023)]! - 128) / 128;
        const azimuth = point.azimuth;
        const ripple = Math.sin(azimuth * 5 + point.y * 9 - t * 1.8) * 0.045
          + Math.cos(azimuth * 3 - point.y * 13 + t) * 0.025
          + Math.sin(point.angle * 7 + t * 0.8) * 0.012;
        const working = next === "thinking" ? Math.sin(point.y * 16 - t * 4 + point.angle) * 0.045 : 0;
        const deformation = motion.matches ? 1 + ripple : 1 + ripple + working + bass * 0.13
          + sample * (0.48 + mids * 0.2) + frequency * 0.15
          + Math.sin(point.y * 24 - t * 5 + azimuth * 2) * echo * 0.13;
        const twist = motion.matches ? 0 : sample * 0.24 + Math.sin(point.y * 8 + t) * mids * 0.16;
        const x = (point.x * cs + point.z * sn + point.y * twist) * deformation;
        const z = (point.z * cs - point.x * sn + point.x * twist) * deformation;
        const y = point.y * deformation;
        const perspective = 3.8 / (3.8 - z);
        const px = width / 2 + x * radius * perspective;
        const py = width / 2 + y * radius * perspective;
        const edge = Math.pow(1 - Math.abs(point.z), 3);
        const alpha = Math.min(1, (z < 0 ? 0.12 : 0.55) + edge * 0.2 + energy * 0.18 + frequency * highs * 0.4);
        // Cyan crown, violet middle, hot coral base, matching the reference.
        const hue = point.y < -0.15 ? 195 + (point.y + 1) * 75 : 260 + (point.y + 0.15) * 108;
        ctx.fillStyle = `hsla(${hue % 360},95%,${60 + frequency * 20}%,${alpha})`;
        const dot = (0.45 + (z + 1) * 0.3 + frequency * 0.9) * width / 420;
        ctx.beginPath(); ctx.arc(px, py, Math.max(0.35, dot), 0, Math.PI * 2); ctx.fill();
      }
      // Oscilloscope ribbons wrap around the actual 3D shell. Each channel has its
      // own waveform, projected using the same camera, plus a faint phosphor trail.
      const project = (x: number, y: number, z: number) => {
        const rx = x * cs + z * sn, rz = z * cs - x * sn;
        const perspective = 3.8 / (3.8 - rz);
        return [width / 2 + rx * radius * perspective, width / 2 + y * radius * perspective];
      };
      for (const [history, color, latitude, level] of [
        [inputHistory, "103,232,249", -0.26, inputLevel],
        [outputHistory, "251,113,133", 0.26, outputLevel],
      ] as const) {
        for (let trail = 2; trail >= 0; trail--) {
          const channel = history[(historyIndex + 2 - trail) % 3]!;
          ctx.strokeStyle = `rgba(${color},${(trail ? 0.10 : 0.35) + Math.min(level * 2, 0.45)})`;
          ctx.lineWidth = trail ? 1 : 1.4;
          ctx.beginPath();
          for (let i = 0; i <= 384; i++) {
            const theta = i / 384 * Math.PI * 2;
            const sample = (channel[Math.floor(i / 384 * 1023)]! - 128) / 128;
            const waveHeight = motion.matches ? 0 : sample * 0.65;
            const r = Math.sqrt(1 - latitude * latitude) + Math.abs(waveHeight) * 0.16;
            const [px, py] = project(Math.cos(theta) * r, latitude + waveHeight + trail * 0.025, Math.sin(theta) * r);
            if (i === 0) ctx.moveTo(px!, py!); else ctx.lineTo(px!, py!);
          }
          ctx.stroke();
        }
      }
      // Two genuine oscilloscope traces: microphone above, agent output below.
      for (const [channel, color, offset] of [[input, "#67e8f9", -1], [output, "#fb7185", 1]] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.65;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
          const x = width * 0.23 + i / 255 * width * 0.54;
          const y = width * 0.91 + offset * 5 + (channel[i * 4]! - 128) / 128 * width * 0.07;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      // Native speechSynthesis exposes no PCM. Its state stays visible, without faking a waveform.
      canvas.dataset.outputMeasured = String(measuredOutput);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); offStart(); offStop(); microphone?.stop();
    };
  }, [size]);
  return (
    <div className="relative flex flex-col items-center" style={{ width: `min(${size}px, 78vw)` }}>
      <canvas ref={canvasRef} className="aspect-square w-full rounded-full" aria-hidden="true" />
      <span role="status" className="mt-1 text-sm font-medium tracking-wide text-slate-200">{LABELS[status]}</span>
      <span className="mt-2 flex gap-4 text-[10px] uppercase tracking-[0.18em] text-slate-500">
        <span className="text-cyan-300/70">● Mikrofon</span><span className="text-rose-300/70">● Agent</span>
      </span>
    </div>
  );
}
