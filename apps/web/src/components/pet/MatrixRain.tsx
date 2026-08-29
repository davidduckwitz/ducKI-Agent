/**
 * Matrix rain
 *
 * The ambient full-window effect the "matrix" pet renders instead of a creature: green glyphs
 * falling down a transparent, click-through canvas. Host-rendered (no iframe), so it composites
 * transparently over the app. Runs unconditionally like every other pet's CSS animation - none of
 * them pause for prefers-reduced-motion, and this one used to: it drew exactly one static frame
 * and never another, and that frame's drops start off-screen (see `size()`), so on any machine
 * with that OS/browser flag set the canvas stayed blank - it looked like the effect was simply gone.
 */

import { useEffect, useRef } from "react";

const GLYPHS = "アカサタナハマヤラワ0123456789ABCDEFabcdef$#@%&*+=<>{}".split("");

/** Glyphs that swarm the cursor when "Cursor folgen" is on - each orbits its own spot around the
 *  pointer and eases toward it independently, so the cluster trails behind with a organic lag
 *  instead of snapping to the mouse like a single rigid shape. */
const SWARM_SIZE = 14;

interface SwarmPoint {
  x: number;
  y: number;
  angle: number;
  radius: number;
  spin: number;
  ease: number;
}

export function MatrixRain({
  opacity = 1,
  color = "#00ff70",
  speed = 1,
  followCursor = false,
}: {
  opacity?: number;
  color?: string;
  speed?: number;
  followCursor?: boolean;
}) {
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

    // Cursor state - kept in refs (not React state) so mousemove never triggers a re-render.
    const mouse = { x: -9999, y: -9999, active: false };
    const onMouseMove = (event: MouseEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      // On first activation, snap the swarm straight to the pointer instead of letting it ease
      // in from its off-screen initial position - that would otherwise look like the glyphs
      // flying in from a corner the first time the mouse moves.
      if (!mouse.active) for (const point of swarm) { point.x = mouse.x; point.y = mouse.y; }
      mouse.active = true;
    };
    if (followCursor) window.addEventListener("mousemove", onMouseMove);

    const swarm: SwarmPoint[] = new Array(SWARM_SIZE).fill(0).map((_, i) => ({
      x: -9999,
      y: -9999,
      angle: (i / SWARM_SIZE) * Math.PI * 2,
      radius: 18 + Math.random() * 26,
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.5),
      ease: 0.02 + Math.random() * 0.05,
    }));

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
        drops[i] = (drops[i] ?? 0) + 0.6 * speed;
      }

      if (followCursor && mouse.active) {
        for (const point of swarm) {
          point.angle += point.spin * 0.02;
          const targetX = mouse.x + Math.cos(point.angle) * point.radius;
          const targetY = mouse.y + Math.sin(point.angle) * point.radius;
          // Each point has its own ease factor, so the swarm drifts toward the pointer at
          // slightly different rates instead of moving as one rigid, snapped-on shape.
          point.x += (targetX - point.x) * point.ease;
          point.y += (targetY - point.y) * point.ease;

          const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string;
          ctx.fillStyle = "#d6ffe4";
          ctx.fillText(ch, point.x, point.y);
          ctx.fillStyle = color;
          ctx.fillText(ch, point.x, point.y - font * 0.4);
        }
      }
    };

    const step = () => {
      raf = requestAnimationFrame(step);
      draw();
    };

    size();
    step();

    window.addEventListener("resize", size);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      if (followCursor) window.removeEventListener("mousemove", onMouseMove);
    };
  }, [color, speed, followCursor]);

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
