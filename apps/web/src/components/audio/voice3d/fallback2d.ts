import type { VoiceAudioFeatures } from "./audioFeatures";

const POINT_COUNT = 3200;

/**
 * Canvas-2D orb for browsers without WebGL2 (or after a lost GPU context). It is the
 * former renderer slimmed down for software rasterizers: a quarter of the particles,
 * no `shadowBlur`, rects instead of arcs and colors bucketed into a fixed palette so
 * no per-particle color strings are allocated each frame.
 */
export function startFallbackOrb(canvas: HTMLCanvasElement, features: VoiceAudioFeatures, ownsFeatures: boolean): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = canvas.clientWidth || 300;
  const resize = () => {
    width = canvas.clientWidth || 300;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(width * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  const points = Array.from({ length: POINT_COUNT }, (_, i) => {
    const y = 1 - (i + 0.5) / (POINT_COUNT / 2);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const hue = y < -0.15 ? 195 + (y + 1) * 75 : 260 + (y + 0.15) * 108;
    return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, angle, azimuth: Math.atan2(Math.sin(angle), Math.cos(angle)), color: `hsl(${Math.round(hue % 360)},95%,64%)` };
  });
  let frame = 0, previous = 0;
  const render = (now: number) => {
    frame = requestAnimationFrame(render);
    if (document.hidden || now - previous < (motion.matches ? 1000 / 30 : 1000 / 45)) return;
    previous = now;
    if (ownsFeatures) features.update(now);
    const { wave, spectrum, energy, bass, mids, status } = features;
    // Reduced motion: slower and gentler, but still reacting to the voice.
    const calm = motion.matches ? 0.4 : 1;
    const t = now * 0.001 * calm;
    const rotation = t * (status === "thinking" ? 0.25 : 0.09);
    const cs = Math.cos(rotation), sn = Math.sin(rotation);
    const radius = width * 0.315;
    ctx.clearRect(0, 0, width, width);
    const halo = ctx.createRadialGradient(width / 2, width / 2, radius * 0.2, width / 2, width / 2, width / 2);
    halo.addColorStop(0, "rgba(2,3,6,0.92)");
    halo.addColorStop(0.62, `rgba(45,22,95,${0.25 + energy * 0.15})`);
    halo.addColorStop(1, "rgba(2,3,6,0)");
    ctx.fillStyle = halo; ctx.fillRect(0, 0, width, width);
    ctx.globalCompositeOperation = "lighter";
    for (const point of points) {
      const longitude = (point.azimuth + Math.PI) / (2 * Math.PI);
      const frequency = spectrum[Math.min(400, Math.floor(2 ** (longitude * 8.5)))]! / 255;
      const sample = (wave[Math.floor(longitude * 1023)]! - 128) / 128;
      const ripple = Math.sin(point.azimuth * 5 + point.y * 9 - t * 1.8) * 0.045 + Math.cos(point.azimuth * 3 - point.y * 13 + t) * 0.025;
      const working = status === "thinking" ? Math.sin(point.y * 16 - t * 4 + point.angle) * 0.045 : 0;
      const deformation = 1 + ripple + (working + bass * 0.13 + sample * (0.48 + mids * 0.2) + frequency * 0.15) * calm;
      const x = (point.x * cs + point.z * sn) * deformation;
      const z = (point.z * cs - point.x * sn) * deformation;
      const perspective = 3.8 / (3.8 - z);
      const size = Math.max(0.7, (0.7 + (z + 1) * 0.45 + frequency) * width / 420);
      ctx.globalAlpha = Math.min(1, (z < 0 ? 0.14 : 0.6) + energy * 0.2 + frequency * 0.3);
      ctx.fillStyle = point.color;
      ctx.fillRect(width / 2 + x * radius * perspective - size / 2, width / 2 + point.y * deformation * radius * perspective - size / 2, size, size);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    canvas.dataset.outputMeasured = String(features.measuredOutput);
  };
  frame = requestAnimationFrame(render);
  return () => { cancelAnimationFrame(frame); observer.disconnect(); };
}
