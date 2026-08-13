/**
 * Matrix rain
 *
 * The ambient full-window effect the "matrix" pet renders instead of a creature: green glyphs
 * falling down a transparent, click-through canvas. Host-rendered (no iframe), so it composites
 * transparently over the app. Respects prefers-reduced-motion by drawing a single static frame.
 */

import { useEffect, useRef } from "react";

const GLYPHS = "アカサタナハマヤラワ0123456789ABCDEFabcdef$#@%&*+=<>{}".split("");

export function MatrixRain({ opacity = 1, color = "#00ff70" }: { opacity?: number; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let drops: number[] = [];
    let font = 16;

    const size = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      font = 16;
      const cols = Math.ceil(canvas.width / font);
      drops = new Array(cols).fill(0).map(() => Math.random() * -50);
    };

    const draw = () => {
      // Fade existing glyphs toward TRANSPARENT (not black) so the app stays fully visible
      // behind the rain. `destination-out` lowers the alpha of what's already painted each frame,
      // producing the trailing tails without ever laying down an opaque veil over the page.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 0.09)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";

      ctx.font = `${font}px monospace`;
      for (let i = 0; i < drops.length; i++) {
        const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string;
        const x = i * font;
        const y = (drops[i] ?? 0) * font;
        // Bright leading glyph, coloured glyph just behind it.
        ctx.fillStyle = "#d6ffe4";
        ctx.fillText(ch, x, y);
        ctx.fillStyle = color;
        ctx.fillText(ch, x, y - font);
        if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
        drops[i] = (drops[i] ?? 0) + 0.6;
      }
    };

    const step = () => {
      raf = requestAnimationFrame(step);
      draw();
    };

    size();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) draw();
    else step();

    window.addEventListener("resize", size);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, [color]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 45,
        // Keep the rain a translucent ambient layer so the app stays readable underneath.
        // The Character "opacity" slider tunes it further (0.2–1 → ~0.11–0.55).
        opacity: Math.min(1, Math.max(0, opacity)) * 0.55,
      }}
    />
  );
}
